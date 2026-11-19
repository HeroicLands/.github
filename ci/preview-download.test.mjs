/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("bounded preview archive download rejects unsafe and oversized input", () => {
    const result = spawnSync(
        "/usr/bin/python3",
        [fileURLToPath(new URL("./preview-download.test.py", import.meta.url))],
        { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
});
