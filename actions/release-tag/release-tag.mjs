/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Tag the commit that set `package.json`'s version with `v<version>`, and push
 * that one tag to the checkout's remote.
 *
 * The commit is the one on the first-parent history of `HEAD` whose parent
 * declared a different version: the squash-merged Version Packages pull
 * request. A later push to `main` that leaves the version alone finds the same
 * commit, so the tag never lands on whatever happened to be `HEAD` when the job
 * ran.
 *
 * A tag that already exists is left alone, wherever it points. A remote that
 * cannot be read fails the run rather than reading as "untagged", because
 * pushing the tag is the step a tag-triggered publish starts from.
 *
 * Push credentials are the checkout's: the release job checks out with the
 * bot's token so the push reaches the forge as the bot.
 * @module
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pendingChangesets } from "../version-pr/version-pr.mjs";

/** A finding, in the form an error matcher already reads. */
export function format({ file, line, column, severity = "error", message }) {
    const at = [file, line, column].filter((part) => part != null).join(":");
    return `${at}: ${severity}: ${message}`;
}

/** A failure that ends the run with one finding. */
export class Finding extends Error {
    constructor(file, message) {
        super(message);
        this.file = file;
    }
}

/**
 * The tag for a version, or a finding when the version is not one npm and
 * this workflow agree on: `X.Y.Z` with no leading zeros and an optional
 * prerelease suffix. Build metadata is refused, because npm ignores it and two
 * versions differing only there would want one tag.
 *
 * @param {unknown} version the version package.json declares
 * @returns {string} `v<version>`
 */
export function versionTag(version) {
    const number = "(0|[1-9][0-9]*)";
    const pattern = new RegExp(`^${number}\\.${number}\\.${number}(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$`);
    if (typeof version !== "string" || !pattern.test(version)) {
        throw new Finding(
            "package.json",
            `version ${JSON.stringify(version)} is not X.Y.Z with an optional prerelease; refusing to tag it`,
        );
    }
    return `v${version}`;
}

/**
 * The commit a tag names, from `git ls-remote` output: the peeled `^{}` line
 * of an annotated tag, otherwise the tag's own line.
 *
 * @param {string} listing the output of `git ls-remote --tags <remote> <ref>`
 * @param {string} tag the tag
 * @returns {string | undefined}
 */
export function taggedCommit(listing, tag) {
    const lines = listing.split("\n").map((line) => line.trim().split(/\s+/));
    const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
    const direct = lines.find(([, ref]) => ref === `refs/tags/${tag}`);
    return (peeled ?? direct)?.[0];
}

/**
 * Run git in `cwd`. A non-zero exit throws a finding unless its status is in
 * `allow`.
 *
 * @returns {{status: number, stdout: string}}
 */
function git(cwd, args, { allow = [], inherit = false } = {}) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
    if (result.error) throw new Finding("git", `could not run git: ${result.error.message}`);
    if (result.status !== 0 && !allow.includes(result.status)) {
        const why = inherit ? "see the output above" : (result.stderr || result.stdout).trim();
        throw new Finding("git", `\`git ${args.join(" ")}\` exited ${result.status}: ${why}`);
    }
    return { status: result.status, stdout: inherit ? "" : result.stdout.trim() };
}

/** The version `package.json` declares at a commit, or `undefined`. */
function versionAt(cwd, commit) {
    const shown = git(cwd, ["show", `${commit}:package.json`], { allow: [128] });
    if (shown.status !== 0) return undefined;
    try {
        return JSON.parse(shown.stdout).version;
    } catch {
        return undefined;
    }
}

/**
 * The commit on the first-parent history of `HEAD` that set `package.json`'s
 * version to `version`: the newest commit touching `package.json` whose parent
 * declared something else.
 *
 * @param {string} cwd the repository
 * @param {string} version the version `HEAD` declares
 * @returns {string} the commit
 */
export function versionCommit(cwd, version) {
    const touching = git(cwd, ["rev-list", "--first-parent", "HEAD", "--", "package.json"]).stdout;
    for (const commit of touching.split("\n").filter(Boolean)) {
        if (versionAt(cwd, commit) !== version) break;
        const parent = git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^`], { allow: [1] }).stdout;
        if (!parent || versionAt(cwd, parent) !== version) return commit;
    }
    throw new Finding(
        "package.json",
        `no commit on the first-parent history of HEAD sets the version to ${version}; ` +
            "a shallow checkout cannot answer this, so check out with `fetch-depth: 0`",
    );
}

/** Write a step output, when the runner provides somewhere to write it. */
function output(env, name, value) {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function main(env = process.env, cwd = process.cwd()) {
    const pending = pendingChangesets(cwd);
    if (pending.length) {
        throw new Finding(
            pending[0],
            `${pending.length} changeset(s) are pending; a tree that has not been versioned is never tagged`,
        );
    }

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    } catch (error) {
        throw new Finding("package.json", `cannot be read: ${error.message}`);
    }
    const version = manifest.version;
    const tag = versionTag(version);
    const commit = versionCommit(cwd, version);
    output(env, "version", version);
    output(env, "tag", tag);
    output(env, "commit", commit);

    // `--exit-code` has three outcomes: 0 the tag exists, 2 it does not, and
    // anything else means the remote could not be read. Only 2 may tag.
    const listing = git(cwd, ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
        allow: [2],
    });
    if (listing.status === 0) {
        const at = taggedCommit(listing.stdout, tag);
        if (at === commit) {
            console.log(`release-tag: ${tag} already names the version commit ${commit.slice(0, 7)}; nothing to do.`);
        } else {
            console.log(
                format({
                    file: "package.json",
                    severity: "warning",
                    message: `${tag} already exists at ${at ?? "an unknown commit"}, not at the version commit ${commit}; it is left where it is`,
                }),
            );
        }
        output(env, "pushed", "false");
        return;
    }

    git(cwd, ["push", "origin", `${commit}:refs/tags/${tag}`], { inherit: true });
    console.log(`release-tag: pushed ${tag} at ${commit.slice(0, 7)}.`);
    output(env, "pushed", "true");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try {
        await main();
    } catch (error) {
        if (!(error instanceof Finding)) throw error;
        console.error(format({ file: error.file, message: error.message }));
        process.exit(1);
    }
}
