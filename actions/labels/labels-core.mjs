/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The registry and sync logic of the labels action, free of any dependency so
 * it can be exercised without installing the YAML parser.
 *
 * The labels are an organisation's, on Gitea. Gitea addresses a label by numeric
 * id; a request that names a label rather than its id answers success on a
 * delete and removes nothing, so every change is confirmed by reading the
 * labels back.
 * @module
 */

import { readAll, send } from "../lib/forge.mjs";

/** The longest description Gitea accepts. */
export const MAX_DESCRIPTION = 255;

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
 * Every label the organisation currently has.
 *
 * @param {ReturnType<import("../lib/forge.mjs").forgeOf>} forge
 * @param {string} org the organisation's name
 * @returns {Promise<Map<string, {id: number | undefined, name: string, color: string, description: string, exclusive: boolean}>>}
 */
export async function currentLabels(forge, org, token) {
    const out = new Map();
    for (const label of await readAll(forge, `/orgs/${org}/labels`, token)) {
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
export function differs(a, b) {
    return (
        a.color !== b.color ||
        a.description !== b.description ||
        a.exclusive !== b.exclusive
    );
}

/** What a sync would create, update and delete. */
export function diff(registry, current) {
    const wanted = [...registry.values()];
    return {
        toCreate: wanted.filter((l) => !current.has(l.name)),
        toUpdate: wanted.filter(
            (l) => current.has(l.name) && differs(current.get(l.name), l),
        ),
        toDelete: [...current.values()].filter((l) => !registry.has(l.name)),
    };
}

/** The path that addresses an existing label. */
function addressOf(org, label) {
    if (label.id == null) {
        throw new Error(`label "${label.name}" came back without an id, so it cannot be addressed`);
    }
    return `/orgs/${org}/labels/${label.id}`;
}

/**
 * Make the organisation's labels match the registry, then read them back.
 *
 * @returns {Promise<{created: number, updated: number, deleted: number, remaining: string[]}>}
 *   `remaining` names every label the forge still reports differently from the
 *   registry after the changes; a request the forge answered with success but
 *   did not carry out appears there
 */
export async function sync(forge, org, token, registry, current) {
    const { toCreate, toUpdate, toDelete } = diff(registry, current);
    const fields = (label) => ({
        name: label.name,
        color: label.color,
        description: label.description,
        exclusive: label.exclusive,
    });
    for (const label of toCreate) {
        await send(forge, "POST", `/orgs/${org}/labels`, token, fields(label));
    }
    for (const label of toUpdate) {
        await send(forge, "PATCH", addressOf(org, current.get(label.name)), token, fields(label));
    }
    for (const label of toDelete) {
        await send(forge, "DELETE", addressOf(org, label), token);
    }
    const after = diff(registry, await currentLabels(forge, org, token));
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
