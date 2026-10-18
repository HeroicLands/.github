/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * The Renovate run: its workflow, its configuration and the approval of patch
 * and lockfile pull requests. Needs `yaml`: `npm ci --prefix ci`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { APPROVED_BRANCHES, isApprovedAtHead, isAutoApproved, needingApproval } from "../renovate/approve-dependency-prs.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const preset = JSON.parse(read("default.json"));
const workflow = parse(read(".gitea/workflows/renovate.yml"));
const require = createRequire(import.meta.url);

const pr = (over = {}) => ({
    state: "open",
    title: "chore(deps): update patch dependencies",
    user: { login: "renovate" },
    head: { ref: "renovate/patch", sha: "abc", repo: { full_name: "HeroicLands/x" } },
    base: { repo: { full_name: "HeroicLands/x" } },
    ...over,
});
const approval = (over = {}) => ({ user: { login: "heroiclands-bot" }, state: "APPROVED", commit_id: "abc", ...over });

describe("the preset", () => {
    const rule = (type) => preset.packageRules.find((r) => r.matchUpdateTypes?.includes(type));

    test("only the patch group and the lockfile refresh merge by themselves", () => {
        assert.equal(rule("patch").automerge, true);
        assert.equal(rule("patch").groupSlug, "patch");
        for (const type of ["minor", "major"]) assert.equal(rule(type).automerge, false, type);
        assert.equal(preset.lockFileMaintenance.automerge, true);
        assert.equal(preset.automerge, false);
        assert.equal(preset.platformAutomerge, true);
    });

    test("the patch group's branch is the one the approval step looks for", () => {
        assert.ok(APPROVED_BRANCHES.includes(`renovate/${rule("patch").groupSlug}`));
        assert.ok(APPROVED_BRANCHES.includes("renovate/lock-file-maintenance"));
        assert.ok(!APPROVED_BRANCHES.includes(`renovate/${rule("minor").groupSlug}`));
        assert.notEqual(rule("minor").groupSlug, rule("patch").groupSlug);
    });

    test("commit subjects carry the dependency prefix and no labels are applied", () => {
        assert.equal(preset.commitMessagePrefix, "chore(deps):");
        assert.deepEqual(preset.labels, []);
    });
});

describe("the global configuration", () => {
    const config = require("../renovate/config.cjs");

    test("it targets the organisation's repositories without onboarding", () => {
        assert.equal(config.platform, "gitea");
        assert.deepEqual(config.autodiscoverFilter, ["HeroicLands/*"]);
        assert.equal(config.onboarding, false);
        assert.equal(config.requireConfig, "optional");
        assert.deepEqual(config.packageRules, preset.packageRules);
    });

    test("it holds no credential", () => {
        assert.doesNotMatch(read("renovate/config.cjs"), /(?:token|password)\s*:/i);
    });
});

describe("renovate.yml", () => {
    const job = workflow.jobs.renovate;
    const source = read(".gitea/workflows/renovate.yml");

    test("it is one gated job on the lint runner, so nothing needs a skippable job", () => {
        assert.deepEqual(Object.keys(workflow.jobs), ["renovate"]);
        assert.equal(job["runs-on"], "lint");
        assert.equal(job.needs, undefined);
        assert.match(job.if, /vars\.HL_RENOVATE_ENABLED == 'true'/);
    });

    test("the cron fires at both Pacific-02:00 UTC hours and the first step selects one", () => {
        assert.deepEqual(workflow.on.schedule, [{ cron: "0 9,10 * * 0" }]);
        assert.match(job.steps[0].run, /America\/Los_Angeles/);
    });

    test("Renovate is pinned to an exact version", () => {
        const run = job.steps.find((s) => s.name === "Run Renovate");
        assert.match(run.env.RENOVATE_VERSION, /^\d+\.\d+\.\d+$/);
        assert.match(run.run, /renovate@\$RENOVATE_VERSION/);
    });

    test("the tokens are the declared ones and the approval uses the release bot", () => {
        const used = new Set([...source.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]));
        assert.deepEqual([...used].sort(), ["RELEASE_BOT_TOKEN", "RENOVATE_GITHUB_COM_TOKEN", "RENOVATE_TOKEN"]);
        const approve = job.steps.find((s) => s.name === "Approve the patch and lockfile pull requests");
        assert.deepEqual(Object.keys(approve.env), ["RELEASE_BOT_TOKEN"]);
        assert.match(approve.if, /dry-run == 'none'/);
    });
});

describe("approving patch and lockfile pull requests", () => {
    test("only the open patch group and lockfile refresh from the dependency user qualify", () => {
        assert.equal(isAutoApproved(pr()), true);
        assert.equal(isAutoApproved(pr({ head: { ref: "renovate/minor", sha: "abc", repo: { full_name: "HeroicLands/x" } } })), false);
        assert.equal(isAutoApproved(pr({ head: { ref: "renovate/major-foo-2.x", sha: "abc", repo: { full_name: "HeroicLands/x" } } })), false);
        assert.equal(isAutoApproved(pr({ head: { ref: "renovate/lock-file-maintenance", sha: "abc", repo: { full_name: "HeroicLands/x" } } })), true);
        assert.equal(isAutoApproved(pr({ user: { login: "heroiclands-bot" } })), false);
        assert.equal(isAutoApproved(pr({ title: "WIP: chore(deps): update patch dependencies" })), false);
        assert.equal(isAutoApproved(pr({ state: "closed" })), false);
        assert.equal(isAutoApproved(pr({ head: { ref: "renovate/patch", sha: "abc", repo: { full_name: "someone/x" } } })), false);
    });

    test("an approval counts only from the bot, on the current head, and undismissed", () => {
        assert.equal(isApprovedAtHead(pr(), [approval()]), true);
        assert.equal(isApprovedAtHead(pr(), [approval({ commit_id: "old" })]), false);
        assert.equal(isApprovedAtHead(pr(), [approval({ dismissed: true })]), false);
        assert.equal(isApprovedAtHead(pr(), [approval({ stale: true })]), false);
        assert.equal(isApprovedAtHead(pr(), [approval({ user: { login: "tomr" } })]), false);
        assert.equal(isApprovedAtHead(pr(), [approval({ state: "COMMENT" })]), false);
    });

    test("the run is idempotent: an approved pull request is not listed again", () => {
        const done = { pr: pr(), reviews: [approval()] };
        const pending = { pr: pr({ number: 2 }), reviews: [] };
        assert.deepEqual(needingApproval([done, pending]).map((p) => p.number), [2]);
    });
});
