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
 * corrected; a label the forge has and the file does not is *deleted*. That is the
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

import { ApiError, forgeOf } from "../lib/forge.mjs";
import { buildRegistry, currentLabels, diff, sync } from "./labels-core.mjs";

const MODE = process.env.LABELS_MODE ?? "check";
const REGISTRY = process.env.LABELS_REGISTRY ?? ".github/labels.yml";
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const FORGE = forgeOf();

/** A finding, in the form an error matcher already reads. */
function report({ file, line, column, severity = "error", message }) {
    const at = [file, line, column].filter((p) => p != null).join(":");
    console.error(`${at}: ${severity}: ${message}`);
}

/** The registry, validated. */
function readRegistry() {
    const raw = readFileSync(resolve(REGISTRY), "utf8");
    const { registry, findings } = buildRegistry(parse(raw), raw, REGISTRY);
    for (const finding of findings) report(finding);
    if (findings.length) process.exit(1);
    return registry;
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
            "No token supplied, so the repository's labels were not read.",
    );
    process.exit(0);
}

try {
    const current = await currentLabels(FORGE, REPO, TOKEN);
    const { toCreate, toUpdate, toDelete } = diff(FORGE, registry, current);

    const plan = [
        ...toCreate.map((l) => `  + ${l.name}`),
        ...toUpdate.map((l) => `  ~ ${l.name}`),
        ...toDelete.map((l) => `  - ${l.name}`),
    ];

    if (MODE !== "sync") {
        if (!plan.length) {
            console.log(`labels: the repository matches ${REGISTRY} (${registry.size}).`);
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

    const result = await sync(FORGE, REPO, TOKEN, registry, current);
    if (result.remaining.length) {
        report({
            file: REGISTRY,
            message:
                "the forge accepted the changes but still reports these labels " +
                `differently from the registry: ${result.remaining.join(", ")}`,
        });
        process.exit(1);
    }
    console.log(
        plan.length ?
            `labels: synced — ${result.created} created, ${result.updated} ` +
                `updated, ${result.deleted} deleted.`
        :   `labels: the repository already matched ${REGISTRY} (${registry.size}).`,
    );
} catch (error) {
    if (!(error instanceof ApiError)) throw error;
    report({ file: REGISTRY, message: error.message });
    process.exit(1);
}
