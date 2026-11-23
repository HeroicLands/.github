/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The entry-point guard the action scripts share: a script runs its `main`
 * only when it is the file node was started on, and stays importable by tests
 * and by other scripts.
 * @module
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The resolved path of a file, or the path itself when it cannot be resolved
 * because it does not exist.
 * @param {string} path
 * @returns {string}
 */
function resolved(path) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * Whether the module at `metaUrl` is the script node was started on. Both
 * sides are compared by real path, so a script reached through a symlinked
 * directory is still the entry point. A missing script path is not an entry point.
 * @param {string} metaUrl The module's `import.meta.url`.
 * @param {readonly (string | undefined)[]} [argv] The process arguments; the script path is the second.
 * @returns {boolean}
 */
export function isEntryPoint(metaUrl, argv = process.argv) {
    const script = argv[1];
    if (!script) return false;
    return resolved(script) === resolved(fileURLToPath(metaUrl));
}
