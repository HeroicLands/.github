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
    "a.sh",
    `u=http://x/#${TODO}\n`,
    ".sh",
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
  ["x=1# marker in Python fails", "a.py", `x=1# ${TODO}\n`, ".py", 1],
  ["x=1# marker in TOML fails", "a.toml", `x=1# ${TODO}\n`, ".toml", 1],
  [
    "X:=v# marker in a Makefile fails",
    "Makefile",
    `X:=v# ${TODO}\n`,
    "Makefile",
    1,
  ],
  [
    "an escaped # in a Makefile is not a comment",
    "Makefile",
    `X:=v\\# ${TODO}\n`,
    "Makefile",
    0,
  ],
  ["shell word# is not a comment", "a.sh", `echo a# ${TODO}\n`, ".sh", 0],
  ["shell ;# is a comment", "a.sh", `echo a;# ${TODO}\n`, ".sh", 1],
  ["shell ${#x} is not a comment", "a.sh", `n=\${#${TODO}}\n`, ".sh", 0],
  [
    "YAML glued # is not a comment",
    "a.yml",
    `u: http://x/#${TODO}\nv: a#${TODO}\n`,
    ".yml",
    0,
  ],
  [
    "a triple-quoted Python string hides a # marker",
    "a.py",
    `t = """\n# ${TODO} x\n"""\n`,
    ".py",
    0,
  ],
  [
    "a raw f-string triple-quoted string hides a # marker",
    "a.py",
    `t = rf\'\'\'\n# ${TODO} x\n\'\'\'\n`,
    ".py",
    0,
  ],
  [
    "a real comment after a triple-quoted string fails",
    "a.py",
    `t = """\n# ${TODO} x\n"""\n# ${TODO}\n`,
    ".py",
    1,
  ],
  [
    "a comment on the closing line of a triple-quoted string fails",
    "a.py",
    `t = """\nx\n"""  # ${TODO}\n`,
    ".py",
    1,
  ],
  [
    "a TOML multiline basic string hides a # marker",
    "a.toml",
    `t = """\n# ${TODO} x\n"""\n`,
    ".toml",
    0,
  ],
  [
    "a TOML multiline literal string hides a # marker",
    "a.toml",
    `t = \'\'\'\n# ${TODO} x\n\'\'\'\n# ${TODO}\n`,
    ".toml",
    1,
  ],
  [
    "a YAML literal block scalar hides a # marker",
    "a.yml",
    `text: |\n  # ${TODO} x\n\n  more\nk: v\n`,
    ".yml",
    0,
  ],
  [
    "a YAML folded block scalar hides a # marker",
    "a.yml",
    `- text: >-\n    # ${TODO} x\n`,
    ".yml",
    0,
  ],
  [
    "a top-level comment after a YAML block scalar fails",
    "a.yml",
    `text: |\n  # ${TODO} x\n# ${TODO}\n`,
    ".yml",
    1,
  ],
  [
    "a shell here-document hides a # marker",
    "a.sh",
    `cat <<EOF\n# ${TODO} x\nEOF\n`,
    ".sh",
    0,
  ],
  [
    "a comment after a shell here-document fails",
    "a.sh",
    `cat <<'EOF'\n# ${TODO} x\nEOF\n# ${TODO}\n`,
    ".sh",
    1,
  ],
  [
    "a shell multiline quote hides a # marker",
    "a.sh",
    `echo "a\n# ${TODO} x\n"\n`,
    ".sh",
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

/** The `line:column` of every finding the action reports for one file. */
function locations(name, content, extensions) {
  const result = scan(name, content, extensions);
  return [...result.stderr.matchAll(/^\S+?:(\d+):(\d+): error: /gm)].map(
    (m) => `${m[1]}:${m[2]}`,
  );
}

const located = [
  [
    "a YAML sibling key after a sequence block scalar keeps its comment",
    "a.yml",
    `- text: |\n    literal\n  next: value # ${TODO}\n`,
    ".yml",
    "3:17",
  ],
  [
    "a YAML sequence block scalar with a chomping indicator ends at its sibling key",
    "a.yml",
    `- text: |-\n    literal\n  next: value # ${TODO}\n`,
    ".yml",
    "3:17",
  ],
  [
    "a YAML block scalar with an indentation indicator ends at a less indented line",
    "a.yml",
    `key: |2\n    deeper\n  inside\nnext: v # ${TODO}\n`,
    ".yml",
    "4:11",
  ],
  [
    "a YAML bare sequence scalar ends at the next item",
    "a.yml",
    `- |\n  literal\n- k: v # ${TODO}\n`,
    ".yml",
    "3:10",
  ],
  [
    "a shell here-string leaves later comments findings",
    "a.sh",
    `cat <<<EOF\n# ${TODO}\n`,
    ".sh",
    "2:3",
  ],
  [
    "a shell here-string with a space leaves later comments findings",
    "a.sh",
    `cat <<< word\n# ${TODO}\n`,
    ".sh",
    "2:3",
  ],
  [
    "a hyphenated here-document delimiter ends at its own line",
    "a.sh",
    `cat <<END-OF-DATA\nliteral # ${TODO}\nEND-OF-DATA\n# ${TODO}\n`,
    ".sh",
    "4:3",
  ],
  [
    "a dotted quoted here-document delimiter ends at its own line",
    "a.sh",
    `cat <<-"a.b"\n\t# ${TODO}\n\ta.b\n# ${TODO}\n`,
    ".sh",
    "4:3",
  ],
  [
    "a TOML basic multiline string closing with a literal quote keeps its comment",
    "a.toml",
    `t = """\nexample"""" # ${TODO}\n`,
    ".toml",
    "2:15",
  ],
  [
    "a TOML basic multiline string closing with two literal quotes keeps its comment",
    "a.toml",
    `t = """\nexample""""" # ${TODO}\n`,
    ".toml",
    "2:16",
  ],
  [
    "a TOML literal multiline string closing with a literal quote keeps its comment",
    "a.toml",
    `t = \'\'\'\nexample\'\'\'\' # ${TODO}\n`,
    ".toml",
    "2:15",
  ],
];

for (const [title, name, content, extensions, expected] of located) {
  test(title, () => {
    assert.deepEqual(locations(name, content, extensions), [expected]);
  });
}

test("a Python string closing at the first triple quote is unchanged", () => {
  assert.deepEqual(locations("a.py", `x = """a"""  # ${TODO}\n`, ".py"), [
    "1:16",
  ]);
});
