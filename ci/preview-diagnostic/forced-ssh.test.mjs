/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
    contextFor,
    previewCleanupArguments,
    publishPreviewValidated,
    readPublicationReceipt,
    receiptFor,
    RECEIPT,
    runQuiet,
    transferArguments,
    withSshIdentity,
} from "../../actions/internal-site-deploy/publish.mjs";

const root = process.env.PREVIEW_FIXTURE_ROOT;
const port = process.env.PREVIEW_FIXTURE_PORT;
if (!root || !port) throw new Error("forced SSH fixture environment required");
const context = {
    mode: "pr",
    repository: "HeroicLands/thalorna",
    prNumber: "123",
    package: "thalorna",
    sourceSha: "a".repeat(40),
};
const trusted = contextFor(context);
const receiver = path.join(root, "receiver");
const destination = path.join(receiver, "www/pr/thalorna/123/thalorna");
const sentinels = [
    "www/pr/thalorna/124/thalorna/index.html",
    "www/thalorna/index.html",
    "cdn/sentinel",
];
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
};
const absent = async (file) => assert.rejects(fs.stat(file), { code: "ENOENT" });
const ssh = (identity, pidFile) => {
    const options = [
        "ssh",
        "-F",
        "/dev/null",
        "-p",
        port,
        "-i",
        identity,
        "-o",
        `UserKnownHostsFile=${root}/known_hosts`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
    ];
    return pidFile ?
            `${quote(path.join(root, "ssh-wrapper"))} ${quote(pidFile)} ${options.map(quote).join(" ")}`
        :   options.map(quote).join(" ");
};
const fixtureTarget = (args) => {
    const target = args.at(-1);
    assert.match(target, /^preview-publish@192\.168\.40\.15:www\/pr\/thalorna\//);
    args[args.length - 1] = target.replace("preview-publish@192.168.40.15:", "root@127.0.0.1:");
    return args;
};
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
};
const waitFor = async (predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("fixture transfer did not start in time");
};

test("forced rrsync publication, cleanup, and cancellation", { timeout: 100000 }, async () => {
    const source = path.join(root, "pages");
    const list = path.join(root, "files");
    const receiptSource = path.join(root, "receipt");
    const receiptList = path.join(root, "receipt-files");
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await write(path.join(source, "index.html"), "first");
    await write(path.join(source, "nested/page.html"), "nested");
    await fs.writeFile(list, ".\0nested/\0index.html\0nested/page.html\0");
    await fs.writeFile(receiptList, `${RECEIPT}\0`);
    for (const file of sentinels) await write(path.join(receiver, file), "sentinel");
    const key = await fs.readFile(path.join(root, "client"), "utf8");
    const pr = {
        number: 123,
        state: "open",
        title: "Ready",
        draft: false,
        base: { ref: "main", repo: { full_name: context.repository } },
        head: { sha: context.sourceSha, repo: { full_name: context.repository } },
        labels: [{ name: "ci/preview" }],
    };
    const manifest = {
        schemaVersion: 2,
        mode: "pr",
        repository: context.repository,
        prNumber: 123,
        package: context.package,
        sourceSha: context.sourceSha,
        baseUrl: trusted.baseUrl,
        assetsOrigin: "https://cdn.internal.heroiclands.org",
        builtAt: "2026-01-01T00:00:00.000Z",
        pageCount: 2,
    };
    await withSshIdentity(key, async ({ temp, childEnv }) => {
        const transport = ssh(path.join(temp, "identity"));
        const send = (kind, from, files) =>
            runQuiet(
                "rsync",
                fixtureTarget(transferArguments(kind, from, files, transport, "thalorna", context)),
                { env: childEnv },
            );
        const readReceipt = (candidate) =>
            readPublicationReceipt(candidate, {
                context,
                fetchImpl: async (url) => {
                    assert.equal(url, trusted.baseUrl + RECEIPT);
                    try {
                        return new Response(await fs.readFile(path.join(destination, RECEIPT)), {
                            headers: { "content-type": "application/json" },
                        });
                    } catch (error) {
                        if (error.code === "ENOENT") return new Response(null, { status: 404 });
                        throw error;
                    }
                },
            });
        const publish = async (candidate, previous, index, corrupt = false) => {
            const receipt = receiptFor(
                candidate,
                index === "first" ? "2026-01-01T00:01:00.000Z" : "2026-01-01T00:02:00.000Z",
            );
            await write(path.join(receiptSource, RECEIPT), JSON.stringify(receipt));
            const receiptTime = new Date(receipt.publishedAt);
            await fs.utimes(path.join(receiptSource, RECEIPT), receiptTime, receiptTime);
            await publishPreviewValidated(candidate, context, {
                withLock: async (_name, fn) => fn(),
                loadPullRequest: async () => pr,
                send: async (kind) => {
                    if (kind === "www") return send("www", source, list);
                    assert.equal(kind, "receipt");
                    assert.equal(
                        await fs.readFile(path.join(destination, "nested/page.html"), "utf8"),
                        "nested",
                    );
                    assert.equal(
                        await fs.readFile(path.join(destination, "index.html"), "utf8"),
                        index,
                    );
                    if (previous === null) await absent(path.join(destination, RECEIPT));
                    else
                        assert.deepEqual(
                            JSON.parse(await fs.readFile(path.join(destination, RECEIPT), "utf8")),
                            previous,
                        );
                    if (index === "second") await absent(path.join(destination, "stale"));
                    await send("receipt", receiptSource, receiptList);
                    if (corrupt)
                        await write(
                            path.join(destination, RECEIPT),
                            JSON.stringify({ ...receipt, builtAt: "2025-01-01T00:00:00.000Z" }),
                        );
                },
                readReceipt: () => readReceipt(candidate),
            });
            assert.deepEqual(await readReceipt(candidate), receipt);
            return receipt;
        };
        const first = await publish(manifest, null, "first");
        await write(path.join(destination, "stale"), "stale");
        await write(path.join(source, "index.html"), "second");
        const secondManifest = { ...manifest, builtAt: "2026-01-01T00:01:00.000Z" };
        const second = await publish(secondManifest, first, "second");
        await assert.rejects(
            publish(secondManifest, second, "second", true),
            /completion receipt does not match candidate/,
        );
        await runQuiet("rsync", fixtureTarget(previewCleanupArguments(empty, transport, context)), {
            env: childEnv,
        });
        await absent(path.join(receiver, "www/pr/thalorna/123"));
        for (const file of sentinels)
            assert.equal(await fs.readFile(path.join(receiver, file), "utf8"), "sentinel");
    });

    const pidFile = path.join(root, "ssh.pid");
    await write(
        path.join(root, "ssh-wrapper"),
        '#!/bin/sh\npidfile=$1\nshift\nprintf "%s" "$$" > "$pidfile"\nexec "$@"\n',
    );
    await fs.chmod(path.join(root, "ssh-wrapper"), 0o700);
    await write(path.join(source, "large"), Buffer.alloc(4 * 1024 * 1024, 65));
    await fs.writeFile(list, ".\0large\0");
    const controller = new AbortController();
    let identityDirectory,
        receiptSent = false,
        success = false;
    await withSshIdentity(key, async ({ temp, childEnv }) => {
        identityDirectory = temp;
        const args = fixtureTarget(
            transferArguments(
                "www",
                source,
                list,
                ssh(path.join(temp, "identity"), pidFile),
                "thalorna",
                context,
            ),
        );
        args.unshift("--bwlimit=64");
        const operation = publishPreviewValidated(manifest, context, {
            withLock: async (_name, fn) => fn(),
            loadPullRequest: async () => pr,
            send: async (kind) => {
                if (kind === "receipt") {
                    receiptSent = true;
                    throw new Error("unexpected receipt");
                }
                await runQuiet("rsync", args, { env: childEnv, signal: controller.signal });
            },
            readReceipt: async () => {
                throw new Error("unexpected receipt read");
            },
        }).then(() => {
            success = true;
        });
        let pid;
        try {
            await waitFor(async () => {
                try {
                    const candidate = Number(await fs.readFile(pidFile, "utf8"));
                    const entries = await fs.readdir(destination);
                    return (
                        Number.isSafeInteger(candidate) &&
                        alive(candidate) &&
                        entries.some((name) => name.startsWith(".large."))
                    );
                } catch (error) {
                    if (error.code === "ENOENT") return false;
                    throw error;
                }
            });
            pid = Number(await fs.readFile(pidFile, "utf8"));
        } finally {
            controller.abort();
            await assert.rejects(operation, /cancelled/);
        }
        assert.equal(alive(pid), false, "SSH child must exit before identity cleanup");
        await fs.stat(path.join(temp, "identity"));
        assert.equal(receiptSent, false);
        assert.equal(success, false);
        await absent(path.join(destination, RECEIPT));
    });
    await absent(identityDirectory);
    for (const file of sentinels)
        assert.equal(await fs.readFile(path.join(receiver, file), "utf8"), "sentinel");
});
