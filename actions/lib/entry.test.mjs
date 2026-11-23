/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { isEntryPoint } from "./entry.mjs";

const entry = new URL("./entry.mjs", import.meta.url).href;

const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A directory holding a script that prints "ran" when its guard holds, plus a symlink to that directory. */
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "entry-guard-"));
    scratch.push(dir);
    mkdirSync(join(dir, "real"));
    writeFileSync(
        join(dir, "real", "script.mjs"),
        [
            `import { isEntryPoint } from ${JSON.stringify(entry)};`,
            `if (isEntryPoint(import.meta.url)) console.log("ran");`,
            "",
        ].join("\n"),
    );
    symlinkSync(join(dir, "real"), join(dir, "link"));
    return dir;
}

const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });

test("a script run directly is the entry point", () => {
    const dir = fixture();
    assert.equal(run([join(dir, "real", "script.mjs")]).stdout, "ran\n");
});

test("a script run through a symlinked directory is the entry point", () => {
    const dir = fixture();
    assert.equal(run([join(dir, "link", "script.mjs")]).stdout, "ran\n");
});

test("a script run with symlinks preserved is the entry point", () => {
    const dir = fixture();
    assert.equal(run(["--preserve-symlinks-main", join(dir, "link", "script.mjs")]).stdout, "ran\n");
});

test("a script that is imported does not run", () => {
    const dir = fixture();
    const importer = join(dir, "importer.mjs");
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(join(dir, "link", "script.mjs")).href)});\n`);
    assert.equal(run([importer]).stdout, "");
});

test("a missing argv is not the entry point", () => {
    assert.equal(isEntryPoint(import.meta.url, [process.execPath]), false);
    assert.equal(isEntryPoint(import.meta.url, [process.execPath, ""]), false);
});

test("a path that does not exist is not the entry point", () => {
    assert.equal(
        isEntryPoint(import.meta.url, [process.execPath, join(tmpdir(), "entry-guard-absent", "x.mjs")]),
        false,
    );
});

test("a file compared with itself by a path that does not exist is the entry point", () => {
    const missing = pathToFileURL(join(tmpdir(), "entry-guard-absent", "x.mjs")).href;
    assert.equal(isEntryPoint(missing, [process.execPath, join(tmpdir(), "entry-guard-absent", "x.mjs")]), true);
});
