/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { addedChangesets, releaseReview } from "./changesets.mjs";

const action = new URL("./changesets.mjs", import.meta.url);

/** Run the action against a fixture pull request with every API read mocked. */
function run({ ref = "feature/1_x", sha = "head", files = [], reviews = [], failure = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-action-"));
    try {
        writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { number: 7, head: { ref, sha } } }));
        writeFileSync(join(dir, "mock.mjs"), `globalThis.fetch = async (url) => {
            const u = new URL(url); const page = Number(u.searchParams.get("page"));
            const all = u.pathname.endsWith("/reviews") ? ${JSON.stringify(reviews)} : ${JSON.stringify(files)};
            return { ok: !${failure}, status: 403, text: async () => "Forbidden",
                json: async () => all.slice((page - 1) * 100, page * 100) };
        };`);
        return spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), action.pathname], {
            encoding: "utf8",
            env: { ...process.env, GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/fixture", GITHUB_EVENT_PATH: join(dir, "event.json"), RELEASE_BRANCH: "" },
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

test("an approval passes only on the head commit, and a later decision supersedes it", () => {
    const r = (login, state, commit_id) => ({ user: { login }, state, commit_id });
    assert.deepEqual(releaseReview([r("tom", "APPROVED", "head")], "head"), { approved: true, stale: [] });
    assert.deepEqual(releaseReview([r("tom", "APPROVED", "old")], "head"), { approved: false, stale: ["tom"] });
    assert.equal(releaseReview([r("tom", "APPROVED", "head"), r("tom", "CHANGES_REQUESTED", "head")], "head").approved, false);
    assert.equal(releaseReview([r("tom", "APPROVED", "head"), r("tom", "COMMENTED", "head")], "head").approved, true);
    assert.equal(releaseReview([r("tom", "APPROVED", "head"), r("tom", "DISMISSED", "head")], "head").approved, false);
    assert.equal(releaseReview([], "head").approved, false);
});

test("one changeset passes and two fail, naming each file first on its line", () => {
    assert.equal(run({ files: [cs("one")] }).status, 0);
    assert.equal(run({ files: [] }).status, 0);
    const out = run({ files: [cs("one"), cs("two")] });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^\.changeset\/one\.md: error: one of 2 changesets/m);
    assert.match(out.stderr, /^\.changeset\/two\.md: error: one of 2 changesets/m);
});

test("the release pull request needs an approval on its head, whatever changesets it removes", () => {
    const release = { ref: "changeset-release/main", files: [cs("a", "removed"), cs("b", "removed")] };
    assert.equal(run({ ...release, reviews: [{ user: { login: "tom" }, state: "APPROVED", commit_id: "head" }] }).status, 0);
    const stale = run({ ...release, reviews: [{ user: { login: "tom" }, state: "APPROVED", commit_id: "old" }] });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /^pull\/7\/reviews: error: .*approval by tom names an earlier commit/m);
    assert.match(run(release).stderr, /no approving review names its head commit/);
});

test("a failed read fails the check rather than passing on nothing", () => {
    const out = run({ files: [cs("one")], failure: true });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^pull\/7\/files: error: could not be read: 403/m);
});
