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
import { join } from "node:path";

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
const EXTENSIONS = list(process.env.TODOS_EXTENSIONS, DEFAULT_EXTENSIONS).map(
    (ext) => (ext.startsWith(".") ? ext : `.${ext}`),
);
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

/** @returns {Generator<string>} every file under `entry` that is scanned. */
function* walk(entry) {
    for (const name of readdirSync(entry)) {
        if (PRUNE.has(name)) continue;
        const path = join(entry, name);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (EXTENSIONS.some((ext) => path.endsWith(ext))) yield path;
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
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
            const comment = blankStrings(line).match(COMMENT);
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
