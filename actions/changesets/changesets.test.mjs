/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { addedChangesets } from "./changesets.mjs";

const action = new URL("./changesets.mjs", import.meta.url);

/** Run the action against a fixture pull request with every API read mocked. */
function run({ ref = "feature/1_x", sha = "head", files = [], failure = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-action-"));
    try {
        writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { number: 7, head: { ref, sha } } }));
        writeFileSync(join(dir, "mock.mjs"), `globalThis.fetch = async (url) => {
            const u = new URL(url); const page = Number(u.searchParams.get("page"));
            const all = ${JSON.stringify(files)};
            return { ok: !${failure}, status: 403, text: async () => "Forbidden",
                json: async () => all.slice((page - 1) * 100, page * 100) };
        };`);
        return spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), action.pathname], {
            encoding: "utf8",
            env: { ...process.env, GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/fixture", GITHUB_EVENT_PATH: join(dir, "event.json") },
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

const cs = (name, status = "added", previous) => ({ filename: `.changeset/${name}.md`, status, previous_filename: previous });

test("counts only changesets the pull request adds", () => {
    assert.deepEqual(addedChangesets([
        cs("one"), cs("two", "modified"), cs("README"), { filename: ".changeset/config.json", status: "added" },
        { filename: "docs/x.md", status: "added" }, { filename: ".changeset/nested/a.md", status: "added" },
        cs("moved", "renamed", "notes/moved.md"), cs("renamed-within", "renamed", ".changeset/old.md"), cs("gone", "removed"),
    ]), [".changeset/one.md", ".changeset/moved.md"]);
});

test("multiple changesets pass", () => {
    assert.equal(run({ files: [cs("one")] }).status, 0);
    assert.equal(run({ files: [] }).status, 0);
    assert.equal(run({ files: [cs("one"), cs("two")] }).status, 0);
});

test("the release pull request passes like any other, whatever changesets it removes", () => {
    const out = run({ ref: "changeset-release/main", files: [cs("a", "removed"), cs("b", "removed")] });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /adds 0 changeset\(s\)/);
});

test("a failed read fails the check rather than passing on nothing", () => {
    const out = run({ files: [cs("one")], failure: true });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^pull\/7\/files: error: could not be read: 403/m);
});

// Each forge's paging style: Gitea serves 50 to a page, GitHub 100.

import { FORGE_ENV } from "../lib/fake-forge.mjs";

const fakeForge = new URL("../lib/fake-forge.mjs", import.meta.url).href;

/** Run the action on a forge with every list served in that forge's paging style. */
function runOn(style, { event, files = [] }) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-forge-"));
    try {
        writeFileSync(join(dir, "event.json"), JSON.stringify(event));
        writeFileSync(join(dir, "mock.mjs"), `import { pagedFetch } from ${JSON.stringify(fakeForge)};
            globalThis.fetch = pagedFetch({ "/files": ${JSON.stringify(files)} }, ${JSON.stringify(style)});`);
        return spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), action.pathname], {
            encoding: "utf8",
            env: { ...process.env, ...FORGE_ENV[style], GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/fixture", GITHUB_EVENT_PATH: join(dir, "event.json") },
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("multiple changesets across pages pass on both forges", () => {
    const event = { pull_request: { number: 7, head: { ref: "feature/1_x", sha: "head" } } };
    const filler = Array.from({ length: 58 }, (_, i) => ({ filename: `src/f${i}.js`, status: "modified" }));
    const files = [cs("one"), ...filler, cs("two")];
    for (const style of ["gitea", "github"]) {
        const out = runOn(style, { event, files });
        assert.equal(out.status, 0, `${style}: ${out.stderr}`);
        assert.match(out.stdout, /adds 2 changeset\(s\)/, style);
    }
    const onePage = runOn("gitea", { event, files: [cs("one"), ...filler] });
    assert.equal(onePage.status, 0);
    assert.match(onePage.stdout, /adds 1 changeset\(s\)/);
});
