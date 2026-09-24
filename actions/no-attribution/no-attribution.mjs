/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Check PR titles, bodies and commit messages for bounded assistant credit.
 * Findings use original address:line:column positions. Repository files,
 * issues, comments and Git author/committer identities are outside this check.
 * @module
 */

import { readFileSync } from "node:fs";
import { attribution } from "./attribution.mjs";

const API = "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;

/** A finding, in the form an error matcher already reads. */
function report({ file, line, column, severity = "error", message }) {
    const at = [file, line, column].filter((part) => part != null).join(":");
    console.error(`${at}: ${severity}: ${message}`);
}

/**
 * Every attributing line in one subject.
 *
 * @param {string} address the subject's address, used as the finding's locator
 * @param {string | null | undefined} text the subject itself; an empty body is
 *   ordinary and yields nothing
 * @returns {{address: string, line: number, column: number, kind: string, text: string}[]}
 */
function scan(address, text) {
    const findings = [];
    for (const [index, line] of (text ?? "").split(/\r?\n/).entries()) {
        const match = attribution(line);
        if (match) {
            findings.push({
                address,
                line: index + 1,
                ...match,
                text: line.slice(match.column - 1).trim(),
            });
        }
    }
    return findings;
}

/** The pull request this run is about, from the event that triggered it. */
function pullRequest() {
    if (!EVENT_PATH) {
        report({
            file: "GITHUB_EVENT_PATH",
            message:
                "no event payload in the environment. This action reads the " +
                "pull request that triggered it, so it belongs on a " +
                "`pull_request` workflow",
        });
        process.exit(1);
    }
    const event = JSON.parse(readFileSync(EVENT_PATH, "utf8"));
    if (!event.pull_request) {
        report({
            file: process.env.GITHUB_EVENT_NAME ?? "event",
            message:
                "not a pull request event. Trigger this action on " +
                "`pull_request`, whose payload carries the title, body and " +
                "commits it examines",
        });
        process.exit(1);
    }
    return event.pull_request;
}

/**
 * The pull request's commit messages, paginated.
 *
 * A failed read exits rather than reporting success on the subjects it did
 * manage to read: the commit messages are the ones that survive the merge, so
 * a run that skipped them has not checked the thing that matters most.
 */
async function commitMessages(number) {
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${TOKEN}`,
    };
    const commits = [];
    for (let page = 1; ; page++) {
        const res = await fetch(
            `${API}/repos/${REPO}/pulls/${number}/commits?per_page=100&page=${page}`,
            { headers },
        );
        if (!res.ok) {
            report({
                file: `pull/${number}/commits`,
                message:
                    `could not be read: ${res.status} ${await res.text()}. ` +
                    "The token needs `contents: read` and `pull-requests: read`",
            });
            process.exit(1);
        }
        const batch = await res.json();
        for (const entry of batch) {
            commits.push({ sha: entry.sha, message: entry.commit.message });
        }
        if (batch.length < 100) return commits;
    }
}

if (!TOKEN) {
    report({
        file: "token",
        message:
            "no token supplied, so the commit messages cannot be read. Pass " +
            "`token: ${{ github.token }}`",
    });
    process.exit(1);
}

const pr = pullRequest();
const commits = await commitMessages(pr.number);

const findings = [
    ...scan(`pull/${pr.number}/title`, pr.title),
    ...scan(`pull/${pr.number}/body`, pr.body),
    ...commits.flatMap((commit) => scan(`commit/${commit.sha}`, commit.message)),
];

if (findings.length) {
    console.error(
        `\nno-attribution: ${findings.length} attributing line(s) on ` +
            `pull request #${pr.number}:\n`,
    );
    for (const finding of findings) {
        report({
            file: finding.address,
            line: finding.line,
            column: finding.column,
            message: `${finding.kind}: ${finding.text}`,
        });
    }
    console.error(
        "\nThis project does not credit an assistant in its history. Edit the " +
            "pull request's title and body. For a pushed commit, consult the " +
            "maintainer about correcting its message without rewriting shared history.\n",
    );
    process.exit(1);
}

console.log(
    `no-attribution: pull request #${pr.number} is clean — title, body and ` +
        `${commits.length} commit message(s) carry no attribution.`,
);
