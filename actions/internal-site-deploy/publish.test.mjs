/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the script runs when reached through a symlinked directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-guard-"));
    try {
        symlinkSync(new URL(".", import.meta.url).pathname, join(dir, "linked"), "dir");
        const result = spawnSync(process.execPath, [join(dir, "linked", "publish.mjs")], {
            cwd: dir,
            env: {},
            encoding: "utf8",
            input: "",
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid package prefix/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
