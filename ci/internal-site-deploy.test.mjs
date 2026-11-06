/* SPDX-License-Identifier: GPL-3.0-or-later */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
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
                url.includes("/branches/")
                    ? { commit: { id: sourceSha } }
                    : { total_commits: 0, commits: [] },
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
                    response === "hidden"
                        ? new Response(null, { status: 404 })
                        : new Response(
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
                url.includes("/branches/main")
                    ? JSON.stringify({ commit: { id: sourceSha } })
                    : await fs.readFile(receiptPath),
                { headers: { "content-type": "application/json" } },
            ),
        run: async (command, suppliedArgs, options) => {
            assert.equal(command, "rsync");
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
                const transfer = withSshIdentity("fixture-key", async ({ temp }) => {
                    identityDir = temp;
                    return runQuiet(
                        process.execPath,
                        [worker, ready, terminated, path.join(temp, "identity")],
                        { signal: controller.signal, cancellationGraceMs: 500 },
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
