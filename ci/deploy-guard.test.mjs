/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * Runs the "Verify the tree is a complete site" step of the reusable
 * deploy workflow, against fake site trees. The step's `run:`
 * body is extracted from the workflow and executed in a scratch directory that
 * holds only the fixture, so what passes or fails is the shipped script.
 *
 * Needs `yaml`: `npm ci --prefix ci`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const STEP = "Verify the tree is a complete site";

const page = (main) => `<!doctype html><html><body><header>chrome</header><main>${main}</main></body></html>\n`;
const LANDING = page("<h1>Welcome</h1><p>Authored.</p>");
const EMPTY_ROOT = page("\n  ");

function guardRun(forge) {
    const workflow = parse(readFileSync(new URL(`${forge}/workflows/deploy-package-site.yml`, root), "utf8"));
    const step = workflow.jobs.deploy.steps.find((s) => s.name === STEP);
    assert.ok(step, `${forge} has no step "${STEP}"`);
    return step.run;
}

/**
 * Builds a fixture and runs the guard against it.
 *
 * @param {object} o
 * @param {string} o.forge          ".gitea"
 * @param {Record<string,string>} o.files  files under the site directory, `pkg/` prefixed
 * @param {string} [o.mode]         "homepage" (exactly one page) or "content"
 */
function runGuard({ forge, files, mode = "homepage" }) {
    const cwd = mkdtempSync(join(tmpdir(), "deploy-guard-"));
    try {
        const put = (rel, text) => {
            mkdirSync(dirname(join(cwd, rel)), { recursive: true });
            writeFileSync(join(cwd, rel), text);
        };
        put("site/_headers", "/*\n  X-Robots-Tag: noindex\n");
        for (const [rel, text] of Object.entries(files)) put(`site/${rel}`, text);
        const script = join(cwd, "guard.sh");
        writeFileSync(script, guardRun(forge));
        const env = {
            PATH: process.env.PATH,
            SITE: "site",
            PKG: "pkg",
            MODE: mode,
            MIN: mode === "homepage" ? "1" : "2",
            MAX: mode === "homepage" ? "1" : "0",
        };
        const run = spawnSync("bash", [script], { cwd, env, encoding: "utf8" });
        return { status: run.status, out: `${run.stdout}${run.stderr}` };
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

const base = { "pkg/404.html": page("not found") };

for (const forge of [".gitea"]) {
    test(`${forge}: a homepage build whose root has an empty <main> is refused`, () => {
        const r = runGuard({ forge, files: { ...base, "pkg/index.html": EMPTY_ROOT } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /empty <main>/);
    });

    test(`${forge}: a homepage build with an authored root passes`, () => {
        const r = runGuard({ forge, files: { ...base, "pkg/index.html": LANDING } });
        assert.equal(r.status, 0, r.out);
    });

    test(`${forge}: a build with no landing is refused`, () => {
        const r = runGuard({ forge, files: { ...base } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /index\.html is missing or empty/);
    });

    test(`${forge}: a build with no 404 page is refused`, () => {
        const r = runGuard({ forge, files: { "pkg/index.html": LANDING } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /404\.html is missing or empty/);
    });

    test(`${forge}: a homepage-only build that emitted a second page is refused`, () => {
        const r = runGuard({
            forge,
            files: { ...base, "pkg/index.html": LANDING, "pkg/doc-extra/index.html": LANDING },
        });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /publishes exactly one/);
    });

    test(`${forge}: a content build under its floor is refused`, () => {
        const r = runGuard({ forge, mode: "content", files: { ...base, "pkg/index.html": LANDING } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /fewer than the 2/);
    });

    test(`${forge}: a content build at its floor passes`, () => {
        const r = runGuard({
            forge,
            mode: "content",
            files: { ...base, "pkg/index.html": LANDING, "pkg/doc-extra/index.html": LANDING },
        });
        assert.equal(r.status, 0, r.out);
    });
}
