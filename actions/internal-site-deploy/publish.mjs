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
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    : AbortSignal.timeout(30000),
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
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
                    : AbortSignal.timeout(30000),
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

function contextFor({ package: pkg, sourceSha, minPages = 1, maxPages = 0 }) {
    packageName(pkg);
    if (
        !SHA.test(sourceSha) ||
        !Number.isSafeInteger(minPages) ||
        minPages < 1 ||
        !Number.isSafeInteger(maxPages) ||
        maxPages < 0 ||
        (maxPages && maxPages < minPages)
    )
        throw new Error("invalid trusted publication context");
    return { package: pkg, sourceSha, minPages, maxPages };
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
    const { package: pkg, sourceSha } = contextFor(context);
    const files = [];
    for (const key of await regularFiles(path.join(root, "site"))) {
        const fullKey = payloadKey(`site/${key}`, pkg);
        const body = await fs.readFile(path.join(root, fullKey));
        files.push({ key: fullKey, bytes: body.length, sha256: sha256(body) });
    }
    return {
        schemaVersion: 1,
        package: pkg,
        sourceSha,
        builtAt: context.builtAt ?? new Date().toISOString(),
        baseUrl: `https://www.internal.heroiclands.org/${pkg}/`,
        assetsOrigin: "https://cdn.internal.heroiclands.org",
        pageCount: files.filter(
            (file) => file.key.startsWith(`site/${pkg}/`) && /(^|\/)index.html$/.test(file.key),
        ).length,
        files,
    };
}
export async function validateArtifact(root, context) {
    const { package: pkg, sourceSha, minPages, maxPages } = contextFor(context);
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
        manifest.schemaVersion !== 1 ||
        manifest.package !== pkg ||
        manifest.sourceSha !== sourceSha ||
        !timestamp(manifest.builtAt) ||
        manifest.baseUrl !== `https://www.internal.heroiclands.org/${pkg}/` ||
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
            declared.has(key) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
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
export function transferArguments(kind, source, list, ssh, pkg) {
    packageName(pkg);
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
    args.push(source.endsWith("/") ? source : source + "/", `${DESTINATION}:www/${pkg}/`);
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
        schemaVersion: 1,
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
export async function readPublicationReceipt(manifest, { fetchImpl = fetch, signal } = {}) {
    let response;
    try {
        response = await fetchImpl(manifest.baseUrl + RECEIPT, {
            redirect: "error",
            cache: "no-store",
            headers: { Accept: "application/json", "Cache-Control": "no-cache" },
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
                : AbortSignal.timeout(30000),
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
        receipt.schemaVersion !== 1 ||
        receipt.package !== manifest.package ||
        !SHA.test(receipt.sourceSha) ||
        !timestamp(receipt.builtAt) ||
        !timestamp(receipt.publishedAt) ||
        receipt.baseUrl !== manifest.baseUrl ||
        receipt.assetsOrigin !== manifest.assetsOrigin ||
        !Number.isSafeInteger(receipt.pageCount) ||
        receipt.pageCount < 1 ||
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
        )
    )
        throw new Error("published receipt schema rejected");
    return receipt;
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function withSshIdentity(key, task) {
    if (!key?.trim())
        throw new Error("PREVIEW_SSH_PRIVATE_KEY is required for internal publication");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "site-publish-"));
    try {
        await fs.chmod(temp, 0o700);
        const identity = path.join(temp, "identity"),
            known = path.join(temp, "known_hosts");
        await fs.writeFile(identity, key, { mode: 0o600 });
        await fs.copyFile(fileURLToPath(new URL("./known_hosts", import.meta.url)), known);
        await fs.chmod(known, 0o600);
        const ssh = [
            "ssh",
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
            childEnv: { PATH: process.env.PATH, LANG: "C.UTF-8" },
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
                    kind === "www"
                        ? path.join(root, "site", manifest.package)
                        : path.join(temp, "receipt");
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
                await run("rsync", transferArguments(kind, source, list, ssh, manifest.package), {
                    env: childEnv,
                    signal,
                });
            },
        });
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
    if (command === "cdn") return runCdn({ signal });
    const context = {
        package: process.env.PUBLICATION_PACKAGE,
        sourceSha: process.env.SOURCE_SHA,
        minPages: Number(process.env.MIN_PAGES ?? 1),
        maxPages: Number(process.env.MAX_PAGES ?? 0),
    };
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
    await prepareLock(lockPath);
    await runQuiet(
        "flock",
        [
            "--exclusive",
            "--no-fork",
            lockPath,
            process.execPath,
            fileURLToPath(import.meta.url),
            "locked",
            root,
        ],
        { stdio: "inherit", signal, cancellationGraceMs: 10000 },
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    withPublicationSignals(main).catch((error) => {
        console.error(error.message);
        process.exitCode ||= 1;
    });
