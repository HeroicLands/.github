/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The registry and sync logic of the labels action, free of any dependency so
 * it can be exercised without installing the YAML parser.
 *
 * The two forges address a label differently. GitHub addresses it by name and
 * renames it with `new_name`. Gitea addresses it by numeric id and renames it
 * with `name`; a request that names a label rather than its id answers success
 * on a delete and removes nothing, so every change is confirmed by reading the
 * labels back.
 * @module
 */

import { readAll, send } from "../lib/forge.mjs";

/** The longest description either forge accepts. */
export const MAX_DESCRIPTION = 100;

/** Where a literal sits in a text, so a finding about it can be opened. */
export function positionOf(text, needle) {
    const at = text.indexOf(needle);
    if (at === -1) return {};
    const before = text.slice(0, at);
    return {
        line: before.split("\n").length,
        column: at - before.lastIndexOf("\n"),
    };
}

/**
 * The registry, validated.
 *
 * @param {unknown} list the parsed registry file
 * @param {string} raw the file's text, for locating findings
 * @param {string} file the file's path, for findings
 * @returns {{registry: Map<string, {name: string, color: string, description: string, exclusive: boolean}>,
 *   findings: {file: string, line?: number, column?: number, message: string}[]}}
 */
export function buildRegistry(list, raw, file) {
    const findings = [];
    const registry = new Map();
    if (!Array.isArray(list)) {
        return { registry, findings: [{ file, message: "must be a list of labels" }] };
    }
    for (const entry of list) {
        const at = { file, ...positionOf(raw, entry?.name ?? "") };
        if (!entry?.name || !entry?.color) {
            findings.push({
                ...at,
                message: `every label needs a name and a color: ${JSON.stringify(entry)}`,
            });
            continue;
        }
        const description = entry.description ?? "";
        if (description.length > MAX_DESCRIPTION) {
            findings.push({
                ...at,
                message:
                    `label "${entry.name}" description is ` +
                    `${description.length} chars, over the ` +
                    `${MAX_DESCRIPTION}-char limit`,
            });
            continue;
        }
        if (entry.exclusive !== undefined && typeof entry.exclusive !== "boolean") {
            findings.push({
                ...at,
                message: `label "${entry.name}" exclusive must be true or false`,
            });
            continue;
        }
        if (registry.has(entry.name)) {
            findings.push({ ...at, message: `label "${entry.name}" is declared twice` });
            continue;
        }
        registry.set(entry.name, {
            name: entry.name,
            color: String(entry.color).replace(/^#/, "").toLowerCase(),
            description,
            exclusive: entry.exclusive === true,
        });
    }
    return { registry, findings };
}

/**
 * Every label the repository currently has.
 *
 * @param {ReturnType<import("../lib/forge.mjs").forgeOf>} forge
 * @returns {Promise<Map<string, {id: number | undefined, name: string, color: string, description: string, exclusive: boolean}>>}
 */
export async function currentLabels(forge, repo, token) {
    const out = new Map();
    for (const label of await readAll(forge, `/repos/${repo}/labels`, token)) {
        out.set(label.name, {
            id: label.id,
            name: label.name,
            color: String(label.color).replace(/^#/, "").toLowerCase(),
            description: label.description ?? "",
            exclusive: label.exclusive === true,
        });
    }
    return out;
}

/** Whether the two differ in anything the forge stores. */
export function differs(forge, a, b) {
    return (
        a.color !== b.color ||
        a.description !== b.description ||
        (!forge.github && a.exclusive !== b.exclusive)
    );
}

/** What a sync would create, update and delete. */
export function diff(forge, registry, current) {
    const wanted = [...registry.values()];
    return {
        toCreate: wanted.filter((l) => !current.has(l.name)),
        toUpdate: wanted.filter(
            (l) => current.has(l.name) && differs(forge, current.get(l.name), l),
        ),
        toDelete: [...current.values()].filter((l) => !registry.has(l.name)),
    };
}

/** The path that addresses an existing label on this forge. */
function addressOf(forge, repo, label) {
    if (forge.github) return `/repos/${repo}/labels/${encodeURIComponent(label.name)}`;
    if (label.id == null) {
        throw new Error(`label "${label.name}" came back without an id, so it cannot be addressed`);
    }
    return `/repos/${repo}/labels/${label.id}`;
}

/**
 * Make the forge's labels match the registry, then read them back.
 *
 * @returns {Promise<{created: number, updated: number, deleted: number, remaining: string[]}>}
 *   `remaining` names every label the forge still reports differently from the
 *   registry after the changes; a request the forge answered with success but
 *   did not carry out appears there
 */
export async function sync(forge, repo, token, registry, current) {
    const { toCreate, toUpdate, toDelete } = diff(forge, registry, current);
    for (const label of toCreate) {
        await send(forge, "POST", `/repos/${repo}/labels`, token, {
            name: label.name,
            color: label.color,
            description: label.description,
            ...(forge.github ? {} : { exclusive: label.exclusive }),
        });
    }
    for (const label of toUpdate) {
        await send(forge, "PATCH", addressOf(forge, repo, current.get(label.name)), token, {
            [forge.github ? "new_name" : "name"]: label.name,
            color: label.color,
            description: label.description,
            ...(forge.github ? {} : { exclusive: label.exclusive }),
        });
    }
    for (const label of toDelete) {
        await send(forge, "DELETE", addressOf(forge, repo, label), token);
    }
    const after = diff(forge, registry, await currentLabels(forge, repo, token));
    return {
        created: toCreate.length,
        updated: toUpdate.length,
        deleted: toDelete.length,
        remaining: [
            ...after.toCreate.map((l) => `+ ${l.name}`),
            ...after.toUpdate.map((l) => `~ ${l.name}`),
            ...after.toDelete.map((l) => `- ${l.name}`),
        ],
    };
}
