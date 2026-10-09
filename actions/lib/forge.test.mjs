/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError, forgeOf, readAll } from "./forge.mjs";
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
            assert.deepEqual(got.map((x) => x.n), items(count).map((x) => x.n));
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
    assert.match(seen[0], /^http:\/\/atlas\.pupluppy\.internal:3080\/api\/v1\/repos\/o\/r\/labels\?/);
});

test("a failed page throws rather than returning a partial list", async () => {
    globalThis.fetch = async (url) =>
        Number(new URL(url).searchParams.get("page")) === 1
            ? new Response(JSON.stringify(items(100)), { headers: { Link: '<x>; rel="next"' } })
            : new Response("Forbidden", { status: 403 });
    await assert.rejects(readAll(forgeOf({}), "/things", "t"), (e) => e instanceof ApiError && e.status === 403);
});
