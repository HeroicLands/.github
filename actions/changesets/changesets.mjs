/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Check a pull request's changesets.
 *
 * A pull request may add one `.changeset/*.md` file for each user-visible
 * change. The check reports how many it adds, and fails only when the pull
 * request cannot be read.
 * Reports; never edits.
 * @module
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ApiError, forgeOf, readAll } from "../lib/forge.mjs";

/** A finding, in the form an error matcher already reads. */
export function format({ file, line, column, severity = "error", message }) {
    const at = [file, line, column].filter((part) => part != null).join(":");
    return `${at}: ${severity}: ${message}`;
}

/**
 * The changeset files a pull request adds.
 *
 * A changeset is a Markdown file directly under `.changeset/` other than its
 * README. A rename into the directory counts as an addition; a modification of
 * an existing changeset does not.
 *
 * @param {{filename: string, status: string, previous_filename?: string}[]} files
 *   the pull request's files, as the pull request files endpoint lists them
 * @returns {string[]} the added changeset paths, in listing order
 */
export function addedChangesets(files) {
    const isChangeset = (path) =>
        /^\.changeset\/[^/]+\.md$/.test(path ?? "") &&
        path.toLowerCase() !== ".changeset/readme.md";
    return files
        .filter(
            (file) =>
                isChangeset(file.filename) &&
                (file.status === "added" ||
                    (file.status === "renamed" &&
                        !isChangeset(file.previous_filename))),
        )
        .map((file) => file.filename);
}

/** Every page of a list endpoint. A failed read exits: a partial list is not a check. */
async function list(path, token, address) {
    try {
        return await readAll(forgeOf(), path, token);
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        console.error(
            format({
                file: address,
                message:
                    `could not be read: ${error.status} ${error.body}. ` +
                    "The token needs `contents: read` and `pull-requests: read`",
            }),
        );
        process.exit(1);
    }
}

/** The pull request this run is about, from the event that triggered it. */
function pullRequest(eventPath) {
    if (!eventPath) {
        console.error(
            format({
                file: "GITHUB_EVENT_PATH",
                message:
                    "no event payload in the environment. This action reads the " +
                    "pull request that triggered it, so it belongs on a " +
                    "`pull_request` workflow",
            }),
        );
        process.exit(1);
    }
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    if (!event.pull_request) {
        console.error(
            format({
                file: process.env.GITHUB_EVENT_NAME ?? "event",
                message:
                    "not a pull request event. Trigger this action on " +
                    "`pull_request`",
            }),
        );
        process.exit(1);
    }
    return event.pull_request;
}

async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        console.error(
            format({
                file: "token",
                message:
                    "no token supplied, so the pull request cannot be read. Pass " +
                    "`token: ${{ github.token }}`",
            }),
        );
        process.exit(1);
    }
    const pr = pullRequest(process.env.GITHUB_EVENT_PATH);

    const files = await list(
        `/repos/${repo}/pulls/${pr.number}/files`,
        token,
        `pull/${pr.number}/files`,
    );
    const added = addedChangesets(files);
    console.log(
        `changesets: pull request #${pr.number} adds ${added.length} changeset(s).`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
