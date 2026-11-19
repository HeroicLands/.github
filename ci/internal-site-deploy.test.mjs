/* SPDX-License-Identifier: GPL-3.0-or-later */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    contextFor,
    currentPullRequest,
    previewEligible,
    previewLockName,
    previewRequested,
    publishPreviewValidated,
    cleanupClosedPreview,
    previewCleanupArguments,
    sendPreviewLocked,
    cleanupPreviewLocked,
    invalidateReopenedPreview,
    stagePreview,
    createManifest,
    validateArtifact,
    transferArguments,
    publishValidated,
    withSshIdentity,
    runCdn,
    prepareLock,
    currentMain,
    isCommitAncestor,
    readPublicationReceipt,
    receiptFor,
    runQuiet,
    runWithLock,
    sendPublication,
} from "../actions/internal-site-deploy/publish.mjs";

const sourceSha = "a".repeat(40);
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "internal-site-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "site/thalorna"), { recursive: true });
    await fs.writeFile(path.join(root, "site/_headers"), "/*\n  X-Test: true\n");
    await fs.writeFile(
        path.join(root, "site/thalorna/index.html"),
        "<main>Fixture homepage</main>",
    );
    await fs.writeFile(path.join(root, "site/thalorna/404.html"), "Missing page");
    const context = { package: "thalorna", sourceSha, minPages: 1, maxPages: 1 };
    const manifest = await createManifest(root, {
        ...context,
        builtAt: "2026-11-06T00:00:00.000Z",
    });
    await fs.writeFile(path.join(root, "publication.json"), JSON.stringify(manifest));
    return { root, context, manifest };
}

test("accepts a pages-only artifact with exact integrity and trusted context", async (t) => {
    const { root, context, manifest } = await fixture(t);
    assert.deepEqual(await validateArtifact(root, context), manifest);
});
for (const kind of [
    "digest",
    "extra",
    "symlink",
    "hardlink",
    "traversal",
    "sibling",
    "receipt",
    "context",
    "count",
    "empty-main",
]) {
    test(`rejects ${kind} before publication`, async (t) => {
        const { root, context, manifest } = await fixture(t);
        if (kind === "digest")
            await fs.appendFile(path.join(root, "site/thalorna/index.html"), "changed");
        if (kind === "extra") await fs.writeFile(path.join(root, "secret"), "extra");
        if (kind === "symlink")
            await fs.symlink("index.html", path.join(root, "site/thalorna/link"));
        if (kind === "hardlink")
            await fs.link(
                path.join(root, "site/thalorna/index.html"),
                path.join(root, "site/thalorna/link"),
            );
        if (kind === "traversal") manifest.files[0].key = "site/../outside";
        if (kind === "sibling") manifest.files[0].key = "site/sohl/index.html";
        if (kind === "receipt") manifest.files[0].key = "site/thalorna/.preview-publication.json";
        if (kind === "context") manifest.sourceSha = "b".repeat(40);
        if (kind === "count") manifest.pageCount = 2;
        if (kind === "empty-main") {
            await fs.writeFile(
                path.join(root, "site/thalorna/index.html"),
                "<main><!-- empty --></main>",
            );
            Object.assign(
                manifest,
                await createManifest(root, { ...context, builtAt: manifest.builtAt }),
            );
        }
        await fs.writeFile(path.join(root, "publication.json"), JSON.stringify(manifest));
        await assert.rejects(validateArtifact(root, context));
    });
}

test("rsync deletion is confined to the package and protects its receipt", () => {
    const args = transferArguments("www", "/source", "/list", "ssh", "thalorna");
    assert.ok(args.includes("--delete-delay"));
    assert.ok(args.includes("--exclude=/.preview-publication.json"));
    assert.equal(args.at(-1), "preview-publish@192.168.40.15:www/thalorna/");
    assert.ok(
        !transferArguments("receipt", "/source", "/list", "ssh", "thalorna").includes(
            "--delete-delay",
        ),
    );
    assert.throws(() => transferArguments("www", "/source", "/list", "ssh", "../sohl"));
});

test("page transfer precedes completion receipt under one lock", async () => {
    const calls = [];
    await publishValidated(
        { sourceSha },
        {
            withLock: async (fn) => {
                calls.push("lock");
                await fn();
                calls.push("unlock");
            },
            currentMain: async () => "b".repeat(40),
            readReceipt: async () => ({
                sourceSha: calls.includes("receipt") ? sourceSha : "0".repeat(40),
            }),
            isAncestor: async () => true,
            send: async (stage) => calls.push(stage),
        },
    );
    assert.deepEqual(calls, ["lock", "www", "receipt", "unlock"]);
});
for (const failure of ["older", "divergent-main", "www"]) {
    test(`${failure} cannot advance the receipt`, async () => {
        const calls = [];
        await assert.rejects(
            publishValidated(
                { sourceSha },
                {
                    withLock: async (fn) => fn(),
                    currentMain: async () => "b".repeat(40),
                    readReceipt: async () => ({ sourceSha: "c".repeat(40) }),
                    isAncestor: async (ancestor) =>
                        !(failure === "older" && ancestor === "c".repeat(40)) &&
                        failure !== "divergent-main",
                    send: async (stage) => {
                        calls.push(stage);
                        if (failure === "www") throw new Error("transfer failed");
                    },
                },
            ),
        );
        assert.ok(!calls.includes("receipt"));
    });
}

test("private pinned SSH files are removed after failure without forwarding secrets", async () => {
    let identityDir;
    await assert.rejects(
        withSshIdentity("fixture-private-key", async ({ ssh, childEnv, temp }) => {
            identityDir = temp;
            assert.equal(
                path.dirname(temp),
                path.join(os.homedir(), ".cache/heroiclands/preview-publish"),
            );
            assert.match(ssh, /^'\/usr\/bin\/ssh'/);
            assert.equal(childEnv.PATH, "/usr/bin:/bin");
            assert.equal((await fs.stat(temp)).mode & 0o777, 0o700);
            assert.equal((await fs.stat(path.join(temp, "identity"))).mode & 0o777, 0o600);
            assert.match(ssh, /StrictHostKeyChecking=yes/);
            assert.match(ssh, /'-F' '\/dev\/null'/);
            assert.match(ssh, /GlobalKnownHostsFile=\/dev\/null/);
            assert.match(ssh, /UserKnownHostsFile=/);
            assert.ok(!ssh.includes("fixture-private-key"));
            assert.deepEqual(Object.keys(childEnv).sort(), ["LANG", "PATH"]);
            throw new Error("fixture failure");
        }),
        /fixture failure/,
    );
    await assert.rejects(fs.stat(identityDir), { code: "ENOENT" });
});

test("shared adapter consumes artifacts, validates before credentials and retains release workflow", async () => {
    const { parse } = await import("yaml");
    const root = new URL("../", import.meta.url);
    const workflow = parse(
        await fs.readFile(new URL(".gitea/workflows/deploy-internal-site.yml", root), "utf8"),
    );
    assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
    assert.match(workflow.jobs.deploy.if, /refs\/heads\/main/);
    const steps = workflow.jobs.deploy.steps;
    const validation = steps.findIndex((step) => step.name.startsWith("Validate artifact"));
    const publish = steps.findIndex((step) => step.name.startsWith("Publish pages"));
    assert.ok(validation < publish);
    assert.equal(steps[validation].env, undefined);
    assert.match(steps[publish].env.PREVIEW_SSH_PRIVATE_KEY, /secrets.PREVIEW_SSH_PRIVATE_KEY/);
    assert.ok(steps.some((step) => step.uses?.startsWith("actions/download-artifact@")));
    assert.ok(steps.every((step) => !/npm|package-build|cdn publish/.test(step.run ?? "")));
    const publicWorkflow = await fs.readFile(
        new URL(".gitea/workflows/deploy-package-site.yml", root),
        "utf8",
    );
    assert.match(publicWorkflow, /cloudflare\/wrangler-action@/);
});

test("real rsync removes stale package files while preserving receipt and siblings", async (t) => {
    const { root } = await fixture(t);
    const destination = path.join(root, "remote/www/thalorna");
    await fs.mkdir(path.join(destination, "stale"), { recursive: true });
    await fs.mkdir(path.join(root, "remote/www/sohl"), { recursive: true });
    await fs.writeFile(path.join(destination, "stale/page.html"), "old");
    await fs.writeFile(path.join(destination, ".preview-publication.json"), "old receipt");
    await fs.writeFile(path.join(root, "remote/www/sohl/index.html"), "sibling");
    const list = path.join(root, "files.list");
    // Explicit parent '.' enables the same recursive deletion used by the sender.
    await fs.writeFile(list, [".", "index.html", "404.html"].join("\0") + "\0");
    const args = transferArguments(
        "www",
        path.join(root, "site/thalorna"),
        list,
        "ssh",
        "thalorna",
    );
    const sshAt = args.indexOf("-e");
    args.splice(sshAt, 2);
    args[args.length - 1] = destination + "/";
    await runQuiet("rsync", args);
    await assert.rejects(fs.stat(path.join(destination, "stale/page.html")), {
        code: "ENOENT",
    });
    assert.equal(
        await fs.readFile(path.join(destination, ".preview-publication.json"), "utf8"),
        "old receipt",
    );
    assert.equal(
        await fs.readFile(path.join(root, "remote/www/sohl/index.html"), "utf8"),
        "sibling",
    );
});

test("sender lock rejects a substituted symlink", async (t) => {
    const { root } = await fixture(t);
    const directory = path.join(os.homedir(), ".cache/heroiclands/preview-publish");
    const lock = path.join(directory, `fixture-${path.basename(root)}.lock`);
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink(path.join(root, "publication.json"), lock);
    t.after(() => fs.rm(lock, { force: true }));
    await assert.rejects(prepareLock(lock), /unsafe sender lock/);
});

test("current-main and ancestry use caller repository and direct comparison", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(url);
        return new Response(
            JSON.stringify(
                url.includes("/branches/") ?
                    { commit: { id: sourceSha } }
                :   { total_commits: 0, commits: [] },
            ),
            { headers: { "content-type": "application/json" } },
        );
    };
    assert.equal(await currentMain("HeroicLands/thalorna", "fixture", { fetchImpl }), sourceSha);
    assert.equal(
        await isCommitAncestor("HeroicLands/thalorna", "b".repeat(40), sourceSha, "fixture", {
            fetchImpl,
        }),
        true,
    );
    assert.ok(requests.every((url) => url.includes("/repos/HeroicLands/thalorna/")));
    assert.match(requests[1], new RegExp(`${sourceSha}\\.\\.${"b".repeat(40)}\\?`));
});

test("receipt response rejects invalid context and accepts the completion schema", async (t) => {
    const { manifest } = await fixture(t);
    const receipt = receiptFor(manifest, "2026-11-06T01:00:00.000Z");
    const response = (body) =>
        new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
        });
    assert.deepEqual(
        await readPublicationReceipt(manifest, {
            fetchImpl: async () => response(receipt),
        }),
        receipt,
    );
    await assert.rejects(
        readPublicationReceipt(manifest, {
            fetchImpl: async () => response({ ...receipt, package: "sohl" }),
        }),
    );
    await assert.rejects(
        readPublicationReceipt(manifest, {
            fetchImpl: async () => new Response("error", { status: 500 }),
        }),
    );
});

test("manual CDN dry-run has no key requirement or write setup; public passes only R2 secrets", async () => {
    const calls = [];
    const run = async (...args) => calls.push(args);
    const env = {
        PATH: process.env.PATH,
        SET: "extra.json",
        SET_NAME: "Extra art",
        DRY_RUN: "true",
        PREVIEW_SSH_PRIVATE_KEY: "never-forward",
        CDN_ACCESS_KEY_ID: "r2-id",
    };
    await runCdn({ env, run });
    assert.deepEqual(calls[0][1], [
        "cdn",
        "publish",
        "--dest",
        "internal",
        "--set",
        "extra.json",
        "--name",
        "Extra art",
        "--dry-run",
    ]);
    assert.equal(calls[0][2].env.PREVIEW_SSH_PRIVATE_KEY, undefined);
    assert.equal(calls[0][2].env.CDN_ACCESS_KEY_ID, undefined);
    await runCdn({
        env: { ...env, CDN_DEST: "cloudflare", DRY_RUN: "false" },
        run,
    });
    assert.equal(calls[1][2].env.CDN_ACCESS_KEY_ID, "r2-id");
    assert.equal(calls[1][2].env.PREVIEW_SSH_PRIVATE_KEY, undefined);
});

test("internal CDN alias uses pinned identity and cleans private shim after failure", async () => {
    let temp;
    await assert.rejects(
        runCdn({
            env: {
                PATH: process.env.PATH,
                SET: "extra.json",
                SET_NAME: "Extra",
                DRY_RUN: "false",
                PREVIEW_SSH_PRIVATE_KEY: "fixture-key",
            },
            run: async (command, args, options) => {
                temp = options.env.PATH.split(path.delimiter)[0];
                assert.equal(options.env.CDN_INTERNAL_DESTINATION, "heroiclands-internal:cdn");
                assert.equal(options.env.PREVIEW_SSH_PRIVATE_KEY, undefined);
                const config = await fs.readFile(path.join(temp, "ssh_config"), "utf8");
                assert.match(config, /HostName 192\.168\.40\.15/);
                assert.match(config, /StrictHostKeyChecking yes/);
                assert.match(config, /GlobalKnownHostsFile \/dev\/null/);
                assert.match(
                    await fs.readFile(path.join(temp, "ssh"), "utf8"),
                    /exec \/usr\/bin\/ssh -F/,
                );
                throw new Error("fixture transfer failed");
            },
        }),
        /fixture transfer failed/,
    );
    await assert.rejects(fs.stat(temp), { code: "ENOENT" });
});

test("manual CDN workflow selects destinations without automatic triggers or required R2 secrets", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(
        await fs.readFile(
            new URL("../.gitea/workflows/publish-package-cdn.yml", import.meta.url),
            "utf8",
        ),
    );
    assert.deepEqual(Object.keys(workflow.on).sort(), ["workflow_call", "workflow_dispatch"]);
    assert.equal(workflow.on.workflow_call.inputs.dest.default, "internal");
    assert.equal(workflow.on.workflow_dispatch.inputs.dest.default, "internal");
    for (const secret of Object.values(workflow.on.workflow_call.secrets))
        assert.equal(secret.required, false);
});

for (const response of ["hidden", "different-source"]) {
    test(`publication fails when completion receipt is ${response}`, async (t) => {
        const { manifest } = await fixture(t);
        const stages = [];
        const readReceipt = () =>
            readPublicationReceipt(manifest, {
                fetchImpl: async () =>
                    response === "hidden" ?
                        new Response(null, { status: 404 })
                    :   new Response(
                            JSON.stringify({
                                ...receiptFor(manifest),
                                sourceSha: "b".repeat(40),
                            }),
                            { headers: { "content-type": "application/json" } },
                        ),
            });
        await assert.rejects(
            publishValidated(manifest, {
                withLock: async (fn) => fn(),
                currentMain: async () => sourceSha,
                readReceipt,
                isAncestor: async () => true,
                send: async (stage) => stages.push(stage),
            }),
            /completion receipt/,
        );
        assert.deepEqual(stages, ["www", "receipt"]);
    });
}

test("empty auxiliary files retain their exact declared digest", async (t) => {
    const { root, context } = await fixture(t);
    await fs.writeFile(path.join(root, "site/thalorna/empty.txt"), "");
    const manifest = await createManifest(root, context);
    await fs.writeFile(path.join(root, "publication.json"), JSON.stringify(manifest));
    assert.equal(manifest.files.find((file) => file.key.endsWith("/empty.txt")).bytes, 0);
    assert.deepEqual(await validateArtifact(root, context), manifest);
});

test("actual sender deletes nested stale directories using its generated inventory", async (t) => {
    const { root, manifest } = await fixture(t);
    await fs.mkdir(path.join(root, "site/thalorna/images"));
    await fs.writeFile(path.join(root, "site/thalorna/images/current.txt"), "current");
    const destination = path.join(root, "remote/www/thalorna");
    await fs.mkdir(path.join(destination, "images/stale/deep"), { recursive: true });
    await fs.writeFile(path.join(destination, "images/stale/deep/old.txt"), "stale");
    const sibling = path.join(root, "remote/www/sohl/index.html");
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, "sibling");
    const receiptPath = path.join(destination, ".preview-publication.json");
    await fs.writeFile(receiptPath, JSON.stringify(receiptFor(manifest)));
    const inventories = [];
    await sendPublication(root, manifest, "HeroicLands/thalorna", undefined, {
        env: { GITEA_TOKEN: "fixture-token", PREVIEW_SSH_PRIVATE_KEY: "fixture-key" },
        fetchImpl: async (url) =>
            new Response(
                url.includes("/branches/main") ?
                    JSON.stringify({ commit: { id: sourceSha } })
                :   await fs.readFile(receiptPath),
                { headers: { "content-type": "application/json" } },
            ),
        run: async (command, suppliedArgs, options) => {
            assert.equal(command, "/usr/bin/rsync");
            const args = [...suppliedArgs];
            assert.equal(args.at(-1), "preview-publish@192.168.40.15:www/thalorna/");
            const list = args
                .find((arg) => arg.startsWith("--files-from="))
                .slice("--files-from=".length);
            inventories.push((await fs.readFile(list, "utf8")).split("\0").filter(Boolean));
            args.splice(args.indexOf("-e"), 2);
            args[args.length - 1] = destination + "/";
            await runQuiet(command, args, options);
        },
    });
    assert.ok(inventories[0].includes("."));
    assert.ok(inventories[0].includes("images/"));
    assert.ok(inventories[0].includes("images/current.txt"));
    assert.deepEqual(inventories[1], [".preview-publication.json"]);
    await assert.rejects(fs.stat(path.join(destination, "images/stale")), { code: "ENOENT" });
    assert.equal(
        await fs.readFile(path.join(destination, "images/current.txt"), "utf8"),
        "current",
    );
    assert.equal(await fs.readFile(sibling, "utf8"), "sibling");
    assert.equal(JSON.parse(await fs.readFile(receiptPath)).sourceSha, sourceSha);
});

async function waitForFile(file) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            return await fs.readFile(file, "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("fixture subprocess did not become ready");
}

for (const cancellation of ["abort", "SIGTERM"]) {
    test(
        `${cancellation} stops the transfer process group before removing its private key`,
        { timeout: 15000 },
        async (t) => {
            const { root } = await fixture(t);
            const ready = path.join(root, "transfer-ready.json");
            const terminated = path.join(root, "transfer-terminated.json");
            const identityState = path.join(root, "identity.json");
            const worker = path.join(root, "transfer.mjs");
            const descendantCode = `
                const fs = require('node:fs');
                const [ready, terminated, identity] = process.argv.slice(1);
                process.on('SIGTERM', () => {
                    fs.writeFileSync(terminated, JSON.stringify({keyPresent: fs.existsSync(identity), signal: 'SIGTERM'}));
                    process.exit(0);
                });
                fs.writeFileSync(ready, 'ready');
                setInterval(() => {}, 1000);
            `;
            await fs.writeFile(
                worker,
                `
            import fs from 'node:fs';
            import {spawn} from 'node:child_process';
            const [ready, terminated, identity] = process.argv.slice(2);
            const descendantReady = ready + '.descendant';
            const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}, descendantReady, terminated, identity], {stdio: 'ignore'});
            // Only the publisher can signal the descendant; the parent never relays.
            process.on('SIGTERM', () => {});
            descendant.once('exit', () => process.exit(0));
            const readiness = setInterval(() => {
                if (!fs.existsSync(descendantReady)) return;
                fs.writeFileSync(ready, JSON.stringify({pid: process.pid, descendant: descendant.pid}));
                clearInterval(readiness);
            }, 10);
            setInterval(() => {}, 1000);
        `,
            );
            let identityDir, transferPids;
            t.after(() => {
                // A mutation failure must not leave the independent descendant running.
                for (const pid of Object.values(transferPids ?? {})) {
                    try {
                        process.kill(pid, "SIGKILL");
                    } catch (error) {
                        if (error.code !== "ESRCH") throw error;
                    }
                }
            });
            if (cancellation === "abort") {
                const controller = new AbortController();
                const transfer = withSshIdentity("fixture-key", async ({ temp, ssh, childEnv }) => {
                    identityDir = temp;
                    assert.equal(
                        path.dirname(temp),
                        path.join(os.homedir(), ".cache/heroiclands/preview-publish"),
                    );
                    assert.match(ssh, /^'\/usr\/bin\/ssh'/);
                    assert.equal(childEnv.PATH, "/usr/bin:/bin");
                    return runQuiet(
                        process.execPath,
                        [worker, ready, terminated, path.join(temp, "identity")],
                        { env: childEnv, signal: controller.signal, cancellationGraceMs: 500 },
                    );
                });
                const rejected = assert.rejects(transfer, /publication cancelled/);
                transferPids = JSON.parse(await waitForFile(ready));
                controller.abort();
                await rejected;
            } else {
                const helper = new URL(
                    "../actions/internal-site-deploy/publish.mjs",
                    import.meta.url,
                ).href;
                const runner = path.join(root, "runner.mjs");
                await fs.writeFile(
                    runner,
                    `
                import fs from 'node:fs/promises';
                import path from 'node:path';
                import {withPublicationSignals, withSshIdentity, runQuiet} from ${JSON.stringify(helper)};
                withPublicationSignals(signal => withSshIdentity('fixture-key', async ({temp}) => {
                    await fs.writeFile(${JSON.stringify(identityState)}, JSON.stringify({temp}));
                    return runQuiet(process.execPath, ${JSON.stringify([worker, ready, terminated])}.concat(path.join(temp, 'identity')), {signal, cancellationGraceMs: 500});
                })).catch(() => { process.exitCode ||= 1; });
            `,
                );
                const child = spawn(process.execPath, [runner], { stdio: "ignore" });
                const completion = new Promise((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", (code, signal) => resolve({ code, signal }));
                });
                t.after(() => {
                    if (child.exitCode === null) child.kill("SIGKILL");
                });
                transferPids = JSON.parse(await waitForFile(ready));
                identityDir = JSON.parse(await fs.readFile(identityState, "utf8")).temp;
                child.kill("SIGTERM");
                assert.deepEqual(await completion, { code: 143, signal: null });
            }
            const pids = transferPids;
            assert.deepEqual(JSON.parse(await fs.readFile(terminated, "utf8")), {
                keyPresent: true,
                signal: "SIGTERM",
            });
            await assert.rejects(fs.stat(identityDir), { code: "ENOENT" });
            for (const pid of Object.values(pids))
                assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        },
    );
}

test("PR artifacts bind their closed schema to trusted context and normalized payload", async (t) => {
    const { root } = await fixture(t);
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
        minPages: 1,
        maxPages: 1,
    };
    const link = '<main><a href="/pr/thalorna/123/thalorna/">Home</a></main>';
    await fs.writeFile(path.join(root, "site/thalorna/index.html"), link);
    const manifest = await createManifest(root, context);
    const save = () => fs.writeFile(path.join(root, "publication.json"), JSON.stringify(manifest));
    await save();
    assert.deepEqual(await validateArtifact(root, context), manifest);
    assert.equal(await fs.readFile(path.join(root, "site/thalorna/index.html"), "utf8"), link);
    for (const [key, value] of Object.entries({
        repository: "HeroicLands/other",
        prNumber: 124,
        sourceSha: "b".repeat(40),
        baseUrl: "https://www.internal.heroiclands.org/thalorna/",
        extra: true,
    })) {
        const original = manifest[key];
        manifest[key] = value;
        await save();
        await assert.rejects(validateArtifact(root, context));
        if (original === undefined) delete manifest[key];
        else manifest[key] = original;
    }
    delete manifest.mode;
    await save();
    await assert.rejects(validateArtifact(root, context));
    await assert.rejects(validateArtifact(root, { package: "thalorna", sourceSha }));
});

test("PR identity and transfer destination reject substitutions", () => {
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    for (const change of [
        { repository: "other/thalorna" },
        { repository: "HeroicLands/.." },
        { repository: "HeroicLands/x%2fy" },
        { prNumber: "01" },
        { prNumber: "0" },
        { prNumber: "9007199254740992" },
        { sourceSha: "A".repeat(40) },
        { package: "../sohl" },
        { mode: "other" },
    ])
        assert.throws(() => contextFor({ ...context, ...change }));
    for (const kind of ["www", "receipt"]) {
        const args = transferArguments(kind, "/source", "/list", "ssh", "thalorna", context);
        assert.ok(args.includes("--mkpath"));
        assert.equal(args.at(-1), "preview-publish@192.168.40.15:www/pr/thalorna/123/thalorna/");
    }
    assert.ok(
        !transferArguments("www", "/source", "/list", "ssh", "thalorna").includes("--mkpath"),
    );
});

test("PR receipt readback binds every identity claim to the trusted context", async (t) => {
    const { root } = await fixture(t);
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const manifest = await createManifest(root, context);
    const receipt = receiptFor(manifest);
    const fetchImpl = async (url) => {
        assert.equal(url, manifest.baseUrl + ".preview-publication.json");
        return new Response(JSON.stringify(receipt), {
            headers: { "content-type": "application/json" },
        });
    };
    assert.deepEqual(await readPublicationReceipt(manifest, { context, fetchImpl }), receipt);
    for (const [key, value] of Object.entries({
        repository: "HeroicLands/other",
        prNumber: 124,
        sourceSha: "b".repeat(40),
        baseUrl: "https://example.org/",
        extra: true,
    })) {
        const original = receipt[key];
        receipt[key] = value;
        await assert.rejects(readPublicationReceipt(manifest, { context, fetchImpl }));
        if (original === undefined) delete receipt[key];
        else receipt[key] = original;
    }
    await assert.rejects(
        readPublicationReceipt(
            { ...manifest, baseUrl: "https://example.org/" },
            { context, fetchImpl },
        ),
    );
});

test("local rsync creates a nested PR destination and preserves other namespaces", async (t) => {
    const { root } = await fixture(t);
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const remote = path.join(root, "remote");
    for (const file of [
        "www/thalorna/index.html",
        "www/pr/thalorna/124/thalorna/index.html",
        "cdn/sentinel",
    ]) {
        await fs.mkdir(path.dirname(path.join(remote, file)), { recursive: true });
        await fs.writeFile(path.join(remote, file), "sentinel");
    }
    const destination = path.join(remote, "www/pr/thalorna/123/thalorna");
    const list = path.join(root, "pr.list");
    await fs.writeFile(list, [".", "index.html", "404.html"].join("\0") + "\0");
    const args = transferArguments(
        "www",
        path.join(root, "site/thalorna"),
        list,
        "ssh",
        "thalorna",
        context,
    );
    args.splice(args.indexOf("-e"), 2);
    args[args.length - 1] = destination + "/";
    await runQuiet("rsync", args);
    await fs.writeFile(path.join(destination, "stale"), "old");
    await fs.writeFile(path.join(destination, ".preview-publication.json"), "receipt");
    await runQuiet("rsync", args);
    await assert.rejects(fs.stat(path.join(destination, "stale")), { code: "ENOENT" });
    assert.equal(
        await fs.readFile(path.join(destination, ".preview-publication.json"), "utf8"),
        "receipt",
    );
    for (const file of [
        "www/thalorna/index.html",
        "www/pr/thalorna/124/thalorna/index.html",
        "cdn/sentinel",
    ])
        assert.equal(await fs.readFile(path.join(remote, file), "utf8"), "sentinel");
});

test("stages the generated nested PR tree without changing its links", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-stage-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const generated = path.join(root, "build/site");
    const nested = path.join(generated, "pr/thalorna/123/thalorna");
    const artifact = path.join(root, "publication");
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    await fs.mkdir(nested, { recursive: true });
    const html = '<main><a href="/pr/thalorna/123/thalorna/guide/">Guide</a></main>';
    await fs.writeFile(path.join(generated, "_headers"), "headers");
    await fs.writeFile(path.join(nested, "index.html"), html);
    await fs.writeFile(path.join(nested, "404.html"), "missing");
    const manifest = await stagePreview(generated, artifact, context);
    assert.equal(
        manifest.baseUrl,
        "https://www.internal.heroiclands.org/pr/thalorna/123/thalorna/",
    );
    assert.equal(await fs.readFile(path.join(artifact, "site/thalorna/index.html"), "utf8"), html);
    assert.equal(await fs.readFile(path.join(artifact, "site/_headers"), "utf8"), "headers");
    assert.deepEqual(await validateArtifact(artifact, context), manifest);
    await assert.rejects(validateArtifact(artifact, { package: "thalorna", sourceSha }));
    await assert.rejects(fs.stat(path.join(artifact, "site/pr")), { code: "ENOENT" });
});

for (const problem of [
    "missing",
    "main",
    "sibling",
    "empty-directory",
    "symlink",
    "overlap",
    "occupied",
    "empty-home",
    "bounds",
]) {
    test(`preview staging rejects ${problem}`, async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-stage-bad-"));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const generated = path.join(root, "build/site");
        const nested = path.join(generated, "pr/thalorna/123/thalorna");
        let artifact = path.join(root, "publication");
        const context = {
            mode: "pr",
            repository: "HeroicLands/thalorna",
            prNumber: "123",
            package: "thalorna",
            sourceSha,
        };
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(generated, "_headers"), "headers");
        await fs.writeFile(path.join(nested, "index.html"), "<main>home</main>");
        if (problem !== "missing") await fs.writeFile(path.join(nested, "404.html"), "missing");
        if (problem === "empty-home")
            await fs.writeFile(path.join(nested, "index.html"), "<main><!-- empty --></main>");
        if (problem === "bounds") context.minPages = 2;
        if (problem === "main") {
            await fs.mkdir(path.join(generated, "thalorna"));
            await fs.writeFile(path.join(generated, "thalorna/index.html"), "main");
        }
        if (problem === "sibling") {
            await fs.mkdir(path.join(generated, "pr/thalorna/124"));
            await fs.writeFile(path.join(generated, "pr/thalorna/124/other"), "sibling");
        }
        if (problem === "empty-directory") await fs.mkdir(path.join(generated, "extra"));
        if (problem === "symlink") await fs.symlink("index.html", path.join(nested, "link"));
        if (problem === "overlap") artifact = path.join(generated, "output");
        if (problem === "occupied") {
            await fs.mkdir(artifact);
            await fs.writeFile(path.join(artifact, "sentinel"), "untouched");
        }
        await assert.rejects(stagePreview(generated, artifact, context));
        if (problem === "occupied")
            assert.equal(await fs.readFile(path.join(artifact, "sentinel"), "utf8"), "untouched");
    });
}

test("CLI help describes commands without an artifact or credentials", () => {
    const result = spawnSync(
        process.execPath,
        [
            fileURLToPath(new URL("../actions/internal-site-deploy/publish.mjs", import.meta.url)),
            "--help",
        ],
        {
            cwd: os.tmpdir(),
            env: { PATH: process.env.PATH },
            encoding: "utf8",
        },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /stage <generated-root> \[artifact-root\]/);
    assert.match(result.stdout, /artifact root defaults to publication/);
    assert.match(result.stdout, /PUBLICATION_MODE=pr/);
    assert.match(result.stdout, /MIN_PAGES defaults to 1; MAX_PAGES defaults to 0/);
    assert.match(result.stdout, /preview-check, preview-reopen: GITEA_TOKEN/);
    assert.match(
        result.stdout,
        /preview-publish, preview-cleanup: GITEA_TOKEN and\n    PREVIEW_SSH_PRIVATE_KEY/,
    );
    assert.match(result.stdout, /stage, manifest, validate: none/);
    for (const command of ["manifest", "validate", "publish", "locked", "cdn"])
        assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
});

test("authoritative PR state binds eligibility to the repository and exact open head", async () => {
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const pr = {
        number: 123,
        state: "open",
        title: "Ready",
        draft: false,
        base: { ref: "main", repo: { full_name: context.repository } },
        head: { sha: sourceSha, repo: { full_name: context.repository } },
        labels: [{ name: "ci/preview" }],
    };
    const fetchImpl = async (url, options) => {
        assert.equal(url, "https://git.pupluppy.org/api/v1/repos/HeroicLands/thalorna/pulls/123");
        assert.equal(options.redirect, "error");
        return new Response(JSON.stringify(pr), {
            headers: { "content-type": "application/json" },
        });
    };
    const current = await currentPullRequest(context, "fixture-token", { fetchImpl });
    assert.equal(previewEligible(current, context), true);
    for (const change of [
        { base: { ...pr.base, ref: "other" } },
        { state: "closed" },
        { draft: true },
        { title: "WIP: Draft" },
        { labels: [] },
        { head: { ...pr.head, sha: "b".repeat(40) } },
    ])
        assert.equal(previewEligible({ ...current, ...change }, context), false);
    for (const change of [
        { number: 124 },
        { base: { ...pr.base, repo: { full_name: "HeroicLands/other" } } },
        { head: { ...pr.head, repo: { full_name: "fork/thalorna" } } },
        { labels: null },
        { draft: null },
    ]) {
        const fetchBad = async () =>
            new Response(JSON.stringify({ ...pr, ...change }), {
                headers: { "content-type": "application/json" },
            });
        await assert.rejects(currentPullRequest(context, "fixture-token", { fetchImpl: fetchBad }));
    }
    assert.equal(previewLockName(context), previewLockName({ ...context, package: "sohl" }));
    assert.notEqual(previewLockName(context), previewLockName({ ...context, prNumber: "124" }));
});

test("native PR event selection distinguishes label addition and removal", () => {
    assert.equal(
        previewRequested("label_updated", { added_labels: [{ name: "ci/preview" }] }),
        true,
    );
    assert.equal(
        previewRequested("label_updated", { removed_labels: [{ name: "ci/preview" }] }),
        false,
    );
    assert.equal(previewRequested("synchronized"), true);
    assert.equal(previewRequested("reopened"), true);
    assert.equal(previewRequested("closed"), false);
});

test("publication and close cleanup recheck PR state under the same lock", async () => {
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const manifest = {
        schemaVersion: 2,
        mode: "pr",
        repository: context.repository,
        prNumber: 123,
        package: context.package,
        sourceSha,
        baseUrl: "https://www.internal.heroiclands.org/pr/thalorna/123/thalorna/",
        assetsOrigin: "https://cdn.internal.heroiclands.org",
        builtAt: "2026-11-06T00:00:00.000Z",
        pageCount: 1,
    };
    const pr = {
        number: 123,
        state: "open",
        title: "Ready",
        draft: false,
        base: { ref: "main", repo: { full_name: context.repository } },
        head: { sha: sourceSha, repo: { full_name: context.repository } },
        labels: [{ name: "ci/preview" }],
    };
    const calls = [];
    const deps = {
        withLock: async (name, fn) => {
            calls.push(name);
            return fn();
        },
        loadPullRequest: async () => {
            calls.push("lookup");
            return pr;
        },
        send: async (kind) => calls.push(kind),
        readReceipt: async () => ({ ...manifest, publishedAt: "2026-11-06T01:00:00.000Z" }),
        remove: async () => calls.push("delete"),
    };
    await publishPreviewValidated(manifest, context, deps);
    assert.deepEqual(calls, [previewLockName(context), "lookup", "www", "receipt"]);
    calls.length = 0;
    assert.equal(await cleanupClosedPreview(context, deps), false);
    assert.deepEqual(calls, [previewLockName(context), "lookup"]);
    calls.length = 0;
    await assert.rejects(
        publishPreviewValidated({ ...manifest, repository: "HeroicLands/other" }, context, deps),
    );
    assert.deepEqual(calls, []);
    await assert.rejects(
        publishPreviewValidated(manifest, context, {
            ...deps,
            readReceipt: async () => ({
                ...manifest,
                sourceSha: "c".repeat(40),
                publishedAt: "2026-11-06T01:00:00.000Z",
            }),
        }),
    );
    calls.length = 0;
    pr.state = "closed";
    pr.base.ref = "other";
    await assert.rejects(publishPreviewValidated(manifest, context, deps));
    assert.ok(!calls.includes("www"));
    calls.length = 0;
    assert.equal(await cleanupClosedPreview(context, deps), true);
    assert.deepEqual(calls, [previewLockName(context), "lookup", "delete"]);
    calls.length = 0;
    pr.state = "open";
    pr.head.sha = "b".repeat(40);
    await assert.rejects(publishPreviewValidated(manifest, context, deps));
    assert.equal(await cleanupClosedPreview(context, deps), false);
    assert.ok(!calls.includes("www") && !calls.includes("delete"));
});

test("local rsync cleanup removes only the selected PR subtree", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-cleanup-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const source = path.join(root, "empty");
    const remote = path.join(root, "remote");
    await fs.mkdir(source);
    for (const file of [
        "www/pr/thalorna/123/thalorna/index.html",
        "www/pr/thalorna/124/thalorna/index.html",
        "www/thalorna/index.html",
        "cdn/sentinel",
    ]) {
        await fs.mkdir(path.dirname(path.join(remote, file)), { recursive: true });
        await fs.writeFile(path.join(remote, file), "sentinel");
    }
    const args = previewCleanupArguments(source, "ssh", context);
    assert.equal(args.at(-1), "preview-publish@192.168.40.15:www/pr/thalorna/");
    args.splice(args.indexOf("-e"), 2);
    args[args.length - 1] = path.join(remote, "www/pr/thalorna") + "/";
    await runQuiet("rsync", args);
    await assert.rejects(fs.stat(path.join(remote, "www/pr/thalorna/123")), { code: "ENOENT" });
    for (const file of [
        "www/pr/thalorna/124/thalorna/index.html",
        "www/thalorna/index.html",
        "cdn/sentinel",
    ])
        assert.equal(await fs.readFile(path.join(remote, file), "utf8"), "sentinel");
});

test("trusted preview sender transfers pages and receipt before exact-head status", async (t) => {
    const { root } = await fixture(t);
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const manifest = await createManifest(root, context);
    const pr = {
        number: 123,
        state: "open",
        title: "Ready",
        draft: false,
        base: { ref: "main", repo: { full_name: context.repository } },
        head: { sha: sourceSha, repo: { full_name: context.repository } },
        labels: [{ name: "ci/preview" }],
    };
    const events = [];
    const fetchImpl = async (url, options) => {
        if (url.includes("/pulls/"))
            return new Response(JSON.stringify(pr), {
                headers: { "content-type": "application/json" },
            });
        if (url.includes("/statuses?"))
            return new Response("[]", {
                headers: { "content-type": "application/json", "x-total-count": "0" },
            });
        if (url.includes("/statuses/")) {
            const status = JSON.parse(options.body);
            assert.equal(status.target_url, manifest.baseUrl);
            assert.match(url, new RegExp(sourceSha + "$"));
            events.push("status");
            return new Response("{}", { status: 201 });
        }
        assert.equal(url, manifest.baseUrl + ".preview-publication.json");
        return new Response(JSON.stringify(receiptFor(manifest)), {
            headers: { "content-type": "application/json" },
        });
    };
    const run = async (command, args, options) => {
        assert.equal(command, "/usr/bin/rsync");
        assert.equal(args.at(-1), "preview-publish@192.168.40.15:www/pr/thalorna/123/thalorna/");
        assert.ok(args.includes("--mkpath"));
        assert.equal(options.env.GITEA_TOKEN, undefined);
        assert.equal(options.env.PREVIEW_SSH_PRIVATE_KEY, undefined);
        events.push(args.includes("--delete-delay") ? "www" : "receipt");
    };
    await sendPreviewLocked(root, manifest, context, undefined, {
        env: { GITEA_TOKEN: "fixture", PREVIEW_SSH_PRIVATE_KEY: "fixture key" },
        fetchImpl,
        run,
    });
    assert.deepEqual(events, ["www", "receipt", "status"]);
    events.length = 0;
    pr.state = "closed";
    await assert.rejects(
        sendPreviewLocked(root, manifest, context, undefined, {
            env: { GITEA_TOKEN: "fixture", PREVIEW_SSH_PRIVATE_KEY: "fixture key" },
            fetchImpl,
            run,
        }),
    );
    assert.deepEqual(events, []);
    pr.state = "open";
    assert.equal(
        await cleanupPreviewLocked(context, undefined, {
            env: { GITEA_TOKEN: "fixture", PREVIEW_SSH_PRIVATE_KEY: "fixture key" },
            fetchImpl,
            run,
        }),
        false,
    );
    pr.state = "closed";
    let cleanupArgs;
    assert.equal(
        await cleanupPreviewLocked(context, undefined, {
            env: { GITEA_TOKEN: "fixture", PREVIEW_SSH_PRIVATE_KEY: "fixture key" },
            fetchImpl,
            run: async (_command, args, options) => {
                cleanupArgs = args;
                assert.equal(options.env.GITEA_TOKEN, undefined);
                assert.equal(options.env.PREVIEW_SSH_PRIVATE_KEY, undefined);
            },
        }),
        true,
    );
    assert.equal(cleanupArgs.at(-1), "preview-publish@192.168.40.15:www/pr/thalorna/");
    assert.ok(cleanupArgs.includes("--filter=R /123"));
});

test("preview workflows keep PR build steps separate from declared publication credentials", async () => {
    const { parse } = await import("yaml");
    const build = parse(
        await fs.readFile(
            new URL("../.gitea/workflows/build-internal-preview.yml", import.meta.url),
            "utf8",
        ),
    );
    const deploy = parse(
        await fs.readFile(
            new URL("../.gitea/workflows/deploy-internal-preview.yml", import.meta.url),
            "utf8",
        ),
    );
    assert.equal(build.on.workflow_call.secrets, undefined);
    assert.equal(build.permissions.contents, "read");
    assert.equal(build.jobs.build["runs-on"], "ubuntu-vm");
    assert.equal(build.jobs.build["timeout-minutes"], 30);
    assert.equal(
        build.jobs.build.container.image,
        "git.pupluppy.org/heroiclands/ci-job@sha256:e07e93044b9bd0c49ff8dc51fc9f21772bf1d42e889b211663f3a51514ab85e5",
    );
    assert.equal(build.jobs.build.container.options, "--memory=4g --memory-swap=4g");
    const buildSteps = build.jobs.build.steps;
    const check = buildSteps.findIndex((step) => step.name === "Check authoritative PR state");
    const checkout = buildSteps.findIndex((step) => step.name === "Checkout immutable PR head");
    const verify = buildSteps.findIndex((step) => step.name === "Verify checkout");
    const install = buildSteps.findIndex((step) => step.name === "Install and build");
    assert.ok(check < checkout && checkout < verify && verify < install);
    assert.equal(buildSteps[checkout].with["persist-credentials"], false);
    assert.equal(buildSteps[checkout].with.ref, "${{ inputs.source-sha }}");
    assert.ok(
        buildSteps.every((step) => !JSON.stringify(step).includes("PREVIEW_SSH_PRIVATE_KEY")),
    );
    assert.equal(buildSteps[install].env.NODE_OPTIONS, "--max-old-space-size=3072");
    const memory = buildSteps.findIndex((step) => step.name === "Verify build memory limit");
    assert.ok(memory >= 0 && memory < check);
    assert.match(buildSteps[memory].run, /memory\.max\)" = 4294967296/);
    assert.match(buildSteps[memory].run, /memory\.swap\.max\)" = 0/);
    const steps = deploy.jobs.deploy.steps;
    const validate = steps.findIndex(
        (step) => step.name === "Validate pages before deployment credentials",
    );
    const publish = steps.findIndex((step) => step.name === "Publish or clean under the PR lock");
    assert.ok(validate < publish);
    assert.ok(
        steps
            .slice(0, publish)
            .every((step) => !JSON.stringify(step).includes("PREVIEW_SSH_PRIVATE_KEY")),
    );
    const reopen = steps.find((step) => step.name === "Invalidate reopened PR evidence");
    assert.match(reopen.run, /preview-reopen/);
    assert.equal(reopen.env.PREVIEW_SSH_PRIVATE_KEY, undefined);
    assert.match(steps[publish].run, /preview-cleanup/);
    assert.match(steps[publish].run, /preview-publish/);
});

test("close invalidates every package status before deletion and same-head reopen", async (t) => {
    const { root } = await fixture(t);
    const context = {
        mode: "pr",
        repository: "HeroicLands/thalorna",
        prNumber: "123",
        package: "thalorna",
        sourceSha,
    };
    const manifest = await createManifest(root, context);
    const pr = {
        number: 123,
        state: "open",
        title: "Ready",
        draft: false,
        base: { ref: "main", repo: { full_name: context.repository } },
        head: { sha: sourceSha, repo: { full_name: context.repository } },
        labels: [{ name: "ci/preview" }],
    };
    const states = new Map([
        ["preview/sohl/pr-123", "success"],
        ["preview/sohl/pr-124", "success"],
    ]);
    const events = [];
    let failStatus = false;
    const fetchImpl = async (url, options) => {
        if (url.includes("/pulls/"))
            return new Response(JSON.stringify(pr), {
                headers: { "content-type": "application/json" },
            });
        if (url.includes("/statuses?")) {
            const list = [...states].map(([name, status]) => ({ context: name, status }));
            return new Response(JSON.stringify(list), {
                headers: {
                    "content-type": "application/json",
                    "x-total-count": String(list.length),
                },
            });
        }
        if (url.includes("/statuses/")) {
            const status = JSON.parse(options.body);
            events.push(`${status.context}:${status.state}`);
            if (failStatus) return new Response("{}", { status: 403 });
            states.set(status.context, status.state);
            return new Response("{}", { status: 201 });
        }
        return new Response(JSON.stringify(receiptFor(manifest)), {
            headers: { "content-type": "application/json" },
        });
    };
    const env = { GITEA_TOKEN: "fixture", PREVIEW_SSH_PRIVATE_KEY: "fixture key" };
    const run = async (_command, args) =>
        events.push(args.some((arg) => arg.startsWith("--filter=R")) ? "delete" : "transfer");
    await sendPreviewLocked(root, manifest, context, undefined, { env, fetchImpl, run });
    assert.equal(states.get("preview/thalorna/pr-123"), "success");
    pr.labels = [];
    pr.state = "closed";
    events.length = 0;
    failStatus = true;
    await assert.rejects(cleanupPreviewLocked(context, undefined, { env, fetchImpl, run }));
    assert.ok(!events.includes("delete"));
    failStatus = false;
    events.length = 0;
    await cleanupPreviewLocked(context, undefined, { env, fetchImpl, run });
    assert.equal(states.get("preview/thalorna/pr-123"), "error");
    assert.equal(states.get("preview/sohl/pr-123"), "error");
    assert.equal(states.get("preview/sohl/pr-124"), "success");
    assert.equal(events.at(-1), "delete");
    pr.state = "open";
    assert.equal(previewEligible(pr, context), false);
    assert.equal(states.get("preview/thalorna/pr-123"), "error");
    states.set("preview/thalorna/pr-123", "success");
    assert.equal(
        await invalidateReopenedPreview(context, undefined, {
            env: { GITEA_TOKEN: "fixture" },
            fetchImpl,
        }),
        true,
    );
    assert.equal(states.get("preview/thalorna/pr-123"), "error");
    assert.equal(states.get("preview/sohl/pr-124"), "success");
});

test(
    "real flock serializes publisher commands and releases a cancelled holder",
    { timeout: 15000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-flock-"));
        const lock = path.join(
            os.homedir(),
            ".cache/heroiclands/preview-publish",
            `${path.basename(root)}.lock`,
        );
        const held = path.join(root, "held");
        const entered = path.join(root, "entered");
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        t.after(() => fs.rm(lock, { force: true }));
        const controller = new AbortController();
        const holder = runWithLock(
            lock,
            process.execPath,
            [
                "-e",
                `require('node:fs').writeFileSync(${JSON.stringify(held)}, 'held'); setInterval(() => {}, 1000)`,
            ],
            { signal: controller.signal },
        );
        const rejected = assert.rejects(holder, /cancelled/);
        try {
            const deadline = Date.now() + 5000;
            while (!(await fs.stat(held).catch(() => null))) {
                assert.ok(Date.now() < deadline, "holder must acquire the real lock");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const blocked = spawnSync("/usr/bin/flock", [
                "--nonblock",
                lock,
                process.execPath,
                "-e",
                `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'entered')`,
            ]);
            assert.equal(blocked.status, 1);
            assert.equal(await fs.stat(entered).catch(() => null), null);
            const queued = runWithLock(lock, process.execPath, [
                "-e",
                `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'entered')`,
            ]);
            controller.abort();
            await rejected;
            await queued;
            assert.equal(await fs.readFile(entered, "utf8"), "entered");
        } finally {
            controller.abort();
            await rejected;
        }
    },
);
