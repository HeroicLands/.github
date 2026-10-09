/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Publish the GitHub Release for a tag the push mirror delivers.
 *
 * The job runs on another forge, which owns the tag; the mirror is the only
 * writer of GitHub's refs. So this waits until GitHub has the tag at the
 * commit it names here, then makes the Release as a draft, uploads and checks
 * every asset, and publishes it with `prerelease` and `make_latest` stated
 * explicitly. A draft is invisible to `releases/latest`, so no installed copy
 * can fetch a release whose assets are still uploading. A published release
 * is never edited: one that already matches is a success, one that differs is
 * a failure.
 * @module
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, globSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

/** GitHub's limit on a release body, in characters. */
export const BODY_LIMIT = 125000;

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
 * The GitHub repository `package.json#repository` names. Only
 * `[git+]https://github.com/<owner>/<repo>[.git]` is accepted: the manifest's
 * release addresses derive from the same field, so a release made anywhere
 * else leaves every installed copy pointing at nothing.
 *
 * @param {string | {url?: string} | undefined} repository
 * @returns {{owner: string, repo: string, url: string}}
 */
export function githubRepository(repository) {
    const raw = typeof repository === "string" ? repository : (repository?.url ?? "");
    const url = String(raw).trim().replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url);
    if (!match) {
        throw new Finding(
            "package.json",
            `repository.url is ${JSON.stringify(raw)}, not https://github.com/<owner>/<repo>. ` +
                "The manifest's release addresses derive from it, so the release must be made there",
        );
    }
    return { owner: match[1], repo: match[2], url };
}

/** The content type an asset is uploaded with. */
export function contentType(name) {
    return (
        { ".zip": "application/zip", ".json": "application/json", ".pdf": "application/pdf" }[
            extname(name).toLowerCase()
        ] ?? "application/octet-stream"
    );
}

/**
 * The files to attach: every match of each newline-separated glob. A glob
 * matching nothing is not an error; no file at all, an empty file, two files
 * with one name, or a name GitHub would rewrite is.
 *
 * @param {string} patterns newline-separated globs, relative to the working directory
 * @returns {{path: string, name: string, size: number}[]}
 */
export function assetFiles(patterns) {
    const paths = new Set();
    for (const pattern of patterns.split("\n").map((p) => p.trim()).filter(Boolean)) {
        for (const path of globSync(pattern).sort()) {
            if (statSync(path).isFile()) paths.add(path);
        }
    }
    const files = [];
    const names = new Map();
    for (const path of paths) {
        const name = basename(path);
        if (names.has(name)) {
            throw new Finding(path, `has the same name as ${names.get(name)}; a release holds one asset per name`);
        }
        if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
            throw new Finding(path, "has a name GitHub rewrites on upload; use letters, digits, `.`, `_`, `+` and `-`");
        }
        const size = statSync(path).size;
        if (size === 0) throw new Finding(path, "is empty; an empty asset is never a release");
        names.set(name, path);
        files.push({ path, name, size });
    }
    if (files.length === 0) {
        throw new Finding("files", `no file matches ${JSON.stringify(patterns.trim())}; a release with no assets installs nothing`);
    }
    return files;
}

/**
 * Check every Foundry manifest among the assets against the addresses
 * `manifest.mjs` derives: `manifest` at `releases/latest/download/<this file>`,
 * `download` and `flags.metadataUrl` at `releases/download/<tag>/<an asset>`,
 * and `version` matching the tag. A JSON asset with neither `manifest` nor
 * `download` is not a manifest and is not checked.
 *
 * @param {{path: string, name: string}[]} files
 * @param {string} repoUrl `https://github.com/<owner>/<repo>`
 * @param {string} tag
 * @returns {number} how many manifests were checked
 */
export function checkManifests(files, repoUrl, tag) {
    const names = new Set(files.map((f) => f.name));
    const pinned = `${repoUrl}/releases/download/${tag}/`;
    let checked = 0;
    for (const file of files.filter((f) => extname(f.name).toLowerCase() === ".json")) {
        let json;
        try {
            json = JSON.parse(readFileSync(file.path, "utf8"));
        } catch {
            continue;
        }
        if (typeof json?.manifest !== "string" && typeof json?.download !== "string") continue;
        checked++;
        const problems = [];
        const latest = `${repoUrl}/releases/latest/download/${file.name}`;
        if (json.manifest !== latest) problems.push(`manifest is ${JSON.stringify(json.manifest)}, not ${latest}`);
        const inRelease = (url) => typeof url === "string" && url.startsWith(pinned) && names.has(url.slice(pinned.length));
        if (!inRelease(json.download)) {
            problems.push(`download is ${JSON.stringify(json.download)}, not ${pinned}<an asset of this release>`);
        }
        const index = json.flags?.metadataUrl;
        if (index !== undefined && !inRelease(index)) {
            problems.push(`flags.metadataUrl is ${JSON.stringify(index)}, not ${pinned}<an asset of this release>`);
        }
        if (json.version !== undefined && `v${json.version}` !== tag) {
            problems.push(`version is ${JSON.stringify(json.version)}, but the tag is ${tag}`);
        }
        if (problems.length) {
            throw new Finding(file.path, `${problems.join("; ")}. Installed copies would not reach this release`);
        }
    }
    return checked;
}

/**
 * How a release's assets differ from the files: missing, a different size or
 * digest, not fully uploaded, or not among the files at all.
 *
 * @param {{name: string, size: number, digest?: string}[]} files
 * @param {{name: string, size: number, state?: string, digest?: string | null}[]} assets
 * @returns {string[]} one line per difference, empty when they match
 */
export function assetDifferences(files, assets) {
    const byName = new Map(assets.map((a) => [a.name, a]));
    const wanted = new Set(files.map((f) => f.name));
    const out = [];
    for (const file of files) {
        const asset = byName.get(file.name);
        if (!asset) out.push(`${file.name} is missing`);
        else if (asset.state && asset.state !== "uploaded") out.push(`${file.name} is ${asset.state}, not uploaded`);
        else if (asset.size !== file.size) out.push(`${file.name} is ${asset.size} bytes, not ${file.size}`);
        else if (file.digest && asset.digest && asset.digest !== file.digest) out.push(`${file.name} has digest ${asset.digest}, not ${file.digest}`);
    }
    for (const asset of assets) if (!wanted.has(asset.name)) out.push(`${asset.name} is not one of this release's files`);
    return out;
}

/** The page number a `Link` header names as `rel="next"`, or `undefined` on the last page. */
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

/** A path segment per `/`-separated part, so a tag is addressed as written. */
const segments = (value) => value.split("/").map(encodeURIComponent).join("/");

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Write a step output, when the runner provides somewhere to write it. */
function output(name, value) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** A client for GitHub's REST API and its uploads host. */
function client({ apiUrl, uploadsUrl, token }) {
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "HeroicLands-github-release",
    };
    async function call(method, url, { json, data, type, accept = [] } = {}) {
        const res = await fetch(url, {
            method,
            headers: {
                ...headers,
                ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
                ...(data !== undefined ? { "Content-Type": type } : {}),
            },
            body: json !== undefined ? JSON.stringify(json) : data,
        });
        const text = await res.text();
        const where = new URL(url).pathname.replace(/^\//, "");
        if (!res.ok && !accept.includes(res.status)) {
            throw new Finding(where, `${method} answered ${res.status}: ${text.trim() || res.statusText}`);
        }
        let body;
        try {
            body = text ? JSON.parse(text) : undefined;
        } catch {
            body = undefined;
        }
        return { status: res.status, body, link: res.headers.get("link") };
    }
    const api = (method, path, options) => call(method, `${apiUrl}${path}`, options);
    api.upload = (path, options) => call("POST", `${uploadsUrl}${path}`, options);
    api.list = async (path) => {
        const items = [];
        for (let page = 1; page !== undefined; ) {
            const join = path.includes("?") ? "&" : "?";
            const res = await api("GET", `${path}${join}per_page=100&page=${page}`);
            if (!Array.isArray(res.body)) throw new Finding(path.replace(/^\//, ""), `GET answered ${res.status} with no list`);
            items.push(...res.body);
            page = res.body.length ? nextPage(res.link) : undefined;
        }
        return items;
    };
    return api;
}

/** The commit a local tag names. */
function localCommit(tag) {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Finding("tag", `${tag} is not a tag in this checkout, so there is no commit to expect on GitHub`);
    }
    return result.stdout.trim();
}

/**
 * Wait until GitHub has the tag, then require that it names `expected`. An
 * annotated tag is followed to its commit.
 */
async function awaitTag(api, { owner, repo }, tag, expected, { waitSeconds, pollSeconds }) {
    const address = `repos/${owner}/${repo}/git/ref/tags/${tag}`;
    const deadline = Date.now() + waitSeconds * 1000;
    for (let attempt = 1; ; attempt++) {
        const res = await api("GET", `/repos/${owner}/${repo}/git/ref/tags/${segments(tag)}`, { accept: [404] });
        if (res.status === 200) {
            let object = res.body?.object;
            for (let depth = 0; object?.type === "tag" && depth < 8; depth++) {
                object = (await api("GET", `/repos/${owner}/${repo}/git/tags/${object.sha}`)).body?.object;
            }
            if (object?.type !== "commit") {
                throw new Finding(address, `names a ${object?.type ?? "missing"} object, not a commit`);
            }
            if (object.sha !== expected) {
                throw new Finding(
                    address,
                    `names commit ${object.sha} on GitHub, but ${tag} is ${expected} here. ` +
                        "The mirror delivered a different tag; no release is attached to it",
                );
            }
            console.log(`github-release: ${tag} is on GitHub at ${expected.slice(0, 7)} (poll ${attempt}).`);
            return;
        }
        if (Date.now() + pollSeconds * 1000 > deadline) {
            throw new Finding(
                address,
                `the push mirror has not delivered ${tag} to GitHub after ${waitSeconds} s; re-run once it has`,
            );
        }
        await sleep(pollSeconds);
    }
}

/**
 * Prove the release is what `releases/latest` serves: the API names it, and
 * each asset's `releases/latest/download/<name>` redirects to this tag's copy
 * and resolves to a file of its size. Asked a few times, because the answer
 * can trail the publish by moments.
 */
async function proveLatest(api, { owner, repo }, tag, files, { serverUrl, pollSeconds }) {
    let problem;
    for (let attempt = 1; attempt <= 5; attempt++) {
        if (attempt > 1) await sleep(pollSeconds);
        problem = undefined;
        const latest = await api("GET", `/repos/${owner}/${repo}/releases/latest`, { accept: [404] });
        if (latest.body?.tag_name !== tag) {
            problem = [
                `repos/${owner}/${repo}/releases/latest`,
                `names ${latest.status === 404 ? "no release" : latest.body?.tag_name}, not ${tag}: the manifest address still serves another version`,
            ];
            continue;
        }
        for (const file of files) {
            problem = await resolveLatest(serverUrl, owner, repo, tag, file);
            if (problem) break;
        }
        if (!problem) {
            console.log(`github-release: ${tag} is Latest, and releases/latest/download serves its ${files.length} asset(s).`);
            return;
        }
    }
    throw new Finding(...problem);
}

/** Follow `releases/latest/download/<name>` without credentials. A problem, or `undefined`. */
async function resolveLatest(serverUrl, owner, repo, tag, file) {
    const start = `${serverUrl}/${owner}/${repo}/releases/latest/download/${file.name}`;
    const where = `${owner}/${repo}/releases/latest/download/${file.name}`;
    const prefix = new URL(serverUrl).pathname.replace(/\/+$/, "");
    const pinned = `${prefix}/${owner}/${repo}/releases/download/${tag}/${file.name}`.toLowerCase();
    let url = start;
    let throughTag = false;
    for (let hop = 0; hop < 6; hop++) {
        const res = await fetch(url, { method: "HEAD", redirect: "manual" });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            url = new URL(res.headers.get("location"), url).href;
            if (decodeURIComponent(new URL(url).pathname).toLowerCase() === pinned) throughTag = true;
            if (!throughTag) return [where, `redirects to ${url}, not to ${tag}'s ${file.name}`];
            continue;
        }
        if (res.status !== 200) return [where, `answered ${res.status} at ${url}`];
        if (!throughTag) return [where, `answered without redirecting to ${tag}'s ${file.name}`];
        const length = res.headers.get("content-length");
        if (length !== null && Number(length) !== file.size) {
            return [where, `serves ${length} bytes, not ${file.size}`];
        }
        return undefined;
    }
    return [where, "redirects more than six times"];
}

/** Read and check the inputs. */
function settings(env) {
    const bool = (name, value) => {
        if (value !== "true" && value !== "false") {
            throw new Finding(name, `must be the literal true or false, not ${JSON.stringify(value ?? "")}`);
        }
        return value === "true";
    };
    const seconds = (name, value, fallback) => {
        const n = value === undefined || value === "" ? fallback : Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Finding(name, `must be a number of seconds, not ${JSON.stringify(value)}`);
        return n;
    };
    const tag = env.RELEASE_TAG ?? "";
    if (!tag) throw new Finding("tag", "no tag given");
    if (!env.RELEASE_TOKEN) {
        throw new Finding("token", "no token supplied. Pass the GitHub token with Contents read and write on the repository");
    }
    const prerelease = bool("prerelease", env.RELEASE_PRERELEASE);
    const makeLatest = bool("make-latest", env.RELEASE_MAKE_LATEST);
    if (prerelease && makeLatest) {
        throw new Finding("make-latest", "is true for a prerelease; GitHub never serves a prerelease as Latest");
    }
    const trim = (url, fallback) => (url || fallback).replace(/\/+$/, "");
    return {
        tag,
        token: env.RELEASE_TOKEN,
        name: env.RELEASE_NAME || tag,
        bodyPath: env.RELEASE_BODY_PATH ?? "",
        prerelease,
        makeLatest,
        files: env.RELEASE_FILES ?? "",
        waitSeconds: seconds("wait-seconds", env.RELEASE_WAIT_SECONDS, 900),
        pollSeconds: seconds("poll-seconds", env.RELEASE_POLL_SECONDS, 15),
        apiUrl: trim(env.RELEASE_API_URL, "https://api.github.com"),
        uploadsUrl: trim(env.RELEASE_UPLOADS_URL, "https://uploads.github.com"),
        serverUrl: trim(env.RELEASE_SERVER_URL, "https://github.com"),
    };
}

/** The release body, refused when GitHub would refuse it. */
function releaseBody(path) {
    if (!path) return "";
    let body;
    try {
        body = readFileSync(path, "utf8");
    } catch (error) {
        throw new Finding(path, `cannot be read: ${error.message}`);
    }
    if (body.length > BODY_LIMIT) {
        throw new Finding(path, `is ${body.length} characters; a GitHub release body holds at most ${BODY_LIMIT}`);
    }
    return body;
}

export async function main(env = process.env) {
    const s = settings(env);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const target = githubRepository(pkg.repository);
    const { owner, repo } = target;
    const files = assetFiles(s.files);
    const manifests = checkManifests(files, target.url, s.tag);
    const body = releaseBody(s.bodyPath);
    for (const file of files) {
        file.digest = `sha256:${createHash("sha256").update(readFileSync(file.path)).digest("hex")}`;
    }
    console.log(
        `github-release: ${s.tag} for ${owner}/${repo} with ${files.length} asset(s)` +
            (manifests ? `, ${manifests} manifest(s) checked.` : "."),
    );

    const api = client(s);
    const expected = localCommit(s.tag);
    await awaitTag(api, target, s.tag, expected, s);

    const finish = async (release) => {
        if (s.makeLatest) {
            await proveLatest(api, target, s.tag, files, s);
        } else {
            const latest = await api("GET", `/repos/${owner}/${repo}/releases/latest`, { accept: [404] });
            if (latest.body?.tag_name === s.tag) {
                throw new Finding(
                    `repos/${owner}/${repo}/releases/latest`,
                    `names ${s.tag}, which was meant not to be Latest; the manifest address now serves it`,
                );
            }
        }
        output("release-url", release.html_url);
        output("release-id", String(release.id));
    };

    const published = await api("GET", `/repos/${owner}/${repo}/releases/tags/${segments(s.tag)}`, { accept: [404] });
    if (published.status === 200 && published.body?.draft === false) {
        const release = published.body;
        const assets = await api.list(`/repos/${owner}/${repo}/releases/${release.id}/assets`);
        const differences = assetDifferences(files, assets);
        if (release.prerelease !== s.prerelease) {
            differences.push(`it is ${release.prerelease ? "" : "not "}a prerelease, and prerelease is ${s.prerelease}`);
        }
        if (differences.length) {
            throw new Finding(
                `repos/${owner}/${repo}/releases/tags/${s.tag}`,
                `${s.tag} is already published and differs: ${differences.join("; ")}. ` +
                    "A published release is never edited here; resolve it by hand",
            );
        }
        console.log(`github-release: ${s.tag} is already published with these assets; nothing to do.`);
        await finish(release);
        return;
    }

    const releases = await api.list(`/repos/${owner}/${repo}/releases`);
    const sameTag = releases.filter((r) => r.tag_name === s.tag);
    if (sameTag.some((r) => !r.draft)) {
        throw new Finding(
            `repos/${owner}/${repo}/releases`,
            `lists a published ${s.tag} that releases/tags/${s.tag} did not return; re-run once GitHub agrees with itself`,
        );
    }
    let release = sameTag[0];
    const fields = { name: s.name, body, prerelease: s.prerelease };
    if (release) {
        release = (await api("PATCH", `/repos/${owner}/${repo}/releases/${release.id}`, { json: { ...fields, draft: true } })).body;
        console.log(`github-release: reusing draft ${release.id}.`);
    } else {
        release = (await api("POST", `/repos/${owner}/${repo}/releases`, { json: { tag_name: s.tag, ...fields, draft: true } })).body;
        console.log(`github-release: created draft ${release.id}.`);
    }

    // Whatever the draft already holds goes: a same-named asset is replaced by
    // this run's file, and any other is not one of this release's files.
    for (const asset of await api.list(`/repos/${owner}/${repo}/releases/${release.id}/assets`)) {
        await api("DELETE", `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
        console.log(`github-release: removed ${asset.name} from the draft.`);
    }
    for (const file of files) {
        await api.upload(`/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, {
            data: readFileSync(file.path),
            type: contentType(file.name),
        });
        console.log(`github-release: uploaded ${file.name} (${file.size} bytes).`);
    }

    const uploaded = await api.list(`/repos/${owner}/${repo}/releases/${release.id}/assets`);
    const differences = assetDifferences(files, uploaded);
    if (differences.length) {
        throw new Finding(
            `repos/${owner}/${repo}/releases/${release.id}/assets`,
            `the draft's assets do not match after upload: ${differences.join("; ")}. The draft stays unpublished; re-run`,
        );
    }

    const done = await api("PATCH", `/repos/${owner}/${repo}/releases/${release.id}`, {
        json: { draft: false, prerelease: s.prerelease, make_latest: s.makeLatest ? "true" : "false" },
    });
    if (done.body?.draft !== false) {
        throw new Finding(`repos/${owner}/${repo}/releases/${release.id}`, "PATCH answered, but the release is still a draft");
    }
    console.log(`github-release: published ${s.tag}${s.prerelease ? " as a prerelease" : ""}.`);
    await finish(done.body);
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
