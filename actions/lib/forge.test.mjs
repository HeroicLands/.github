/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError, forgeOf, readAll, send } from "./forge.mjs";
import { FORGE_ENV, pagedFetch } from "./fake-forge.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const items = (n) => Array.from({ length: n }, (_, i) => ({ n: i }));

test("the API base comes from the environment and defaults to GitHub's", () => {
    assert.equal(forgeOf({}).api, "https://api.github.com");
    assert.equal(forgeOf({}).github, true);
    const gitea = forgeOf(FORGE_ENV.gitea);
    assert.equal(gitea.api, "http://atlas.pupluppy.internal:3080/api/v1");
    assert.equal(gitea.github, false);
    assert.equal(forgeOf({ GITHUB_API_URL: "http://x/api/v1/" }).api, "http://x/api/v1");
});

test("GITEA_ACTIONS does not decide which forge this is", () => {
    assert.equal(forgeOf({ GITEA_ACTIONS: "true" }).github, true);
    assert.equal(forgeOf({ ...FORGE_ENV.gitea, GITEA_ACTIONS: "" }).github, false);
});

test("a bearer token is sent on both forges, GitHub's version header only to GitHub", () => {
    const github = forgeOf(FORGE_ENV.github).headers("t");
    const gitea = forgeOf(FORGE_ENV.gitea).headers("t");
    assert.equal(github.Authorization, "Bearer t");
    assert.equal(gitea.Authorization, "Bearer t");
    assert.ok(github["X-GitHub-Api-Version"]);
    assert.equal(gitea["X-GitHub-Api-Version"], undefined);
});

for (const style of ["github", "gitea"]) {
    for (const count of [0, 1, 50, 60, 100, 101, 230]) {
        test(`reads all ${count} items from a ${style} list`, async () => {
            globalThis.fetch = pagedFetch({ "/things": items(count) }, style);
            const got = await readAll(forgeOf(FORGE_ENV[style]), "/things", "t");
            assert.equal(got.length, count);
            assert.deepEqual(
                got.map((x) => x.n),
                items(count).map((x) => x.n),
            );
        });
    }
}

test("a forge that sends no total and no links is read to an empty page", async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
        calls++;
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(JSON.stringify(items(120).slice((page - 1) * 50, page * 50)));
    };
    assert.equal((await readAll(forgeOf({}), "/things", "t")).length, 120);
    assert.equal(calls, 4);
});

test("the requests go to the environment's API base", async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
        seen.push(String(url));
        return new Response("[]");
    };
    await readAll(forgeOf(FORGE_ENV.gitea), "/repos/o/r/labels", "t");
    assert.match(
        seen[0],
        /^http:\/\/atlas\.pupluppy\.internal:3080\/api\/v1\/repos\/o\/r\/labels\?/,
    );
});

test("a failed page throws rather than returning a partial list", async () => {
    globalThis.fetch = async (url) =>
        Number(new URL(url).searchParams.get("page")) === 1
            ? new Response(JSON.stringify(items(100)), {
                  headers: { Link: '<x>; rel="next"' },
              })
            : new Response("Forbidden", { status: 403 });
    await assert.rejects(
        readAll(forgeOf({}), "/things", "t"),
        (e) => e instanceof ApiError && e.status === 403,
    );
});

/** An error shaped like undici's interrupted-connection failure. */
function interrupted(code = "UND_ERR_SOCKET") {
    const cause = Object.assign(new Error("other side closed"), { code });
    return new TypeError("fetch failed", { cause });
}

/** A fetch that plays the given outcomes in order, then serves an empty list. */
function scripted(outcomes) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response("[]");
    };
    return { fetch, calls };
}

/** A final page that carries its own total, so the read ends there. */
function listOf(n) {
    return new Response(JSON.stringify(items(n)), {
        headers: { "X-Total-Count": String(n) },
    });
}

function sleeper() {
    const waits = [];
    return { waits, sleep: async (ms) => void waits.push(ms) };
}

test("a read succeeds after one interrupted connection", async () => {
    const { fetch, calls } = scripted([interrupted(), listOf(2)]);
    const { waits, sleep } = sleeper();
    const got = await readAll(forgeOf({}), "/things", "t", { fetch, sleep });
    assert.equal(got.length, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [250]);
});

test("a read succeeds after two interruptions and a 503", async () => {
    const { fetch, calls } = scripted([
        interrupted("ECONNRESET"),
        new Response("busy", { status: 503 }),
        interrupted("EAI_AGAIN"),
        listOf(1),
    ]);
    const { waits, sleep } = sleeper();
    const got = await readAll(forgeOf({}), "/things", "t", { fetch, sleep });
    assert.equal(got.length, 1);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [250, 500, 1000]);
});

test("a read that stays interrupted fails naming the request and the cause", async () => {
    const { fetch, calls } = scripted([
        interrupted(),
        interrupted(),
        interrupted(),
        interrupted(),
        interrupted(),
    ]);
    const { waits, sleep } = sleeper();
    await assert.rejects(
        readAll(forgeOf({}), "/repos/o/r/pulls", "t", { fetch, sleep }),
        (e) =>
            /GET \/repos\/o\/r\/pulls failed after 4 attempts: UND_ERR_SOCKET: other side closed/.test(
                e.message,
            ) && e.cause instanceof TypeError,
    );
    assert.equal(calls.length, 4);
    assert.equal(
        waits.reduce((a, b) => a + b, 0),
        1750,
    );
});

test("a read that stays unavailable fails with the status", async () => {
    const { fetch, calls } = scripted(
        [502, 504, 503, 502].map((status) => new Response("down", { status })),
    );
    const { sleep } = sleeper();
    await assert.rejects(
        readAll(forgeOf({}), "/things", "t", { fetch, sleep }),
        (e) => e instanceof ApiError && e.status === 502,
    );
    assert.equal(calls.length, 4);
});

test("an interruption on a later page does not return a partial list", async () => {
    const { fetch } = scripted([
        new Response(JSON.stringify(items(100)), {
            headers: { Link: '<x>; rel="next"' },
        }),
        interrupted(),
        interrupted(),
        interrupted(),
        interrupted(),
    ]);
    const { sleep } = sleeper();
    await assert.rejects(
        readAll(forgeOf({}), "/things", "t", { fetch, sleep }),
        /failed after 4 attempts/,
    );
});

test("a 404 is not retried", async () => {
    const { fetch, calls } = scripted([new Response("missing", { status: 404 })]);
    const { waits, sleep } = sleeper();
    await assert.rejects(
        readAll(forgeOf({}), "/things", "t", { fetch, sleep }),
        (e) => e instanceof ApiError && e.status === 404,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
});

test("an error with no transient cause is not retried", async () => {
    const { fetch, calls } = scripted([new TypeError("invalid url")]);
    const { sleep } = sleeper();
    await assert.rejects(readAll(forgeOf({}), "/things", "t", { fetch, sleep }), /invalid url/);
    assert.equal(calls.length, 1);
});

test("a POST is not retried after an interruption", async () => {
    const { fetch, calls } = scripted([interrupted(), new Response("{}")]);
    await assert.rejects(
        send(forgeOf({}), "POST", "/things", "t", { a: 1 }, { fetch }),
        /fetch failed/,
    );
    assert.equal(calls.length, 1);
});
