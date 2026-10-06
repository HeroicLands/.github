/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Check a pull request's changesets.
 *
 * An ordinary pull request may add at most one `.changeset/*.md` file. The
 * Version Packages pull request — the one whose head is the release branch —
 * passes only when an approving review names its current head commit, so the
 * generated CHANGELOG section has been read after its last regeneration.
 * Reports; never edits.
 * @module
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";

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

/**
 * Whether the release pull request has been approved on its current head.
 *
 * Each reviewer's latest decisive review (approved, changes requested or
 * dismissed) is the one that counts, as GitHub counts it. An approval passes
 * only when it names the head commit: the bot rebuilds the branch on every
 * merge to `main`, and an approval of an earlier commit approved a release
 * note that no longer exists.
 *
 * @param {{state: string, commit_id: string, user?: {login: string}}[]} reviews
 *   the pull request's reviews, oldest first
 * @param {string} head the head commit's SHA
 * @returns {{approved: boolean, stale: string[]}} whether an approval names the
 *   head, and the reviewers whose approval names an earlier commit
 */
export function releaseReview(reviews, head) {
    const latest = new Map();
    for (const review of reviews) {
        if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
            latest.set(review.user?.login ?? "", review);
        }
    }
    const approvals = [...latest.values()].filter((r) => r.state === "APPROVED");
    return {
        approved: approvals.some((r) => r.commit_id === head),
        stale: approvals
            .filter((r) => r.commit_id !== head)
            .map((r) => r.user?.login ?? "a reviewer"),
    };
}

/** Every page of a list endpoint. A failed read exits: a partial list is not a check. */
async function list(path, token, address) {
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
    };
    const items = [];
    for (let page = 1; ; page++) {
        const res = await fetch(`${API}${path}?per_page=100&page=${page}`, { headers });
        if (!res.ok) {
            console.error(
                format({
                    file: address,
                    message:
                        `could not be read: ${res.status} ${await res.text()}. ` +
                        "The token needs `contents: read` and `pull-requests: read`",
                }),
            );
            process.exit(1);
        }
        const batch = await res.json();
        items.push(...batch);
        if (batch.length < 100) return items;
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
                    "`pull_request` or `pull_request_review` workflow",
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
                    "`pull_request` and `pull_request_review`",
            }),
        );
        process.exit(1);
    }
    return event.pull_request;
}

async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const releaseBranch = process.env.RELEASE_BRANCH || "changeset-release/main";
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

    if (pr.head.ref === releaseBranch) {
        const reviews = await list(
            `/repos/${repo}/pulls/${pr.number}/reviews`,
            token,
            `pull/${pr.number}/reviews`,
        );
        const { approved, stale } = releaseReview(reviews, pr.head.sha);
        if (approved) {
            console.log(
                `changesets: release pull request #${pr.number} is approved on ` +
                    `its head commit ${pr.head.sha.slice(0, 7)}.`,
            );
            return;
        }
        const why = stale.length
            ? `the approval by ${stale.join(", ")} names an earlier commit, and ` +
              "the release note has been regenerated since"
            : "no approving review names its head commit";
        console.error(
            format({
                file: `pull/${pr.number}/reviews`,
                message:
                    `release pull request is not reviewed on ${pr.head.sha.slice(0, 7)}: ${why}. ` +
                    "Read the generated CHANGELOG section as one release note — merge " +
                    "bullets that describe one change, drop what a later change " +
                    "superseded, regroup — commit any edit to this branch, then approve",
            }),
        );
        process.exit(1);
    }

    const files = await list(
        `/repos/${repo}/pulls/${pr.number}/files`,
        token,
        `pull/${pr.number}/files`,
    );
    const added = addedChangesets(files);
    if (added.length > 1) {
        for (const path of added) {
            console.error(
                format({
                    file: path,
                    message:
                        `one of ${added.length} changesets this pull request adds. ` +
                        "A pull request carries at most one: fold them into a single " +
                        "entry that describes the change as a reader meets it",
                }),
            );
        }
        process.exit(1);
    }
    console.log(
        `changesets: pull request #${pr.number} adds ${added.length} changeset(s).`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
