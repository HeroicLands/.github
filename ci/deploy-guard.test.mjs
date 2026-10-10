/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * Runs the "Verify the tree is a complete site" step of the reusable
 * deploy workflow, on both forges, against fake site trees. The step's `run:`
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
 * @param {string} o.forge          ".github" or ".gitea"
 * @param {Record<string,string>} o.files  files under the site directory, `pkg/` prefixed
 * @param {string} [o.installed]    version of the installed package-build, if any
 * @param {string} [o.ownVersion]   version in the repository's own package.json
 * @param {string} [o.repository]   the caller's repository
 */
function runGuard({ forge, files, installed, ownVersion, repository = "HeroicLands/consumer", mode = "homepage" }) {
    const cwd = mkdtempSync(join(tmpdir(), "deploy-guard-"));
    try {
        const put = (rel, text) => {
            mkdirSync(dirname(join(cwd, rel)), { recursive: true });
            writeFileSync(join(cwd, rel), text);
        };
        put("site/_headers", "/*\n  X-Robots-Tag: noindex\n");
        for (const [rel, text] of Object.entries(files)) put(`site/${rel}`, text);
        if (installed) {
            put("node_modules/@heroiclands/package-build/package.json", JSON.stringify({ version: installed }));
        }
        if (ownVersion) put("package.json", JSON.stringify({ name: "@heroiclands/package-build", version: ownVersion }));
        const script = join(cwd, "guard.sh");
        writeFileSync(script, guardRun(forge));
        const env = {
            PATH: process.env.PATH,
            SITE: "site",
            PKG: "pkg",
            MODE: mode,
            MIN: mode === "homepage" ? "1" : "2",
            MAX: mode === "homepage" ? "1" : "0",
            REPOSITORY: repository,
        };
        const run = spawnSync("bash", [script], { cwd, env, encoding: "utf8" });
        return { status: run.status, out: `${run.stdout}${run.stderr}` };
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

const base = { "pkg/404.html": page("not found") };

for (const forge of [".github", ".gitea"]) {
    test(`${forge}: a package-build 22.4+ homepage build whose root has an empty <main> is refused`, () => {
        const r = runGuard({ forge, installed: "23.1.1", files: { ...base, "pkg/index.html": EMPTY_ROOT } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /site\/pkg\/index\.html.*no content|empty <main>/s);
    });

    test(`${forge}: a package-build 22.4+ homepage build with an authored root passes`, () => {
        const r = runGuard({ forge, installed: "23.1.1", files: { ...base, "pkg/index.html": LANDING } });
        assert.equal(r.status, 0, r.out);
    });

    test(`${forge}: a package-build 15 to 22.3 build with only Hugo's root is refused`, () => {
        const r = runGuard({ forge, installed: "21.0.0", files: { ...base, "pkg/index.html": EMPTY_ROOT } });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /emitted no landing/);
    });

    test(`${forge}: a build with no readable package-build version and no landing is refused`, () => {
        const r = runGuard({ forge, files: { ...base, "pkg/index.html": EMPTY_ROOT } });
        assert.notEqual(r.status, 0, r.out);
    });

    test(`${forge}: package-build's own documentation build reads its version from its own package.json`, () => {
        const r = runGuard({
            forge,
            ownVersion: "23.1.1",
            repository: "HeroicLands/package-build",
            files: { ...base, "pkg/index.html": LANDING },
        });
        assert.equal(r.status, 0, r.out);
    });

    test(`${forge}: package-build's own build with an empty root is still refused`, () => {
        const r = runGuard({
            forge,
            ownVersion: "23.1.1",
            repository: "HeroicLands/package-build",
            files: { ...base, "pkg/index.html": EMPTY_ROOT },
        });
        assert.notEqual(r.status, 0, r.out);
    });

    test(`${forge}: a consuming repository does not take its version from its own package.json`, () => {
        const r = runGuard({
            forge,
            ownVersion: "23.1.1",
            files: { ...base, "pkg/index.html": LANDING },
        });
        assert.notEqual(r.status, 0, r.out);
    });
}
