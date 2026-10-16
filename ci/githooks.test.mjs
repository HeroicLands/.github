/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";
import { accepted, rejected } from "../actions/no-attribution/attribution-fixtures.mjs";
import { attribution, identities, phrases, mailboxes } from "../actions/no-attribution/attribution.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hook = join(root, "githooks/commit-msg");

test("the POSIX message hook agrees with the action grammar", () => {
    const work = mkdtempSync(join(tmpdir(), "canonical message "));
    try {
        const file = join(work, "message with spaces");
        const refused = [
            ...rejected,
            ...identities.flatMap((identity) => [
                `Co-Authored-By: ${identity} <human@example.com>`,
                ...phrases.map((phrase) => `${phrase} ${identity}`),
                `AI-generated with ${identity}`,
            ]),
            ...mailboxes.map((mailbox) => `Co-Authored-By: Contributor <${mailbox}>`),
        ];
        const allowed = [
            ...accepted,
            "ÉGenerated with Codex",
            "中文Generated with Codex",
            "# Generated with Codex",
            "Ordinary prose\n# ------------------------ >8 ------------------------\nGenerated with Codex",
        ];
        for (const [messages, expected] of [[refused, 1], [allowed, 0]]) {
            for (const message of messages) {
                writeFileSync(file, `${message}\n`);
                const result = spawnSync("sh", [hook, file], {
                    cwd: work,
                    encoding: "utf8",
                    env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
                });
                assert.equal(result.status, expected, `${message}\n${result.stderr}`);
            }
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});

test("the drift action runs its own tracked canonical files from a consumer checkout", () => {
    const manifest = parse(readFileSync(join(root, "actions/githooks/action.yml"), "utf8"));
    const [step] = manifest.runs.steps;
    assert.equal(step.shell, "sh");
    assert.equal(step.env.CANONICAL_HOOK_ACTION, "${{ github.action_path }}");
    const consumer = mkdtempSync(join(tmpdir(), "consumer checkout "));
    try {
        const result = spawnSync("sh", ["-c", step.run], {
            cwd: consumer,
            encoding: "utf8",
            env: { ...process.env, CANONICAL_HOOK_ACTION: join(root, "actions/githooks") },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /\.githooks\/commit-msg: error: missing/);
        assert.match(result.stderr, /\.githooks\/pre-commit: error: missing/);
    } finally {
        rmSync(consumer, { recursive: true, force: true });
    }
});


test("Unicode whitespace boundaries agree with the action without changing identity names", () => {
    const work = mkdtempSync(join(tmpdir(), "whitespace message "));
    try {
        const file = join(work, "message");
        // Derive the finite JavaScript whitespace set rather than copying it.
        const spaces = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
            .filter((char) => /\s/u.test(char) && char !== "\n" && char !== "\r");
        for (const space of spaces) {
            for (const message of [
                `Generated with${space}Codex`,
                `Co-Authored-By:${space}Codex <human@example.com>`,
                `Co-Authored-By: Contributor${space}<codex@openai.com>`,
                `Generated with Codex${space}`,
                `Generated with OpenAI${space}Codex`,
                `Generated with [Codex](https://example.com/${space}x)`,
                `Generated${space}with Codex`,
                `AI-generated${space}with${space}Codex`,
            ]) {
                writeFileSync(file, `${message}\n`);
                const result = spawnSync("sh", [hook, file], {
                    cwd: work,
                    encoding: "utf8",
                    env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
                });
                assert.equal(result.status, attribution(message) ? 1 : 0,
                    `U+${space.codePointAt(0).toString(16)}: ${message}\n${result.stderr}`);
            }
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});

test("normalization failure refuses the commit", () => {
    const work = mkdtempSync(join(tmpdir(), "failing normalizer "));
    try {
        const file = join(work, "message");
        writeFileSync(file, "Ordinary message\n");
        writeFileSync(join(work, "sed"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
        const result = spawnSync("sh", [hook, file], {
            cwd: work,
            encoding: "utf8",
            env: { ...process.env, PATH: `${work}:${process.env.PATH}`, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /cannot normalize commit message/);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});
