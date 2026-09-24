/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { identities, phrases, mailboxes } from "./attribution.mjs";
import { accepted, rejected } from "./attribution-fixtures.mjs";

const action = new URL("./no-attribution.mjs", import.meta.url);
function run({ title = "Update guard", body = null, messages = ["Update guard"], failure = false, failurePage = 1, actionName = "edited" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "attribution-action-"));
    try {
        writeFileSync(join(dir, "event.json"), JSON.stringify({ action: actionName, pull_request: { number: 123, title, body } }));
        writeFileSync(join(dir, "mock.mjs"), `globalThis.fetch = async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { ok: !(${failure} && page === ${failurePage}), status: 403, text: async () => "Forbidden",
                json: async () => ${JSON.stringify(messages.map((message, i) => ({ sha: `fixture${i}`, commit: { message } })))}.slice((page - 1) * 100, page * 100) };
        };`);
        return spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), action.pathname], {
            encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/fixture", GITHUB_EVENT_PATH: join(dir, "event.json") },
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const [lines, status] of [[rejected, 1], [accepted, 0]]) {
    for (const line of lines) {
        test(`${status ? "rejects" : "accepts"} ${line} on every PR surface`, () => {
            for (const input of [{ title: line }, { body: line }, { messages: [line] }]) {
                const result = run(input);
                assert.equal(result.status, status, result.stderr || result.stdout);
            }
        });
    }
}
test("locates original text after Markdown normalization", () => {
    const line = '  - 🤖 **Generated with** [Codex](https://openai.com/codex)';
    const result = run({ body: `Context\r\n${line}` });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`pull/123/body:2:${line.indexOf("Generated") + 1}: error:`));
});
test("reads all commit pages and reports every subject", () => {
    const result = run({ title: rejected[0], body: rejected[0], messages: [...Array(100).fill("Human change"), rejected[0], rejected[0]] });
    assert.equal(result.status, 1);
    for (const address of ["pull/123/title", "pull/123/body", "commit/fixture100", "commit/fixture101"]) assert.ok(result.stderr.includes(`${address}:1:1: error:`));
});
test("accepts null body and empty commit list", () => assert.equal(run({ messages: [] }).status, 0));
test("fails a commit API read", () => {
    const result = run({ failure: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pull\/123\/commits: error: could not be read: 403/);
});

test("covers every declared identity, phrase and mailbox on every subject", () => {
    const lines = identities.flatMap((name) => [
        `Co-Authored-By: ${name} <person@example.com>`,
        ...phrases.map((phrase) => `${phrase} ${name}`),
        `AI-assisted by ${name}`,
        `AI-generated with ${name}`,
    ]);
    lines.push(...mailboxes.map((mailbox) => `Co-Authored-By: Contributor <${mailbox}>`));
    const text = lines.join("\r\n");
    const result = run({ title: text, body: text, messages: [text] });
    assert.equal(result.status, 1);
    for (const address of ["pull/123/title", "pull/123/body", "commit/fixture0"]) {
        for (let line = 1; line <= lines.length; line++) assert.ok(result.stderr.includes(`${address}:${line}:1: error:`), `${address} missing ${lines[line - 1]}`);
    }
});
test("uses the edited PR payload", () => {
    assert.equal(run({ body: "Human change", actionName: "opened" }).status, 0);
    assert.equal(run({ body: rejected[0], actionName: "edited" }).status, 1);
});

test("fails a later commit page rather than accepting a partial read", () => {
    const result = run({ messages: Array(100).fill("Human change"), failure: true, failurePage: 2 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pull\/123\/commits: error: could not be read: 403/);
    assert.doesNotMatch(result.stdout, /is clean/);
});
