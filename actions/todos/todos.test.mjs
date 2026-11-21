/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Runs the todos action against generated fixtures. Marker words are built at
 * run time so this file carries none.
 *
 * @module
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "todos.mjs");
const TODO = "TO" + "DO";
const FIXME = "FIX" + "ME";

/** Runs the action over one generated file and returns its exit status and stderr. */
function scan(name, content, extensions) {
  const dir = mkdtempSync(join(tmpdir(), "todos-"));
  try {
    writeFileSync(join(dir, name), content);
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        TODOS_PATHS: ".",
        TODOS_EXTENSIONS: extensions,
      },
    });
    return { status: run.status, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  ["a # comment marker in Python fails", "a.py", `# ${TODO} x\n`, ".py", 1],
  ["a bare # comment marker fails", "a.py", `# ${FIXME}\n`, ".py", 1],
  [
    "an indented # comment fails",
    "a.sh",
    `if x; then\n    # ${TODO} y\nfi\n`,
    ".sh",
    1,
  ],
  ["a trailing # comment fails", "a.py", `x = 1  # ${TODO}\n`, ".py", 1],
  [
    "a trailing # comment in YAML fails",
    "a.yml",
    `key: v # ${FIXME}\n`,
    ".yml",
    1,
  ],
  ["a # comment in TOML fails", "a.toml", `# ${TODO}\n`, ".toml", 1],
  [
    "a # comment in a Makefile fails",
    "Makefile",
    `all:\n\t# ${TODO}\n`,
    "Makefile",
    1,
  ],
  [
    "a URL fragment is not a comment",
    "a.py",
    `u = http://x/#${TODO}\n`,
    ".py",
    0,
  ],
  ["shell $# is not a comment", "a.sh", `n=$#${TODO}\n`, ".sh", 0],
  ["a string literal is not a comment", "a.py", `s = "# ${TODO}"\n`, ".py", 0],
  ["a Markdown heading is not a comment", "a.md", `# ${TODO}\n`, ".md", 0],
  [
    "a CSS color is not a comment",
    "a.css",
    `a { color: #${TODO}; }\n`,
    ".css",
    0,
  ],
  [
    "a // inside a Python line is not a comment",
    "a.py",
    `x = a // b  ${TODO}\n`,
    ".py",
    0,
  ],
  ["a // comment still fails", "a.js", `// ${TODO}\n`, ".js", 1],
];

for (const [title, name, content, extensions, status] of cases) {
  test(title, () => {
    const result = scan(name, content, extensions);
    assert.equal(result.status, status, result.stderr);
  });
}

test("a finding names the marker's own column", () => {
  const result = scan("a.py", `x = 1  # ${TODO}\n`, ".py");
  assert.match(result.stderr, /a\.py:1:10: error: /);
});
