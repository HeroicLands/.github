/*
 * This file is part of the Song of Heroic Lands (SoHL) system for Foundry VTT.
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * This work is licensed under the GNU General Public License v3.0 (GPLv3).
 * You may copy, modify, and distribute it under the terms of that license.
 *
 * For full terms, see the LICENSE.md file in the project root or visit:
 * https://www.gnu.org/licenses/gpl-3.0.html
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Trusted publisher: built-in Node modules only; artifact files remain data.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

export const RECEIPT = ".preview-publication.json";
export const DESTINATION = "preview-publish@192.168.40.15";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const timestamp = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
export function packageName(value) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9]{0,63}$/.test(value))
        throw new Error("invalid package prefix");
    return value;
}
export function repositoryName(value) {
    if (typeof value !== "string" || !/^HeroicLands\/[A-Za-z0-9_.-]+$/.test(value))
        throw new Error("invalid source repository");
    if ([".", ".."].includes(value.split("/")[1])) throw new Error("invalid source repository");
    return value;
}
export function safeKey(key) {
    if (
        typeof key !== "string" ||
        key.length > 1024 ||
        !/^[A-Za-z0-9_./-]+$/.test(key) ||
        key.split("/").some((x) => !x || x === "." || x === "..")
    )
        throw new Error("unsafe relative file key");
    return key;
}
export async function regularFiles(root) {
    const files = [];
    async function walk(dir, prefix = "") {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0)
            throw new Error("artifact root must be a real directory");
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const key = safeKey(prefix + entry.name),
                full = path.join(dir, entry.name),
                st = await fs.lstat(full);
            if (
                (st.mode & 0o7000) !== 0 ||
                st.isSymbolicLink() ||
                (!st.isDirectory() && !st.isFile()) ||
                (st.isFile() && st.nlink !== 1)
            )
                throw new Error("artifact contains a link or special file");
            if (st.isDirectory()) await walk(full, key + "/");
            else files.push(key);
        }
    }
    await walk(root);
    return files.sort();
}

const cancelled = () => new Error("publication cancelled");
function checkCancellation(signal) {
    if (signal?.aborted) throw cancelled();
}
export async function withPublicationSignals(task) {
    const controller = new AbortController();
    let received;
    const listeners = new Map(
        ["SIGINT", "SIGTERM"].map((name) => [
            name,
            () => {
                received ??= name;
                controller.abort();
            },
        ]),
    );
    for (const [name, listener] of listeners) process.on(name, listener);
    try {
        const result = await task(controller.signal);
        checkCancellation(controller.signal);
        return result;
    } catch (error) {
        if (received) {
            process.exitCode = received === "SIGINT" ? 130 : 143;
            throw cancelled();
        }
        throw error;
    } finally {
        for (const [name, listener] of listeners) process.off(name, listener);
    }
}
async function waitForProcessGroup(pid, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        try {
            process.kill(-pid, 0);
        } catch (error) {
            if (error.code === "ESRCH") return true;
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}
export function runQuiet(
    command,
    args,
    { env = process.env, stdio = "ignore", signal, cancellationGraceMs = 2000 } = {},
) {
    checkCancellation(signal);
    return new Promise((resolve, reject) => {
        // Every local transfer owns a process group so cancellation also stops ssh.
        const child = spawn(command, args, { env, stdio, detached: true });
        let timer,
            wasCancelled = false,
            settled = false;
        const stop = () => {
            wasCancelled = true;
            try {
                process.kill(-child.pid, "SIGTERM");
            } catch {}
            timer ??= setTimeout(() => {
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch {}
            }, cancellationGraceMs);
        };
        const finish = async (error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", stop);
            if (wasCancelled && child.pid) {
                if (!(await waitForProcessGroup(child.pid, cancellationGraceMs))) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    } catch {}
                    await waitForProcessGroup(child.pid, 500);
                }
            }
            clearTimeout(timer);
            if (wasCancelled) reject(cancelled());
            else if (error) reject(error);
            else resolve();
        };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        child.once("error", () => finish(new Error("publication subprocess could not start")));
        // Wait for close, not merely exit: descendants may still hold process pipes.
        child.once("close", (code) =>
            finish(code === 0 ? null : new Error("publication subprocess failed")),
        );
    });
}
export async function currentMain(repository, token, { fetchImpl = fetch, signal } = {}) {
    if (!token) throw new Error("GITEA_TOKEN is required for current-main validation");
    let response;
    try {
        response = await fetchImpl(
            `https://git.pupluppy.org/api/v1/repos/${repository}/branches/main`,
            {
                headers: { Authorization: `token ${token}` },
                redirect: "error",
                signal:
                    signal ?
                        AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    :   AbortSignal.timeout(30000),
            },
        );
    } catch {
        throw new Error("current-main lookup failed");
    }
    if (response.status !== 200) throw new Error("current-main lookup rejected");
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error("current-main lookup invalid");
    }
    if (!SHA.test(result?.commit?.id)) throw new Error("current-main response has no valid SHA");
    return result.commit.id;
}

export async function isCommitAncestor(
    repository,
    ancestor,
    descendant,
    token,
    { fetchImpl = fetch, signal } = {},
) {
    if (
        typeof ancestor !== "string" ||
        typeof descendant !== "string" ||
        !SHA.test(ancestor) ||
        !SHA.test(descendant)
    )
        throw new Error("invalid ancestry SHA");
    if (ancestor === descendant) return true;
    if (!token) throw new Error("GITEA_TOKEN is required for ancestry validation");
    // Gitea28.2 services/git/compare.go direct mode runs git log descendant..ancestor.
    // Zero reachable commits proves ancestry. Triple-dot empty comparisons
    // can also mean unrelated histories, so cannot provide this proof.
    let response;
    try {
        response = await fetchImpl(
            `https://git.pupluppy.org/api/v1/repos/${repository}/compare/${descendant}..${ancestor}?verification=false&files=false`,
            {
                headers: {
                    Authorization: `token ${token}`,
                    Accept: "application/json",
                },
                redirect: "error",
                signal:
                    signal ?
                        AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    :   AbortSignal.timeout(30000),
            },
        );
    } catch {
        throw new Error("commit ancestry lookup failed");
    }
    if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
            "application/json"
    )
        throw new Error("commit ancestry lookup rejected");
    const comparison = await boundedJson(response, 8 * 1024 * 1024, "commit ancestry");
    if (
        !comparison ||
        !Number.isSafeInteger(comparison.total_commits) ||
        comparison.total_commits < 0 ||
        !Array.isArray(comparison.commits) ||
        comparison.total_commits !== comparison.commits.length
    )
        throw new Error("commit ancestry response schema rejected");
    return comparison.total_commits === 0;
}

export async function runWithLock(lockPath, command, args, options = {}) {
    await prepareLock(lockPath);
    return runQuiet(
        "/usr/bin/flock",
        ["--exclusive", "--no-fork", lockPath, command, ...args],
        options,
    );
}

export async function prepareLock(lockPath) {
    const parent = path.dirname(lockPath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(os.homedir(), ".cache"), path.dirname(parent), parent]) {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
            throw new Error("unsafe sender lock directory");
    }
    await fs.chmod(parent, 0o700);
    const handle = await fs.open(lockPath, "ax", 0o600).catch((error) => {
        if (error.code === "EEXIST") return null;
        throw error;
    });
    await handle?.close();
    const stat = await fs.lstat(lockPath);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid()
    )
        throw new Error("unsafe sender lock file");
    await fs.chmod(lockPath, 0o600);
}

export function contextFor({
    package: pkg,
    sourceSha,
    minPages = 1,
    maxPages = 0,
    mode,
    repository,
    prNumber,
}) {
    packageName(pkg);
    if (mode !== undefined && mode !== "pr") throw new Error("invalid publication mode");
    if (
        typeof sourceSha !== "string" ||
        !SHA.test(sourceSha) ||
        !Number.isSafeInteger(minPages) ||
        minPages < 1 ||
        !Number.isSafeInteger(maxPages) ||
        maxPages < 0 ||
        (maxPages && maxPages < minPages)
    )
        throw new Error("invalid trusted publication context");
    if (mode !== "pr") {
        if (prNumber !== undefined) throw new Error("partial PR context");
        return {
            package: pkg,
            sourceSha,
            minPages,
            maxPages,
            mode: "main",
            baseUrl: `https://www.internal.heroiclands.org/${pkg}/`,
        };
    }
    repositoryName(repository);
    const number = typeof prNumber === "number" ? String(prNumber) : prNumber;
    if (
        typeof number !== "string" ||
        !/^[1-9][0-9]*$/.test(number) ||
        !Number.isSafeInteger(Number(number))
    )
        throw new Error("invalid PR number");
    const repo = repository.split("/")[1];
    return {
        package: pkg,
        sourceSha,
        minPages,
        maxPages,
        mode: "pr",
        repository,
        prNumber: Number(number),
        baseUrl: `https://www.internal.heroiclands.org/pr/${repo}/${number}/${pkg}/`,
    };
}
const exactKeys = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
/** The same lock covers every package published for one pull request. */
export function previewLockName(context) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr") throw new Error("PR context required");
    return `pr-${trusted.repository.split("/")[1]}-${trusted.prNumber}.lock`;
}

/** Recheck a PR through the forge rather than trusting an event or artifact. */
export async function currentPullRequest(context, token, { fetchImpl = fetch, signal } = {}) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr" || !token)
        throw new Error("trusted PR context and Gitea token are required");
    let response;
    try {
        response = await fetchImpl(
            `https://git.pupluppy.org/api/v1/repos/${trusted.repository}/pulls/${trusted.prNumber}`,
            {
                headers: { Authorization: `token ${token}`, Accept: "application/json" },
                redirect: "error",
                signal:
                    signal ?
                        AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    :   AbortSignal.timeout(30000),
            },
        );
    } catch {
        throw new Error("pull request lookup failed");
    }
    if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
            "application/json"
    )
        throw new Error("pull request lookup rejected");
    const pr = await boundedJson(response, 1024 * 1024, "pull request");
    return validatePullRequest(pr, context);
}

function validatePullRequest(pr, context) {
    const trusted = contextFor(context);
    if (
        trusted.mode !== "pr" ||
        !pr ||
        pr.number !== trusted.prNumber ||
        !["open", "closed"].includes(pr.state) ||
        typeof pr.title !== "string" ||
        typeof pr.draft !== "boolean" ||
        typeof pr.base?.ref !== "string" ||
        !pr.base.ref ||
        pr.base?.repo?.full_name !== trusted.repository ||
        pr.head?.repo?.full_name !== trusted.repository ||
        typeof pr.head?.sha !== "string" ||
        !SHA.test(pr.head.sha) ||
        !Array.isArray(pr.labels) ||
        pr.labels.some((label) => typeof label?.name !== "string")
    )
        throw new Error("pull request identity rejected");
    return pr;
}

export function previewEligible(pr, context) {
    const trusted = contextFor(context);
    validatePullRequest(pr, context);
    return (
        pr.base.ref === "main" &&
        pr.state === "open" &&
        !pr.draft &&
        !/^WIP:/i.test(pr.title) &&
        pr.head.sha === trusted.sourceSha &&
        pr.labels.some((label) => label.name === "ci/preview")
    );
}

/** These operations require one host lock shared by publication and cleanup. */
export async function publishPreviewValidated(
    manifest,
    context,
    { withLock, loadPullRequest, send, readReceipt },
) {
    const trusted = contextFor(context);
    if (
        trusted.mode !== "pr" ||
        manifest.schemaVersion !== 2 ||
        manifest.mode !== "pr" ||
        manifest.repository !== trusted.repository ||
        manifest.prNumber !== trusted.prNumber ||
        manifest.package !== trusted.package ||
        manifest.sourceSha !== trusted.sourceSha ||
        manifest.baseUrl !== trusted.baseUrl ||
        manifest.assetsOrigin !== "https://cdn.internal.heroiclands.org"
    )
        throw new Error("publication context mismatch");
    return withLock(previewLockName(context), async () => {
        if (!previewEligible(await loadPullRequest(), context))
            throw new Error("PR publication is not eligible");
        await send("www");
        await send("receipt");
        const receipt = await readReceipt();
        if (
            !exactKeys(receipt, [
                "schemaVersion",
                "mode",
                "repository",
                "prNumber",
                "package",
                "sourceSha",
                "builtAt",
                "publishedAt",
                "baseUrl",
                "assetsOrigin",
                "pageCount",
            ]) ||
            receipt.schemaVersion !== 2 ||
            receipt.mode !== "pr" ||
            !timestamp(receipt.publishedAt) ||
            receipt.repository !== trusted.repository ||
            receipt.prNumber !== trusted.prNumber ||
            receipt.package !== trusted.package ||
            receipt.sourceSha !== trusted.sourceSha ||
            receipt.baseUrl !== trusted.baseUrl ||
            receipt.assetsOrigin !== manifest.assetsOrigin ||
            receipt.builtAt !== manifest.builtAt ||
            receipt.pageCount !== manifest.pageCount
        )
            throw new Error("completion receipt does not match candidate");
    });
}

export async function cleanupClosedPreview(context, { withLock, loadPullRequest, remove }) {
    return withLock(previewLockName(context), async () => {
        const pr = validatePullRequest(await loadPullRequest(), context);
        if (pr.state !== "closed") return false;
        await remove(pr);
        return true;
    });
}

/** Receiver-side filters protect sibling PRs while deleting one numbered subtree. */
export function previewCleanupArguments(source, ssh, context) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr") throw new Error("PR context required");
    const repo = trusted.repository.split("/")[1];
    return [
        "--recursive",
        "--delete",
        "--mkpath",
        `--filter=R /${trusted.prNumber}`,
        "--filter=P /*",
        "-e",
        ssh,
        source.endsWith("/") ? source : source + "/",
        `${DESTINATION}:www/pr/${repo}/`,
    ];
}

/** Native Gitea label updates include removals, which do not request a build. */
export function previewRequested(action, changes) {
    if (["synchronized", "reopened"].includes(action)) return true;
    return (
        action === "label_updated" &&
        Array.isArray(changes?.added_labels) &&
        changes.added_labels.some((label) => label?.name === "ci/preview")
    );
}
function payloadKey(key, pkg) {
    safeKey(key);
    if (
        !(key === "site/_headers" || key.startsWith(`site/${pkg}/`)) ||
        key.split("/").at(-1) === RECEIPT
    )
        throw new Error("invalid artifact file declaration");
    return key;
}
/** Package already-built pages; never builds or retrieves CDN bytes. */
export async function createManifest(root, context) {
    const trusted = contextFor(context);
    const { package: pkg, sourceSha } = trusted;
    const files = [];
    for (const key of await regularFiles(path.join(root, "site"))) {
        const fullKey = payloadKey(`site/${key}`, pkg);
        const body = await fs.readFile(path.join(root, fullKey));
        files.push({ key: fullKey, bytes: body.length, sha256: sha256(body) });
    }
    return {
        schemaVersion: trusted.mode === "pr" ? 2 : 1,
        ...(trusted.mode === "pr" ?
            { mode: "pr", repository: trusted.repository, prNumber: trusted.prNumber }
        :   {}),
        package: pkg,
        sourceSha,
        builtAt: context.builtAt ?? new Date().toISOString(),
        baseUrl: trusted.baseUrl,
        assetsOrigin: "https://cdn.internal.heroiclands.org",
        pageCount: files.filter(
            (file) => file.key.startsWith(`site/${pkg}/`) && /(^|\/)index.html$/.test(file.key),
        ).length,
        files,
    };
}
/** Stage a generated PR site into the normalized publication artifact. */
export async function stagePreview(generatedRoot, artifactRoot, context) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr") throw new Error("PR context required for preview staging");
    const prefix = `pr/${trusted.repository.split("/")[1]}/${trusted.prNumber}/${trusted.package}`;
    const files = await regularFiles(generatedRoot);
    if (
        !files.includes("_headers") ||
        !files.includes(`${prefix}/index.html`) ||
        !files.includes(`${prefix}/404.html`) ||
        files.some((key) => key !== "_headers" && !key.startsWith(prefix + "/"))
    )
        throw new Error("unexpected generated preview tree");
    const pageCount = files.filter(
        (key) => key.startsWith(prefix + "/") && /(^|\/)index.html$/.test(key),
    ).length;
    if (pageCount < trusted.minPages || (trusted.maxPages && pageCount > trusted.maxPages))
        throw new Error("generated preview page count rejected");
    const landing = await fs.readFile(path.join(generatedRoot, prefix, "index.html"), "utf8");
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(landing);
    if (!main || !main[1].replace(/<!--[\s\S]*?-->/g, "").trim())
        throw new Error("empty generated preview homepage");
    async function checkDirectories(dir, relative = "") {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const key = relative ? `${relative}/${entry.name}` : entry.name;
            if (!(prefix === key || prefix.startsWith(key + "/") || key.startsWith(prefix + "/")))
                throw new Error("unexpected generated preview directory");
            await checkDirectories(path.join(dir, entry.name), key);
        }
    }
    await checkDirectories(generatedRoot);
    await fs.mkdir(artifactRoot, { recursive: true });
    const artifactStat = await fs.lstat(artifactRoot);
    if (
        !artifactStat.isDirectory() ||
        artifactStat.isSymbolicLink() ||
        (artifactStat.mode & 0o7000) !== 0 ||
        (await fs.readdir(artifactRoot)).length
    )
        throw new Error("artifact directory must be empty and real");
    const sourcePath = await fs.realpath(generatedRoot);
    const artifactPath = await fs.realpath(artifactRoot);
    const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
    if (inside(sourcePath, artifactPath) || inside(artifactPath, sourcePath))
        throw new Error("generated and artifact directories overlap");
    for (const key of files) {
        const destination =
            key === "_headers" ? "site/_headers" : (
                `site/${trusted.package}/${key.slice(prefix.length + 1)}`
            );
        payloadKey(destination, trusted.package);
        const target = path.join(artifactRoot, destination);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(generatedRoot, key), target, fs.constants.COPYFILE_EXCL);
    }
    const manifest = await createManifest(artifactRoot, context);
    await fs.writeFile(
        path.join(artifactRoot, "publication.json"),
        JSON.stringify(manifest) + "\n",
        { flag: "wx" },
    );
    return validateArtifact(artifactRoot, context);
}
export async function validateArtifact(root, context) {
    const trusted = contextFor(context);
    const { package: pkg, sourceSha, minPages, maxPages } = trusted;
    const files = await regularFiles(root);
    if (files.length > 100000 || !files.includes("publication.json"))
        throw new Error("invalid artifact inventory");
    const raw = await fs.readFile(path.join(root, "publication.json"));
    if (raw.length > 32 * 1024 * 1024) throw new Error("oversized publication manifest");
    let manifest;
    try {
        manifest = JSON.parse(raw);
    } catch {
        throw new Error("invalid publication manifest");
    }
    if (
        manifest.schemaVersion !== (trusted.mode === "pr" ? 2 : 1) ||
        (trusted.mode === "pr" &&
            (!exactKeys(manifest, [
                "schemaVersion",
                "mode",
                "repository",
                "prNumber",
                "package",
                "sourceSha",
                "builtAt",
                "baseUrl",
                "assetsOrigin",
                "pageCount",
                "files",
            ]) ||
                manifest.mode !== "pr" ||
                manifest.repository !== trusted.repository ||
                manifest.prNumber !== trusted.prNumber)) ||
        manifest.package !== pkg ||
        manifest.sourceSha !== sourceSha ||
        !timestamp(manifest.builtAt) ||
        manifest.baseUrl !== trusted.baseUrl ||
        manifest.assetsOrigin !== "https://cdn.internal.heroiclands.org" ||
        !Number.isSafeInteger(manifest.pageCount) ||
        manifest.pageCount < minPages ||
        (maxPages && manifest.pageCount > maxPages) ||
        !Array.isArray(manifest.files)
    )
        throw new Error("publication context mismatch");
    const declared = new Set();
    for (const file of manifest.files) {
        const key = payloadKey(file.key, pkg);
        if (
            (trusted.mode === "pr" && !exactKeys(file, ["key", "bytes", "sha256"])) ||
            declared.has(key) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            (trusted.mode === "pr" && typeof file.sha256 !== "string") ||
            !HASH.test(file.sha256)
        )
            throw new Error("invalid artifact file declaration");
        declared.add(key);
        const body = await fs.readFile(path.join(root, key));
        if (body.length !== file.bytes || sha256(body) !== file.sha256)
            throw new Error("artifact digest mismatch");
    }
    if (
        files.length !== declared.size + 1 ||
        files.some((key) => key !== "publication.json" && !declared.has(key))
    )
        throw new Error("undeclared artifact file");
    for (const key of ["site/_headers", `site/${pkg}/index.html`, `site/${pkg}/404.html`])
        if (!declared.has(key)) throw new Error("missing publication payload");
    if (
        files.filter((key) => key.startsWith(`site/${pkg}/`) && /(^|\/)index.html$/.test(key))
            .length !== manifest.pageCount
    )
        throw new Error("page count mismatch");
    const landing = await fs.readFile(path.join(root, `site/${pkg}/index.html`), "utf8");
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(landing);
    if (!main || !main[1].replace(/<!--[\s\S]*?-->/g, "").trim())
        throw new Error("empty homepage main");
    return manifest;
}
export function transferArguments(kind, source, list, ssh, pkg, context) {
    packageName(pkg);
    const trusted = context ? contextFor(context) : null;
    if (trusted && trusted.package !== pkg) throw new Error("publication context mismatch");
    if (!["www", "receipt"].includes(kind)) throw new Error("invalid transfer stage");
    const args = [
        "--recursive",
        "--times",
        "--perms",
        "--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r",
        "--omit-dir-times",
        "--delay-updates",
        "--from0",
        `--files-from=${list}`,
        "-e",
        ssh,
    ];
    if (kind === "www") args.push("--delete-delay", `--exclude=/${RECEIPT}`);
    if (trusted?.mode === "pr") args.push("--mkpath");
    const target =
        trusted?.mode === "pr" ?
            `www/pr/${trusted.repository.split("/")[1]}/${trusted.prNumber}/${pkg}/`
        :   `www/${pkg}/`;
    args.push(source.endsWith("/") ? source : source + "/", `${DESTINATION}:${target}`);
    return args;
}
export async function assertPublicationEligible(
    sourceSha,
    { currentMain, readReceipt, isAncestor },
) {
    if (!SHA.test(sourceSha)) throw new Error("invalid candidate source SHA");
    const mainSha = await currentMain();
    if (!SHA.test(mainSha) || !(await isAncestor(sourceSha, mainSha)))
        throw new Error("candidate build is outside current main history");
    const receipt = await readReceipt();
    if (receipt && !(await isAncestor(receipt.sourceSha, sourceSha)))
        throw new Error("candidate build is older than or divergent from published receipt");
}
export async function publishValidated(
    manifest,
    { withLock, currentMain, readReceipt, isAncestor, send },
) {
    await withLock(async () => {
        const state = { currentMain, readReceipt, isAncestor };
        await assertPublicationEligible(manifest.sourceSha, state);
        await send("www");
        await send("receipt");
        const completed = await readReceipt();
        if (!completed || completed.sourceSha !== manifest.sourceSha)
            throw new Error("completion receipt is missing or names a different source SHA");
    });
}
export function receiptFor(manifest, publishedAt = new Date().toISOString()) {
    if (!timestamp(publishedAt)) throw new Error("invalid receipt timestamp");
    const { package: pkg, sourceSha, builtAt, baseUrl, assetsOrigin, pageCount } = manifest;
    return {
        schemaVersion: manifest.schemaVersion,
        ...(manifest.schemaVersion === 2 ?
            { mode: "pr", repository: manifest.repository, prNumber: manifest.prNumber }
        :   {}),
        package: pkg,
        sourceSha,
        builtAt,
        publishedAt,
        baseUrl,
        assetsOrigin,
        pageCount,
    };
}
async function boundedJson(response, maxBytes, label) {
    const chunks = [];
    let bytes = 0;
    try {
        for await (const chunk of response.body ?? []) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error("response too large");
            chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error(`${label} response is invalid or exceeds its size limit`);
    }
}
export async function readPublicationReceipt(
    manifest,
    { fetchImpl = fetch, signal, context } = {},
) {
    const trusted = context ? contextFor(context) : null;
    if (
        (manifest.schemaVersion === 2 || trusted?.mode === "pr") &&
        (!trusted ||
            trusted.mode !== "pr" ||
            manifest.schemaVersion !== 2 ||
            manifest.repository !== trusted.repository ||
            manifest.prNumber !== trusted.prNumber ||
            manifest.package !== trusted.package ||
            manifest.sourceSha !== trusted.sourceSha ||
            manifest.baseUrl !== trusted.baseUrl ||
            manifest.assetsOrigin !== "https://cdn.internal.heroiclands.org")
    )
        throw new Error("publication context mismatch");
    let response;
    try {
        response = await fetchImpl(manifest.baseUrl + RECEIPT, {
            redirect: "error",
            cache: "no-store",
            headers: { Accept: "application/json", "Cache-Control": "no-cache" },
            signal:
                signal ?
                    AbortSignal.any([signal, AbortSignal.timeout(30000)])
                :   AbortSignal.timeout(30000),
        });
    } catch {
        throw new Error("published receipt lookup failed");
    }
    if (response.redirected) throw new Error("published receipt redirect refused");
    if (response.status === 404) return null;
    if (
        response.status !== 200 ||
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
            "application/json"
    )
        throw new Error("published receipt lookup rejected");
    const receipt = await boundedJson(response, 16 * 1024, "published receipt");
    if (
        !receipt ||
        receipt.schemaVersion !== (trusted?.mode === "pr" ? 2 : 1) ||
        (trusted?.mode === "pr" &&
            (!exactKeys(receipt, [
                "schemaVersion",
                "mode",
                "repository",
                "prNumber",
                "package",
                "sourceSha",
                "builtAt",
                "publishedAt",
                "baseUrl",
                "assetsOrigin",
                "pageCount",
            ]) ||
                receipt.mode !== "pr" ||
                receipt.repository !== trusted.repository ||
                receipt.prNumber !== trusted.prNumber ||
                receipt.sourceSha !== trusted.sourceSha)) ||
        receipt.package !== manifest.package ||
        !SHA.test(receipt.sourceSha) ||
        !timestamp(receipt.builtAt) ||
        !timestamp(receipt.publishedAt) ||
        receipt.baseUrl !== manifest.baseUrl ||
        receipt.assetsOrigin !== manifest.assetsOrigin ||
        !Number.isSafeInteger(receipt.pageCount) ||
        receipt.pageCount < 1 ||
        (trusted?.mode !== "pr" &&
            Object.keys(receipt).some(
                (key) =>
                    ![
                        "schemaVersion",
                        "package",
                        "sourceSha",
                        "builtAt",
                        "publishedAt",
                        "baseUrl",
                        "assetsOrigin",
                        "pageCount",
                    ].includes(key),
            ))
    )
        throw new Error("published receipt schema rejected");
    return receipt;
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function withSshIdentity(key, task) {
    if (!key?.trim())
        throw new Error("PREVIEW_SSH_PRIVATE_KEY is required for internal publication");
    const parent = path.join(os.homedir(), ".cache/heroiclands/preview-publish");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    for (const directory of [path.join(os.homedir(), ".cache"), path.dirname(parent), parent]) {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
            throw new Error("unsafe SSH identity directory");
    }
    await fs.chmod(parent, 0o700);
    const temp = await fs.mkdtemp(path.join(parent, "identity-"));
    try {
        await fs.chmod(temp, 0o700);
        const identity = path.join(temp, "identity"),
            known = path.join(temp, "known_hosts");
        await fs.writeFile(identity, key, { mode: 0o600 });
        await fs.copyFile(fileURLToPath(new URL("./known_hosts", import.meta.url)), known);
        await fs.chmod(known, 0o600);
        const ssh = [
            "/usr/bin/ssh",
            "-F",
            "/dev/null",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-p",
            "22",
            "-i",
            identity,
            "-o",
            `UserKnownHostsFile=${known}`,
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "ConnectTimeout=30",
        ]
            .map(shellQuote)
            .join(" ");
        return await task({
            temp,
            ssh,
            childEnv: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        });
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
}
export async function sendPublication(
    root,
    manifest,
    repository,
    signal,
    { env = process.env, fetchImpl = fetch, run = runQuiet } = {},
) {
    if (manifest.schemaVersion !== 1) throw new Error("PR publication is not enabled");
    const token = env.GITEA_TOKEN;
    if (!token) throw new Error("GITEA_TOKEN is required for current-main validation");
    await withSshIdentity(env.PREVIEW_SSH_PRIVATE_KEY, async ({ temp, ssh, childEnv }) => {
        await publishValidated(manifest, {
            withLock: async (fn) => fn(),
            currentMain: () => currentMain(repository, token, { fetchImpl, signal }),
            readReceipt: () => readPublicationReceipt(manifest, { fetchImpl, signal }),
            isAncestor: (ancestor, descendant) =>
                isCommitAncestor(repository, ancestor, descendant, token, { fetchImpl, signal }),
            send: async (kind) => {
                checkCancellation(signal);
                const source =
                    kind === "www" ?
                        path.join(root, "site", manifest.package)
                    :   path.join(temp, "receipt");
                if (kind === "receipt") {
                    await fs.mkdir(source);
                    await fs.writeFile(
                        path.join(source, RECEIPT),
                        JSON.stringify(receiptFor(manifest)) + "\n",
                        { mode: 0o644 },
                    );
                }
                const files = await regularFiles(source),
                    list = path.join(temp, `${kind}.list`);
                // Parent directories enable recursive deletion with --files-from.
                const parents = new Set(kind === "www" ? ["."] : []);
                if (kind === "www")
                    for (const file of files) {
                        let parent = path.posix.dirname(file);
                        while (parent !== ".") {
                            parents.add(parent + "/");
                            parent = path.posix.dirname(parent);
                        }
                    }
                await fs.writeFile(list, [...parents, ...files].join("\0") + "\0", {
                    mode: 0o600,
                });
                await run(
                    "/usr/bin/rsync",
                    transferArguments(kind, source, list, ssh, manifest.package),
                    {
                        env: childEnv,
                        signal,
                    },
                );
            },
        });
    });
}
/** Publish one verified PR artifact while the caller holds its PR lock. */
export async function sendPreviewLocked(
    root,
    manifest,
    context,
    signal,
    { env = process.env, fetchImpl = fetch, run = runQuiet } = {},
) {
    const trusted = contextFor(context);
    const token = env.GITEA_TOKEN;
    if (trusted.mode !== "pr" || !token) throw new Error("PR context and GITEA_TOKEN are required");
    const lookup = () => currentPullRequest(context, token, { fetchImpl, signal });
    await publishPreviewValidated(manifest, context, {
        withLock: async (_name, fn) => fn(),
        loadPullRequest: lookup,
        readReceipt: () => readPublicationReceipt(manifest, { context, fetchImpl, signal }),
        send: async (kind) => {
            checkCancellation(signal);
            await withSshIdentity(env.PREVIEW_SSH_PRIVATE_KEY, async ({ temp, ssh, childEnv }) => {
                const source =
                    kind === "www" ?
                        path.join(root, "site", trusted.package)
                    :   path.join(temp, "receipt");
                if (kind === "receipt") {
                    await fs.mkdir(source);
                    await fs.writeFile(
                        path.join(source, RECEIPT),
                        JSON.stringify(receiptFor(manifest)) + "\n",
                        { mode: 0o644 },
                    );
                }
                const files = await regularFiles(source);
                const parents = new Set(kind === "www" ? ["."] : []);
                if (kind === "www")
                    for (const file of files) {
                        let parent = path.posix.dirname(file);
                        while (parent !== ".") {
                            parents.add(parent + "/");
                            parent = path.posix.dirname(parent);
                        }
                    }
                const list = path.join(temp, "files.list");
                await fs.writeFile(list, [...parents, ...files].join("\0") + "\0", { mode: 0o600 });
                await run(
                    "/usr/bin/rsync",
                    transferArguments(kind, source, list, ssh, trusted.package, context),
                    { env: childEnv, signal },
                );
            });
        },
    });
    if (!previewEligible(await lookup(), context))
        throw new Error("PR changed before status publication");
    await writePreviewStatus(context, token, { fetchImpl, signal });
}

export async function writePreviewStatus(
    context,
    token,
    { fetchImpl = fetch, signal, state = "success" } = {},
) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr" || !token || !["success", "error"].includes(state))
        throw new Error("PR context, status and Gitea token are required");
    let response;
    try {
        response = await fetchImpl(
            `https://git.pupluppy.org/api/v1/repos/${trusted.repository}/statuses/${trusted.sourceSha}`,
            {
                method: "POST",
                redirect: "error",
                headers: {
                    Authorization: `token ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    state,
                    context: `preview/${trusted.package}/pr-${trusted.prNumber}`,
                    target_url: trusted.baseUrl,
                    description:
                        state === "success" ?
                            "Internal PR preview published"
                        :   "Preview unavailable",
                }),
                signal:
                    signal ?
                        AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    :   AbortSignal.timeout(30000),
            },
        );
    } catch {
        throw new Error("preview status update failed");
    }
    if (response.redirected || ![200, 201].includes(response.status))
        throw new Error("preview status update rejected");
}

/** Supersede each package status on the closed PR's current head before deletion. */
export async function invalidatePreviewStatuses(
    context,
    headSha,
    token,
    { fetchImpl = fetch, signal } = {},
) {
    const trusted = contextFor(context);
    if (trusted.mode !== "pr" || !SHA.test(headSha) || !token)
        throw new Error("invalid preview status context");
    const packages = new Set();
    let complete = false;
    let seen = 0;
    for (let page = 1; page <= 100; page++) {
        let response;
        try {
            response = await fetchImpl(
                `https://git.pupluppy.org/api/v1/repos/${trusted.repository}/commits/${headSha}/statuses?limit=100&page=${page}`,
                {
                    headers: { Authorization: `token ${token}`, Accept: "application/json" },
                    redirect: "error",
                    signal:
                        signal ?
                            AbortSignal.any([signal, AbortSignal.timeout(30000)])
                        :   AbortSignal.timeout(30000),
                },
            );
        } catch {
            throw new Error("preview status lookup failed");
        }
        if (
            response.status !== 200 ||
            response.redirected ||
            response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
                "application/json"
        )
            throw new Error("preview status lookup rejected");
        const totalHeader = response.headers.get("x-total-count");
        if (
            typeof totalHeader !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(totalHeader) ||
            !Number.isSafeInteger(Number(totalHeader)) ||
            Number(totalHeader) > 10000
        )
            throw new Error("preview status count rejected");
        const total = Number(totalHeader);
        const statuses = await boundedJson(response, 1024 * 1024, "preview status");
        if (
            !Array.isArray(statuses) ||
            statuses.length > 100 ||
            statuses.some((status) => typeof status?.context !== "string")
        )
            throw new Error("preview status response rejected");
        for (const status of statuses) {
            const match = /^preview\/([a-z][a-z0-9]{0,63})\/pr-([1-9][0-9]*)$/.exec(status.context);
            if (match && match[2] === String(trusted.prNumber)) packages.add(match[1]);
        }
        seen += statuses.length;
        if (seen >= total) {
            complete = true;
            break;
        }
        if (statuses.length === 0) throw new Error("incomplete preview status listing");
    }
    if (!complete) throw new Error("preview status pagination exceeded limit");
    for (const pkg of packages)
        await writePreviewStatus({ ...context, package: pkg, sourceSha: headSha }, token, {
            fetchImpl,
            signal,
            state: "error",
        });
}

/** Invalidate current-head evidence on reopen, even when no build is requested. */
export async function invalidateReopenedPreview(
    context,
    signal,
    { env = process.env, fetchImpl = fetch } = {},
) {
    const token = env.GITEA_TOKEN;
    if (!token) throw new Error("GITEA_TOKEN is required");
    const pr = await currentPullRequest(context, token, { fetchImpl, signal });
    if (pr.state !== "open") return false;
    await invalidatePreviewStatuses(context, pr.head.sha, token, { fetchImpl, signal });
    return true;
}

/** Remove a closed PR's subtree while the caller holds its PR lock. */
export async function cleanupPreviewLocked(
    context,
    signal,
    { env = process.env, fetchImpl = fetch, run = runQuiet } = {},
) {
    const token = env.GITEA_TOKEN;
    if (!token) throw new Error("GITEA_TOKEN is required");
    return cleanupClosedPreview(context, {
        withLock: async (_name, fn) => fn(),
        loadPullRequest: () => currentPullRequest(context, token, { fetchImpl, signal }),
        remove: async (pr) => {
            await invalidatePreviewStatuses(context, pr.head.sha, token, { fetchImpl, signal });
            return withSshIdentity(env.PREVIEW_SSH_PRIVATE_KEY, async ({ temp, ssh, childEnv }) => {
                const empty = path.join(temp, "empty");
                await fs.mkdir(empty);
                await run("/usr/bin/rsync", previewCleanupArguments(empty, ssh, context), {
                    env: childEnv,
                    signal,
                });
            });
        },
    });
}

/** Manual CDN adapter: configure one pinned SSH alias for the released publisher. */
export async function runCdn({ env = process.env, run = runQuiet, signal } = {}) {
    const dest = env.CDN_DEST || "internal";
    if (!["internal", "cloudflare"].includes(dest)) throw new Error("invalid CDN destination");
    if (!env.SET || !env.SET_NAME || !["true", "false"].includes(env.DRY_RUN || "false"))
        throw new Error("invalid manual CDN inputs");
    const args = ["cdn", "publish", "--dest", dest, "--set", env.SET, "--name", env.SET_NAME];
    if (env.DRY_RUN === "true") args.push("--dry-run");
    const childEnv = { PATH: env.PATH, LANG: "C.UTF-8" };
    if (dest === "cloudflare") {
        for (const key of [
            "CDN_ENDPOINT",
            "CDN_BUCKET",
            "CDN_ACCESS_KEY_ID",
            "CDN_SECRET_ACCESS_KEY",
        ])
            if (env[key]) childEnv[key] = env[key];
        return run("node_modules/.bin/package-build", args, {
            env: childEnv,
            stdio: "inherit",
            signal,
        });
    }
    if (env.DRY_RUN === "true")
        return run("node_modules/.bin/package-build", args, {
            env: childEnv,
            stdio: "inherit",
            signal,
        });
    return withSshIdentity(env.PREVIEW_SSH_PRIVATE_KEY, async ({ temp }) => {
        const config = path.join(temp, "ssh_config");
        const quoted = (value) => '"' + value.replaceAll('"', '\\"') + '"';
        await fs.writeFile(
            config,
            [
                "Host heroiclands-internal",
                "  HostName 192.168.40.15",
                "  User preview-publish",
                `  IdentityFile ${quoted(path.join(temp, "identity"))}`,
                `  UserKnownHostsFile ${quoted(path.join(temp, "known_hosts"))}`,
                "  GlobalKnownHostsFile /dev/null",
                "  StrictHostKeyChecking yes",
                "  IdentitiesOnly yes",
                "  BatchMode yes",
                "  PasswordAuthentication no",
                "  ConnectTimeout 30",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        // The transport invokes ssh by name; a private shim supplies its config
        // without modifying the runner's SSH files or forwarding the secret.
        await fs.writeFile(
            path.join(temp, "ssh"),
            `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(config)} "$@"\n`,
            { mode: 0o700 },
        );
        return run("node_modules/.bin/package-build", args, {
            env: {
                ...childEnv,
                PATH: temp + path.delimiter + childEnv.PATH,
                CDN_INTERNAL_DESTINATION: "heroiclands-internal:cdn",
            },
            stdio: "inherit",
            signal,
        });
    });
}
async function main(signal) {
    const [command, root = "publication"] = process.argv.slice(2);
    if (command === "--help" || command === "-h") {
        console.log(`Usage: publish.mjs <command> [paths]

Commands:
  stage <generated-root> [artifact-root]  Stage a PR site (artifact root defaults to publication)
  manifest [artifact-root]                Create and validate a manifest
  validate [artifact-root]                Validate an artifact
  publish [artifact-root]                 Publish a main artifact under a lock
  locked [artifact-root]                  Publish a main artifact with the lock held
  preview-check                           Check current PR eligibility and print its base URL
  preview-publish [artifact-root]          Publish a validated PR artifact under its PR lock
  preview-cleanup                         Clean a closed PR under its PR lock
  preview-reopen                          Invalidate reopened PR evidence under its PR lock
  cdn                                     Run the manual CDN adapter

Artifact root defaults to publication. PR staging, manifest, and validation require
PUBLICATION_MODE=pr, SOURCE_REPOSITORY, PR_NUMBER, SOURCE_SHA, and PUBLICATION_PACKAGE.
MIN_PAGES defaults to 1; MAX_PAGES defaults to 0 (no maximum). Main artifacts require
SOURCE_SHA and PUBLICATION_PACKAGE.

Credentials by command:
  stage, manifest, validate: none.
  preview-check, preview-reopen: GITEA_TOKEN (PR reads; reopen also writes statuses).
  publish, locked, preview-publish, preview-cleanup: GITEA_TOKEN and
    PREVIEW_SSH_PRIVATE_KEY (PR publication/cleanup also writes statuses).
  cdn: internal writes require PREVIEW_SSH_PRIVATE_KEY; internal dry runs need none.
    Cloudflare uses CDN_ENDPOINT, CDN_BUCKET, CDN_ACCESS_KEY_ID and
    CDN_SECRET_ACCESS_KEY. SET and SET_NAME are required; CDN_DEST defaults to
    internal and DRY_RUN defaults to false.`);
        return;
    }
    if (command === "cdn") return runCdn({ signal });
    const context = {
        mode: process.env.PUBLICATION_MODE,
        repository: process.env.SOURCE_REPOSITORY,
        prNumber: process.env.PR_NUMBER,
        package: process.env.PUBLICATION_PACKAGE,
        sourceSha: process.env.SOURCE_SHA,
        minPages: Number(process.env.MIN_PAGES ?? 1),
        maxPages: Number(process.env.MAX_PAGES ?? 0),
    };
    if (command === "preview-check") {
        const trusted = contextFor(context);
        if (
            trusted.mode !== "pr" ||
            !previewEligible(
                await currentPullRequest(context, process.env.GITEA_TOKEN, { signal }),
                context,
            )
        )
            throw new Error("PR publication is not eligible");
        console.log(trusted.baseUrl);
        return;
    }
    if (
        [
            "preview-publish",
            "preview-locked",
            "preview-cleanup",
            "preview-cleanup-locked",
            "preview-reopen",
            "preview-reopen-locked",
        ].includes(command)
    ) {
        const trusted = contextFor(context);
        if (trusted.mode !== "pr") throw new Error("PR context required");
        const cleanup = command.startsWith("preview-cleanup");
        const reopen = command.startsWith("preview-reopen");
        const manifest = cleanup || reopen ? null : await validateArtifact(root, context);
        checkCancellation(signal);
        if (command.endsWith("-locked")) {
            if (cleanup) await cleanupPreviewLocked(context, signal);
            else if (reopen) await invalidateReopenedPreview(context, signal);
            else await sendPreviewLocked(root, manifest, context, signal);
            return;
        }
        if (!process.env.GITEA_TOKEN || (!reopen && !process.env.PREVIEW_SSH_PRIVATE_KEY?.trim()))
            throw new Error("publication credentials are required");
        const lockPath = path.join(
            os.homedir(),
            ".cache/heroiclands/preview-publish",
            previewLockName(context),
        );
        await runWithLock(
            lockPath,
            process.execPath,
            [
                fileURLToPath(import.meta.url),
                cleanup ? "preview-cleanup-locked"
                : reopen ? "preview-reopen-locked"
                : "preview-locked",
                root,
            ],
            { stdio: "inherit", signal, cancellationGraceMs: 10000 },
        );
        return;
    }
    if (command === "stage") {
        await stagePreview(root, process.argv[4] ?? "publication", context);
        return;
    }
    if (command === "manifest") {
        const manifest = await createManifest(root, context);
        await fs.writeFile(path.join(root, "publication.json"), JSON.stringify(manifest) + "\n");
        await validateArtifact(root, context);
        return;
    }
    const manifest = await validateArtifact(root, context);
    checkCancellation(signal);
    if (command === "validate") {
        console.log("Publication artifact validated");
        return;
    }
    if (context.mode === "pr") throw new Error("PR publication is not enabled");
    const repository = repositoryName(process.env.SOURCE_REPOSITORY);
    if (!["publish", "locked"].includes(command)) throw new Error("invalid publisher command");
    if (command === "locked") {
        await sendPublication(root, manifest, repository, signal);
        return;
    }
    if (!process.env.PREVIEW_SSH_PRIVATE_KEY?.trim() || !process.env.GITEA_TOKEN)
        throw new Error("publication credentials are required");
    const lockPath = path.join(
        os.homedir(),
        ".cache/heroiclands/preview-publish",
        `${manifest.package}-main.lock`,
    );
    await runWithLock(
        lockPath,
        process.execPath,
        [fileURLToPath(import.meta.url), "locked", root],
        { stdio: "inherit", signal, cancellationGraceMs: 10000 },
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    withPublicationSignals(main).catch((error) => {
        console.error(error.message);
        process.exitCode ||= 1;
    });
