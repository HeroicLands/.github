/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * **A repository's labels, from its own `.github/labels.yml`.**
 *
 * Every HeroicLands repository wants the same label set and the same rule about
 * it, and each was carrying its own copy of the script that applied them —
 * `sync-labels.mjs`, 95% identical across three repositories and drifted in all
 * three. Labels are neither a content tree nor a Foundry package, so neither
 * build toolchain is the right home; what they are is repository governance,
 * which is CI-shaped. Hence an action.
 *
 * **The registry is a closed set.** A label the file declares is created or
 * corrected; a label GitHub has and the file does not is *deleted*. That is the
 * point of a registry rather than a starting point: labels accumulate from
 * templates, integrations and typos, and a set nobody prunes stops meaning
 * anything. Deletion removes the label from issues that carry it, which is why
 * `check` exists and why the workflow runs it on every pull request touching
 * the file — the change is reviewed before it is applied.
 *
 * `check` never writes. It validates the file and reports what a sync would do,
 * so a pull request shows the consequence of its own diff.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

/** GitHub's own limit; a longer description is rejected by the API. */
const MAX_DESCRIPTION = 100;

const MODE = process.env.LABELS_MODE ?? "check";
const REGISTRY = process.env.LABELS_REGISTRY ?? ".github/labels.yml";
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;

const API = "https://api.github.com";
const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** A finding, in the form an error matcher already reads. */
function report({ file, line, column, severity = "error", message }) {
    const at = [file, line, column].filter((p) => p != null).join(":");
    console.error(`${at}: ${severity}: ${message}`);
}

/** Where a literal sits in a text, so a finding about it can be opened. */
function positionOf(text, needle) {
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
 * @returns {Map<string, {name: string, color: string, description: string}>}
 */
function readRegistry() {
    const file = resolve(REGISTRY);
    const raw = readFileSync(file, "utf8");
    const list = parse(raw);

    if (!Array.isArray(list)) {
        report({ file: REGISTRY, message: "must be a list of labels" });
        process.exit(1);
    }

    let bad = 0;
    const byName = new Map();
    for (const entry of list) {
        if (!entry?.name || !entry?.color) {
            report({
                file: REGISTRY,
                ...positionOf(raw, entry?.name ?? ""),
                message: `every label needs a name and a color: ${JSON.stringify(entry)}`,
            });
            bad++;
            continue;
        }
        const description = entry.description ?? "";
        if (description.length > MAX_DESCRIPTION) {
            report({
                file: REGISTRY,
                ...positionOf(raw, entry.name),
                message:
                    `label "${entry.name}" description is ` +
                    `${description.length} chars, over GitHub's ` +
                    `${MAX_DESCRIPTION}-char limit`,
            });
            bad++;
            continue;
        }
        if (byName.has(entry.name)) {
            report({
                file: REGISTRY,
                ...positionOf(raw, entry.name),
                message: `label "${entry.name}" is declared twice`,
            });
            bad++;
            continue;
        }
        byName.set(entry.name, {
            name: entry.name,
            color: String(entry.color).replace(/^#/, "").toLowerCase(),
            description,
        });
    }

    if (bad) process.exit(1);
    return byName;
}

/** Every label the repository currently has, paged. */
async function currentLabels() {
    const out = new Map();
    for (let page = 1; ; page++) {
        const res = await fetch(
            `${API}/repos/${REPO}/labels?per_page=100&page=${page}`,
            { headers },
        );
        if (!res.ok) {
            throw new Error(
                `GET labels failed: ${res.status} ${await res.text()}`,
            );
        }
        const batch = await res.json();
        for (const label of batch) {
            out.set(label.name, {
                name: label.name,
                color: String(label.color).toLowerCase(),
                description: label.description ?? "",
            });
        }
        if (batch.length < 100) return out;
    }
}

/** @returns {boolean} Whether the two differ in anything GitHub stores. */
function differs(a, b) {
    return a.color !== b.color || a.description !== b.description;
}

async function call(method, path, body) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
        throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
}

const registry = readRegistry();

if (!REPO) {
    console.log(
        `labels: ${registry.size} label(s) declared and well-formed. ` +
            "No repository in the environment, so nothing was compared.",
    );
    process.exit(0);
}
if (!TOKEN) {
    console.log(
        `labels: ${registry.size} label(s) declared and well-formed. ` +
            "No token supplied, so GitHub's labels were not read.",
    );
    process.exit(0);
}

const current = await currentLabels();

const toCreate = [...registry.values()].filter((l) => !current.has(l.name));
const toUpdate = [...registry.values()].filter(
    (l) => current.has(l.name) && differs(current.get(l.name), l),
);
const toDelete = [...current.values()].filter((l) => !registry.has(l.name));

const plan = [
    ...toCreate.map((l) => `  + ${l.name}`),
    ...toUpdate.map((l) => `  ~ ${l.name}`),
    ...toDelete.map((l) => `  - ${l.name}`),
];

if (MODE !== "sync") {
    if (!plan.length) {
        console.log(`labels: GitHub matches ${REGISTRY} (${registry.size}).`);
        process.exit(0);
    }
    console.log(`labels: syncing ${REGISTRY} would change ${plan.length}:`);
    console.log(plan.join("\n"));
    console.log(
        "\nThe registry is a closed set, so a label marked `-` would be " +
            "deleted from the repository and from every issue carrying it.",
    );
    process.exit(0);
}

for (const label of toCreate) {
    await call("POST", `/repos/${REPO}/labels`, label);
}
for (const label of toUpdate) {
    await call(
        "PATCH",
        `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`,
        { new_name: label.name, color: label.color, description: label.description },
    );
}
for (const label of toDelete) {
    await call("DELETE", `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`);
}

console.log(
    plan.length ?
        `labels: synced — ${toCreate.length} created, ${toUpdate.length} ` +
            `updated, ${toDelete.length} deleted.`
    :   `labels: GitHub already matched ${REGISTRY} (${registry.size}).`,
);
