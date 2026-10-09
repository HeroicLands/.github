/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Open or update the Version Packages pull request on the forge this job runs
 * on, and schedule its squash merge.
 *
 * With changesets pending, the repository's version script runs on the release
 * branch, whatever it produced becomes one commit on the checked-out commit,
 * that commit is force-pushed with the bot's token, and the pull request is
 * opened or updated and scheduled to merge when its checks succeed. With none
 * pending it reports `has-changesets=false` and touches nothing.
 *
 * The API base is `GITHUB_API_URL`, which both Gitea and GitHub set. The
 * pull request and merge endpoints are Gitea's.
 * @module
 */

import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    chmodSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
 * The pending changesets in a checkout: Markdown files directly under
 * `.changeset/` other than its README.
 *
 * @param {string} root the repository root
 * @returns {string[]} their paths relative to the root, sorted
 */
export function pendingChangesets(root) {
    let names;
    try {
        names = readdirSync(join(root, ".changeset"));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    return names
        .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
        .sort()
        .map((name) => `.changeset/${name}`);
}

/**
 * The newest version's section of a changelog: every line between the first
 * `## ` heading and the next, the heading itself excluded. The release step
 * extracts the release notes by the same rule.
 *
 * @param {string} text the changelog
 * @returns {string} the section, trimmed
 */
export function changelogSection(text) {
    const out = [];
    let headings = 0;
    for (const line of text.split("\n")) {
        if (line.startsWith("## ")) {
            headings++;
            if (headings >= 2) break;
            continue;
        }
        if (headings === 1) out.push(line);
    }
    return out.join("\n").trim();
}

/**
 * The pull request body: one sentence naming the version, then its changelog
 * section.
 *
 * @param {string} version the version the branch carries
 * @param {string} section the changelog section, possibly empty
 * @returns {string}
 */
export function pullBody(version, section) {
    const lead = `Merging this pull request releases v${version}.`;
    return section ? `${lead}\n\n${section}\n` : `${lead}\n`;
}

/**
 * The page number a `Link` header names as `rel="next"`, or `undefined` on the
 * last page. Only the number is taken: Gitea writes the link against its
 * public address, which need not be the address this job reaches it by.
 *
 * @param {string | null} link the response's `Link` header
 * @returns {number | undefined}
 */
export function nextPage(link) {
    for (const part of (link ?? "").split(",")) {
        const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
        if (match) {
            const page = Number(new URL(match[1]).searchParams.get("page"));
            return Number.isInteger(page) && page > 0 ? page : undefined;
        }
    }
    return undefined;
}

/**
 * The open pull request from `branch` into `base` in `repo`, if any. A pull
 * request from a fork's branch of the same name is not it.
 *
 * @param {object[]} pulls open pull requests, as the list endpoint returns them
 * @param {{repo: string, branch: string, base: string}} want
 * @returns {object | undefined}
 */
export function findPull(pulls, { repo, branch, base }) {
    const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
    return pulls.find(
        (pr) =>
            pr.head?.ref === branch &&
            pr.base?.ref === base &&
            (pr.head?.repo?.full_name == null || same(pr.head.repo.full_name, repo)),
    );
}

/**
 * Configuration overrides that drop every `http.*.extraheader` a checkout
 * persisted, so a push authenticates with the token this action is given
 * rather than with whichever token checked the tree out. An empty value resets
 * a multi-valued key.
 *
 * @param {string} listing the output of `git config --get-regexp`, one
 *   `key value` per line
 * @returns {string[]} `-c key=` pairs for the git command line
 */
export function extraHeaderResets(listing) {
    const keys = new Set();
    for (const line of listing.split("\n")) {
        const key = line.split(" ")[0];
        if (key) keys.add(key);
    }
    return [...keys].flatMap((key) => ["-c", `${key}=`]);
}

/** Write a step output, when the runner provides somewhere to write it. */
function output(name, value) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * Run git. A non-zero exit throws a finding unless its status is in `allow`.
 *
 * @returns {{status: number, stdout: string}}
 */
function git(args, { env, allow = [], inherit = false } = {}) {
    const result = spawnSync("git", args, {
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: inherit ? "inherit" : "pipe",
    });
    if (result.error) throw new Finding("git", `could not run git: ${result.error.message}`);
    if (result.status !== 0 && !allow.includes(result.status)) {
        const why = inherit ? "see the output above" : (result.stderr || result.stdout).trim();
        throw new Finding("git", `\`git ${args.join(" ")}\` exited ${result.status}: ${why}`);
    }
    return { status: result.status, stdout: inherit ? "" : result.stdout.trim() };
}

/** A client for the forge's API, rooted at `base`. */
function client(base, token) {
    return async function api(method, path, body, { accept = [] } = {}) {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                Accept: "application/json",
                Authorization: `token ${token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok && !accept.includes(res.status)) {
            throw new Finding(
                path.replace(/^\//, "").replace(/\?.*$/, ""),
                `${method} answered ${res.status}: ${text.trim() || res.statusText}`,
            );
        }
        let json;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        return { status: res.status, json, text, link: res.headers.get("link") };
    };
}

/** Every open pull request, following `Link` until there is no next page. */
async function openPulls(api, repo) {
    const pulls = [];
    for (let page = 1; page !== undefined; ) {
        const res = await api("GET", `/repos/${repo}/pulls?state=open&limit=50&page=${page}`);
        if (!Array.isArray(res.json)) {
            throw new Finding(`repos/${repo}/pulls`, `GET answered ${res.status} with no list: ${res.text}`);
        }
        pulls.push(...res.json);
        page = res.json.length ? nextPage(res.link) : undefined;
    }
    return pulls;
}

/**
 * Whether the release branch on the remote already carries this exact version
 * commit: the first commit after `base` on its first-parent line has `base` as
 * its parent and `tree` as its tree. Commits on top of it are edits made to
 * the release note, which a re-run keeps.
 */
function carriesVersion(remote, base, tree) {
    const { stdout } = git(["rev-list", "--first-parent", "--reverse", `${base}..${remote}`]);
    const first = stdout.split("\n").filter(Boolean)[0];
    if (!first) return false;
    const parent = git(["rev-parse", `${first}^`], { allow: [128] }).stdout;
    return parent === base && git(["rev-parse", `${first}^{tree}`]).stdout === tree;
}

/** Push `HEAD` to the release branch with the bot's token, never the checkout's. */
function push(branch, user, token) {
    const listing = git(["config", "--get-regexp", "^http\\..*extraheader$"], { allow: [1] }).stdout;
    const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "version-pr-"));
    const askpass = join(dir, "askpass.sh");
    try {
        writeFileSync(
            askpass,
            '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) printf \'%s\\n\' "$VERSION_PR_USER" ;;\n' +
                "  *) printf '%s\\n' \"$VERSION_PR_TOKEN\" ;;\nesac\n",
        );
        chmodSync(askpass, 0o700);
        git(
            [
                ...extraHeaderResets(listing),
                "-c",
                "credential.helper=",
                "push",
                "--force",
                "origin",
                `HEAD:refs/heads/${branch}`,
            ],
            {
                inherit: true,
                env: {
                    GIT_ASKPASS: askpass,
                    GIT_TERMINAL_PROMPT: "0",
                    VERSION_PR_USER: user,
                    VERSION_PR_TOKEN: token,
                },
            },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** A file at a commit, or `undefined` when the commit does not have it. */
function show(commit, path) {
    const result = git(["show", `${commit}:${path}`], { allow: [128] });
    return result.status === 0 ? result.stdout : undefined;
}

export async function main(env = process.env) {
    const repo = env.GITHUB_REPOSITORY;
    const base = env.BASE_BRANCH || "main";
    const branch = env.RELEASE_BRANCH || "changeset-release/main";
    const script = env.VERSION_SCRIPT || "changeset:version";
    const title = env.PR_TITLE || "chore(release): version packages";
    const message = env.COMMIT_MESSAGE || "chore(release): version packages";
    const token = env.VERSION_PR_TOKEN;

    if (!token) {
        throw new Finding(
            "token",
            "no token supplied. Pass the bot's personal access token: a push made with " +
                "the job token starts no workflow, so the pull request would never be checked",
        );
    }
    if (!env.GITHUB_API_URL || !repo) {
        throw new Finding(
            "GITHUB_API_URL",
            "the runner set no API address or repository; this action runs inside a forge's workflow",
        );
    }

    const pending = pendingChangesets(process.cwd());
    if (pending.length === 0) {
        console.log("version-pr: no changesets are pending; nothing to version.");
        output("has-changesets", "false");
        return;
    }
    console.log(`version-pr: ${pending.length} changeset(s) pending.`);

    const api = client(env.GITHUB_API_URL.replace(/\/+$/, ""), token);
    let name = env.AUTHOR_NAME;
    let email = env.AUTHOR_EMAIL;
    const me = (await api("GET", "/user")).json ?? {};
    name ||= me.login;
    email ||= me.email;
    if (!name || !email) {
        throw new Finding(
            "user",
            "the token's account has no login or email to commit as. Pass `author-name` and `author-email`",
        );
    }
    const identity = {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
    };

    git(["switch", "-C", branch]);
    const baseSha = git(["rev-parse", "HEAD"]).stdout;

    // npm gives the script a shell; `changeset version` with `"commit": true`
    // commits as the identity above.
    const run = spawnSync("npm", ["run", script], {
        stdio: "inherit",
        env: { ...process.env, ...identity },
    });
    if (run.status !== 0) {
        throw new Finding(`package.json`, `\`npm run ${script}\` exited ${run.status ?? run.signal}`);
    }

    git(["add", "-A"]);
    git(["reset", "--soft", baseSha]);
    if (git(["diff", "--cached", "--quiet"], { allow: [1] }).status === 0) {
        throw new Finding(
            ".changeset/config.json",
            `${pending.length} changeset(s) are pending but \`npm run ${script}\` changed nothing. ` +
                "A `private: true` package versions nothing unless the config sets " +
                "`privatePackages.version`",
        );
    }
    git(["commit", "--quiet", "-m", message], { env: identity, inherit: true });
    const tree = git(["rev-parse", "HEAD^{tree}"]).stdout;

    const remoteRef = `refs/remotes/origin/${branch}`;
    const exists = git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { allow: [2] });
    let head = git(["rev-parse", "HEAD"]).stdout;
    let current = false;
    if (exists.status === 0) {
        git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${remoteRef}`]);
        current = carriesVersion(remoteRef, baseSha, tree);
    }
    if (current) {
        head = git(["rev-parse", remoteRef]).stdout;
        console.log(`version-pr: ${branch} already carries this version at ${head.slice(0, 7)}; not pushing.`);
    } else {
        push(branch, me.login || name, token);
        console.log(`version-pr: pushed ${head.slice(0, 7)} to ${branch}.`);
    }

    const version = JSON.parse(show(head, "package.json") ?? "{}").version;
    const body = pullBody(version, changelogSection(show(head, "CHANGELOG.md") ?? ""));

    const existing = findPull(await openPulls(api, repo), { repo, branch, base });
    let number;
    if (existing) {
        number = existing.number;
        if (existing.title !== title || (existing.body ?? "") !== body) {
            await api("PATCH", `/repos/${repo}/pulls/${number}`, { title, body });
            console.log(`version-pr: updated pull request #${number}.`);
        } else {
            console.log(`version-pr: pull request #${number} is current.`);
        }
    } else {
        number = (await api("POST", `/repos/${repo}/pulls`, { head: branch, base, title, body })).json?.number;
        if (!number) throw new Finding(`repos/${repo}/pulls`, "POST answered with no pull request number");
        console.log(`version-pr: opened pull request #${number}.`);
    }

    const merge = await api(
        "POST",
        `/repos/${repo}/pulls/${number}/merge`,
        { Do: "squash", merge_when_checks_succeed: true },
        { accept: [405, 409] },
    );
    if (merge.status === 405 || merge.status === 409) {
        if (!/already scheduled/i.test(merge.text)) {
            throw new Finding(
                `repos/${repo}/pulls/${number}/merge`,
                `POST answered ${merge.status}: ${merge.text.trim()}`,
            );
        }
        console.log(`version-pr: the squash merge of #${number} was already scheduled.`);
    } else {
        console.log(`version-pr: scheduled the squash merge of #${number} for when its checks succeed.`);
    }

    output("has-changesets", "true");
    output("pr-number", String(number));
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
