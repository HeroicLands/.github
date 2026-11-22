/*
 * Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * **No abandoned markers in committed source.**
 *
 * A `TODO` in a comment is a note to nobody. It duplicates the issue that
 * should carry the work, drifts out of sync with it, and — in a published
 * doc comment — leaks onto the API site as documentation prose. So the rule
 * every HeroicLands repository wants is the same one: when you would write a
 * marker, file or find an issue, record the code-site context there, and
 * leave the code clean.
 *
 * The rule is universal; only the file selection ever differed. SoHL scanned
 * TypeScript under `src/`; `sohl-thalorna` and `sohl-kethira-basic` have a
 * `src/` too, in JavaScript; and any of them may one day want a marker word
 * beyond `TODO`/`FIXME`. Those three things are inputs here, and nothing else
 * needs to be.
 *
 * **Three things this check is careful about**, all of them the difference
 * between a finding you act on and a finding you argue with:
 *
 * - *String contents are blanked before matching*, so a literal `"TODO"` is
 *   not a finding. The blanking is length-preserving — spaces, not removal —
 *   so every offset still addresses the same character of the original line.
 * - *Only the comment portion of a line is checked*, for the same reason.
 *   In `.py`, `.sh`, `.yml`, `.yaml`, `.toml` and `Makefile` files a `#`
 *   opens a comment under that language's own rule, and `//`, `/*` and `*` do
 *   not. Python and TOML: any `#` outside a string. Shell: a `#` that starts a
 *   word (after whitespace, `;`, `&`, `|` or `(`, or at the line start), never
 *   `$#`, `${#x}` or a quoted `#`. YAML: a `#` at the line start or after
 *   whitespace. Makefile: any `#` not escaped by a backslash; recipe lines
 *   follow the shell rule. Every other file type keeps `#` as ordinary text,
 *   so a Markdown heading or a CSS color is never a comment.
 * - *Lexical context carries across lines* in the hash-comment languages:
 *   Python and TOML multiline strings, YAML block scalars and quoted scalars,
 *   and shell multiline quotes and here-documents. Their content is never a
 *   comment. Shell here-documents inside `$(( ))` arithmetic and Makefile
 *   `define` bodies are not tracked.
 * - *The column is the marker's own*, not the start of the line, so an editor
 *   opens on the word (SoHL#1668).
 *
 * Findings are `file:line:column: severity: message`, the form every C-family
 * compiler and ESLint emit, so an error matcher resolves them without being
 * taught the layout. It is four fields joined by colons, and an Action that
 * needs a checkout and nothing else should not acquire a build toolchain to
 * write one line.
 *
 * Writes nothing. Exits non-zero on any marker.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const DEFAULT_PATHS = "src";
const DEFAULT_EXTENSIONS = ".ts,.tsx,.js,.jsx,.mjs,.cjs";
const DEFAULT_MARKERS = "TODO,FIXME";

/** Never descended into, whatever the paths say. */
const PRUNE = new Set(["node_modules", ".git"]);

/**
 * A list-shaped input. Newline- or comma-separated so a workflow can use
 * either YAML block scalars or a one-liner, whichever reads better there.
 *
 * @returns {string[]}
 */
function list(value, fallback) {
  return (value?.trim() ? value : fallback)
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const PATHS = list(process.env.TODOS_PATHS, DEFAULT_PATHS);

/** Extensions of the file types in which `#` starts a line comment. */
const HASH_EXTENSIONS = new Set([".py", ".sh", ".yml", ".yaml", ".toml"]);

/** Base names, with no extension, of the files in which `#` starts a comment. */
const HASH_BASENAMES = new Set(["Makefile", "makefile", "GNUmakefile"]);

/** An entry is a base name when it names a hash-comment file, else an extension. */
const EXTENSIONS = list(process.env.TODOS_EXTENSIONS, DEFAULT_EXTENSIONS).map(
  (ext) => (ext.startsWith(".") || HASH_BASENAMES.has(ext) ? ext : `.${ext}`),
);

/** Whether `path` is selected by an extension or base-name entry. */
function matches(path) {
  const name = basename(path);
  return EXTENSIONS.some((ext) =>
    HASH_BASENAMES.has(ext) ? name === ext : path.endsWith(ext),
  );
}

/**
 * The hash-comment language of `path` (`py`, `sh`, `yaml`, `toml` or `make`),
 * or null when `#` is ordinary text there.
 */
function hashLanguage(path) {
  if (HASH_BASENAMES.has(basename(path))) return "make";
  const ext = extname(path);
  if (ext === ".py") return "py";
  if (ext === ".sh") return "sh";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".toml") return "toml";
  return null;
}
const MARKER_WORDS = list(process.env.TODOS_MARKERS, DEFAULT_MARKERS);

/** A finding, in the form an error matcher already reads. */
function report({ file, line, column, severity = "error", message }) {
  const at = [file, line, column].filter((part) => part != null).join(":");
  console.error(`${at}: ${severity}: ${message}`);
}

/**
 * The forbidden markers as one pattern.
 *
 * The edges are lookarounds rather than `\b` because a marker need not begin
 * with a word character — `\b@todo` can never match, since the boundary it
 * asks for is between the space and the `@`.
 */
const MARKERS = new RegExp(
  `(?<![A-Za-z0-9_])(?:${MARKER_WORDS.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})(?![A-Za-z0-9_])`,
);

/** String and template literals, whose contents are not code. */
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** The comment portion of a line: `//…`, `/*…`, or a `*` continuation. */
const COMMENT = /\/\/.*|\/\*.*|^\s*\*.*/;

/**
 * The comment portion of a blanked line, as a match whose `index` is its
 * offset, or null when the line has none.
 */
function commentOf(blanked) {
  return blanked.match(COMMENT);
}

/**
 * The line with every string literal's *contents* replaced by spaces.
 *
 * Length-preserving on purpose: the column reported has to be the marker's
 * own, so an offset into the blanked line must still be an offset into the
 * real one.
 */
function blankStrings(line) {
  return line.replace(
    STRING,
    (match) => match[0] + " ".repeat(match.length - 2) + match.at(-1),
  );
}

/** The number of leading spaces and tabs of `line`. */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** Whether a `#` at `at` starts a comment in `lang`, outside any string. */
function startsComment(line, at, lang) {
  if (lang === "py" || lang === "toml" || lang === "make") return true;
  const before = line[at - 1];
  if (lang === "yaml") return before === undefined || /\s/.test(before);
  return before === undefined || /[\s;&|(]/.test(before);
}

/**
 * The string a quote character at `at` opens, or null when it opens none.
 * `multi` marks a string that may continue on the next line.
 */
function openString(line, at, lang) {
  const c = line[at];
  if (c !== '"' && c !== "'") return null;
  if (lang === "py" || lang === "toml") {
    const triple = line.startsWith(c.repeat(3), at);
    return {
      delim: triple ? c.repeat(3) : c,
      escapes: lang === "py" || c === '"',
      multi: triple,
      toml: lang === "toml" && triple,
      width: triple ? 3 : 1,
    };
  }
  if (lang === "yaml") {
    const before = line[at - 1];
    if (before !== undefined && !/[\s[{,]/.test(before)) return null;
    return {
      delim: c,
      escapes: c === '"',
      yamlSingle: c === "'",
      multi: true,
      width: 1,
    };
  }
  return {
    delim: c,
    escapes: c === '"' || line[at - 1] === "$",
    multi: true,
    width: 1,
  };
}

/** The offset just past the end of string `str` at or after `from`, or -1. */
function closeOf(line, from, str) {
  for (let i = from; i < line.length; i++) {
    if (str.escapes && line[i] === "\\") {
      i++;
    } else if (str.yamlSingle && line.startsWith("''", i)) {
      i++;
    } else if (line.startsWith(str.delim, i)) {
      if (str.toml) {
        // One or two quotes may sit inside the closing delimiter.
        let run = str.delim.length;
        while (run < 5 && line[i + run] === str.delim[0]) run++;
        return i + run;
      }
      return i + str.delim.length;
    }
  }
  return -1;
}

/** The here-document a `<<` at `at` starts, or null. */
function hereDocument(line, at) {
  if (!line.startsWith("<<", at) || line[at + 2] === "<") return null;
  if (line.slice(0, at).includes("((")) return null;
  const match =
    /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][^\s;&|()<>'"\\]*))/.exec(
      line.slice(at),
    );
  if (!match) return null;
  return {
    word: match[2] ?? match[3] ?? match[4],
    dash: match[1] === "-",
    length: match[0].length,
  };
}

/** Whether `line` ends in an odd number of backslashes. */
function endsEscaped(line) {
  return (/\\*$/.exec(line)[0].length & 1) === 1;
}

/**
 * The deepest indentation at which a line no longer belongs to the block
 * scalar that `code` opens, or null when it opens none. Content sits deeper
 * than the node that owns the scalar: the mapping key's column, or the dash's
 * column for a scalar that is a sequence entry itself. An indentation
 * indicator fixes the content depth relative to that node.
 */
function blockScalarEnd(code) {
  const match = /(?:^\s*|:\s+|-\s+)[|>]([+-]?)(\d?)([+-]?)\s*$/.exec(code);
  if (!match) return null;
  const prefix = /^[ \t]*(?:-[ \t]+)*/.exec(code)[0];
  const scalarEntry = /^[|>]/.test(code.slice(prefix.length));
  const dash = prefix.lastIndexOf("-");
  const owner = scalarEntry
    ? dash >= 0
      ? dash
      : indentOf(code)
    : prefix.length;
  const width = Number(match[2]);
  return width ? owner + width - 1 : owner;
}

/**
 * The comment of every line of a hash-comment file, as `{ index, text }` or
 * null. Strings, here-documents and block scalars are tracked across lines so
 * their content is never read as a comment.
 *
 * @param {string[]} lines
 * @param {"py"|"sh"|"yaml"|"toml"|"make"} language
 */
function hashComments(lines, language) {
  const out = [];
  let str = null;
  let here = [];
  let block = null;
  for (const line of lines) {
    if (here.length) {
      const text = here[0].dash ? line.replace(/^\t+/, "") : line;
      if (text === here[0].word) here.shift();
      out.push(null);
      continue;
    }
    if (block !== null) {
      if (line.trim() === "" || indentOf(line) > block) {
        out.push(null);
        continue;
      }
      block = null;
    }
    const recipe = language === "make" && line.startsWith("\t");
    const lang = recipe ? "sh" : language;
    const pending = [];
    let comment = null;
    let i = 0;
    if (str) {
      const end = closeOf(line, 0, str);
      if (end >= 0) {
        i = end;
        str = null;
      } else {
        i = line.length;
        if (!str.multi && !(lang === "py" && endsEscaped(line))) str = null;
      }
    }
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === "#" && startsComment(line, i, lang)) {
        comment = { index: i, text: line.slice(i) };
        break;
      }
      if (c === "\\" && (lang === "sh" || lang === "make")) {
        i++;
        continue;
      }
      const opened = lang === "make" ? null : openString(line, i, lang);
      if (opened) {
        const end = closeOf(line, i + opened.width, opened);
        if (end >= 0) {
          i = end - 1;
          continue;
        }
        if (recipe) opened.multi = false;
        if (opened.multi || (lang === "py" && endsEscaped(line))) {
          str = opened;
        }
        break;
      }
      if (lang === "sh" && !recipe) {
        if (line.startsWith("<<<", i)) {
          i += 2;
          continue;
        }
        const doc = hereDocument(line, i);
        if (doc) {
          pending.push(doc);
          i += doc.length - 1;
        }
      }
    }
    out.push(comment);
    here = pending;
    if (language === "yaml" && !str) {
      block = blockScalarEnd(comment ? line.slice(0, comment.index) : line);
    }
  }
  return out;
}

/** @returns {Generator<string>} every file under `entry` that is scanned. */
function* walk(entry) {
  for (const name of readdirSync(entry)) {
    if (PRUNE.has(name)) continue;
    const path = join(entry, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (matches(path)) yield path;
  }
}

/**
 * Every file the inputs select.
 *
 * A path naming a file is scanned as named — the extension list chooses files
 * out of a directory, and second-guessing an explicit name would only be a way
 * to scan nothing while reporting success.
 */
function selected() {
  const out = [];
  let missing = 0;
  for (const path of PATHS) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) {
      report({ file: path, message: "no such file or directory to scan" });
      missing++;
      continue;
    }
    if (stat.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  if (missing) process.exit(1);
  return out;
}

const files = selected();

if (!files.length) {
  report({
    file: PATHS.join(", "),
    message:
      `nothing to scan: no file matching ${EXTENSIONS.join(", ")}. ` +
      "A check that examined nothing is not a passing check",
  });
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const language = hashLanguage(file);
  const hash = language ? hashComments(lines, language) : null;
  lines.forEach((line, index) => {
    const comment = hash
      ? hash[index]
        ? { 0: hash[index].text, index: hash[index].index }
        : null
      : commentOf(blankStrings(line));
    if (!comment) return;
    const at = comment[0].search(MARKERS);
    if (at === -1) return;
    findings.push({
      file,
      line: index + 1,
      column: comment.index + at + 1,
      marker: comment[0].match(MARKERS)[0],
      text: line.trim(),
    });
  });
}

if (findings.length) {
  console.error(
    `\ntodos: ${findings.length} forbidden marker(s) in committed source:\n`,
  );
  for (const finding of findings) {
    report({
      file: finding.file,
      line: finding.line,
      column: finding.column,
      message: `${finding.marker} marker: ${finding.text}`,
    });
  }
  console.error(
    "\nDeferred work is tracked in issues, not flagged in code. File or " +
      "find an issue,\nrecord any code-site context there, and remove " +
      "the marker.\n",
  );
  process.exit(1);
}

console.log(
  `todos: no ${MARKER_WORDS.join("/")} markers in ${files.length} file(s) ` +
    `under ${PATHS.join(", ")}.`,
);
