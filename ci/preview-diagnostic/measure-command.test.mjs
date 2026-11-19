/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("measurement preserves success, failure and signal termination", () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-metrics-"));
    const helper = fileURLToPath(new URL("./measure-command.sh", import.meta.url));
    try {
        for (const [name, command, expected] of [
            ["ok", "exit 0", 0],
            ["failed", "exit 7", 7],
            ["killed", "kill -KILL $$", 137],
        ]) {
            const result = spawnSync("bash", [
                "-c",
                'source "$1"; metrics="$2"; measure "$3" bash -c "$4"',
                "measure-test",
                helper,
                dir,
                name,
                command,
            ]);
            assert.equal(result.status, expected);
            const report = readFileSync(join(dir, `${name}.txt`), "utf8");
            assert.match(report, new RegExp(`shell_exit_status=${expected}\\n`));
            if (name === "killed") assert.match(report, /terminated by signal 9/);
            assert.doesNotMatch(report, /(^|\n)exit_status=/);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
