/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * The reusable workflows exist twice: `.github/workflows/` is what GitHub runs
 * and `.gitea/workflows/` is what Gitea runs. They share a build contract, a
 * completeness guard, an already-released guard and an asset list, and those
 * must not drift between the forges. Every step that carries a `run:` body is
 * compared; the steps allowed to differ are named below, so a renamed, added or
 * removed step fails here rather than going unnoticed.
 *
 * Needs `yaml`: `npm ci --prefix ci`.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const text = (forge, file) => readFileSync(new URL(`${forge}/workflows/${file}`, root), "utf8");
const load = (forge, file) => parse(text(forge, file));

const GITHUB = ".github";
const GITEA = ".gitea";
const HOST = "'https://github.com'";

/** The expression of a job `if`, without its `${{ }}` wrapper or surplus whitespace. */
const expression = (value) =>
    String(value ?? "")
        .replace(/^\s*\$\{\{/, "")
        .replace(/\}\}\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();

/** The steps of a workflow's only job, keyed by name. Duplicate names fail. */
function stepsByName(workflow, job) {
    const steps = workflow.jobs[job].steps;
    const named = new Map();
    for (const step of steps) {
        assert.ok(step.name, `a step in job ${job} has no name`);
        assert.ok(!named.has(step.name), `two steps in job ${job} are named "${step.name}"`);
        named.set(step.name, step);
    }
    return named;
}

/** The Gitea decide step minus the block that resumes a release whose tag already names HEAD. */
const withoutResume = (run) => run.replace(/^[ \t]*# RESUME-BEGIN\n[\s\S]*?^[ \t]*# RESUME-END\n\n/m, "");

const reusable = {
    "release-foundry-package.yml": {
        job: "release",
        giteaGate: `github.server_url != ${HOST} && vars.HL_RELEASE_ENABLED == 'true'`,
        // Steps present only in the GitHub copy, with the reason they exist there.
        githubOnly: ["Mint the release app token"],
        // Steps present only in the Gitea copy.
        giteaOnly: ["Tag the release"],
        // Steps whose body is not a `run:` and is therefore not compared byte for byte.
        replaced: {
            "Create or update the Version Packages PR": "uses",
            "Create GitHub Release": "uses",
            "Checkout code": "uses",
        },
        secrets: ["RELEASE_BOT_TOKEN", "GH_RELEASE_TOKEN"],
    },
    "deploy-package-site.yml": {
        job: "deploy",
        giteaGate: `github.server_url != ${HOST} && vars.HL_DEPLOY_ENABLED == 'true'`,
        githubOnly: [],
        giteaOnly: ["Check the runner has the tools the deploy uses"],
        replaced: {},
        secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
};

for (const [file, spec] of Object.entries(reusable)) {
    const github = load(GITHUB, file);
    const gitea = load(GITEA, file);

    test(`${file}: the step lists differ only where declared`, () => {
        const githubNames = [...stepsByName(github, spec.job).keys()];
        const giteaNames = [...stepsByName(gitea, spec.job).keys()];
        assert.deepEqual(
            githubNames.filter((name) => !giteaNames.includes(name)).sort(),
            [...spec.githubOnly, ...Object.keys(spec.replaced).filter((n) => !giteaNames.includes(n))].sort(),
            "steps the Gitea copy lost",
        );
        assert.deepEqual(
            giteaNames.filter((name) => !githubNames.includes(name)).sort(),
            [...spec.giteaOnly].sort(),
            "steps only the Gitea copy has",
        );
        const shared = githubNames.filter((name) => giteaNames.includes(name));
        assert.deepEqual(
            shared,
            giteaNames.filter((name) => githubNames.includes(name)),
            "shared steps run in a different order",
        );
    });

    test(`${file}: every shared step has the same run body and condition`, () => {
        const a = stepsByName(github, spec.job);
        const b = stepsByName(gitea, spec.job);
        let compared = 0;
        for (const [name, step] of a) {
            if (!b.has(name)) continue;
            const other = b.get(name);
            assert.equal(expression(other.if), expression(step.if), `"${name}": the condition differs`);
            assert.equal(other.id, step.id, `"${name}": the step id differs`);
            if (name in spec.replaced) {
                assert.ok(step[spec.replaced[name]], `"${name}" is not a ${spec.replaced[name]} step on GitHub`);
                continue;
            }
            if (step.run === undefined) {
                assert.deepEqual(other, step, `"${name}": an action step differs between the forges`);
                compared += 1;
                continue;
            }
            const giteaRun = name === "Decide whether to release" ? withoutResume(other.run) : other.run;
            assert.equal(giteaRun, step.run, `"${name}": the run body differs between the forges`);
            compared += 1;
        }
        assert.ok(compared > 0, "no step was compared");
    });

    test(`${file}: the interface matches on both forges`, () => {
        const ia = github.on.workflow_call.inputs;
        const ib = gitea.on.workflow_call.inputs;
        assert.deepEqual(ib, ia, "the inputs differ");
        assert.deepEqual(
            gitea.on.workflow_call.outputs ?? {},
            github.on.workflow_call.outputs ?? {},
            "the outputs differ",
        );
        assert.equal(gitea.jobs[spec.job]["runs-on"], github.jobs[spec.job]["runs-on"]);
        assert.deepEqual(gitea.jobs[spec.job].concurrency, github.jobs[spec.job].concurrency);
        assert.deepEqual(gitea.jobs[spec.job].outputs ?? {}, github.jobs[spec.job].outputs ?? {});
    });

    test(`${file}: the secrets the Gitea copy declares are exactly the ones it is passed`, () => {
        const declared = Object.keys(gitea.on.workflow_call.secrets ?? {}).sort();
        assert.deepEqual(declared, [...spec.secrets].sort());
        const used = new Set([...text(GITEA, file).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
        for (const name of used) assert.ok(declared.includes(name), `secrets.${name} is used but not declared`);
    });

    test(`${file}: every Gitea job carries its enabling gate and every GitHub job its github.com guard`, () => {
        assert.deepEqual(Object.keys(gitea.jobs), Object.keys(github.jobs));
        for (const [name, job] of Object.entries(gitea.jobs)) {
            assert.equal(expression(job.if), spec.giteaGate, `Gitea job ${name} has the wrong gate`);
        }
        for (const [name, job] of Object.entries(github.jobs)) {
            assert.equal(expression(job.if), `github.server_url == ${HOST}`, `GitHub job ${name} has the wrong guard`);
        }
    });

    test(`${file}: the Gitea copy builds no link from the server URL and holds no GitHub-only machinery`, () => {
        const source = text(GITEA, file);
        const code = source
            .split("\n")
            .filter((line) => !/^\s*#/.test(line))
            .join("\n");
        for (const [, body] of code.matchAll(/\$\{\{([^}]*)\}\}/g)) {
            if (/server_url|api_url|GITHUB_SERVER_URL/.test(body)) {
                assert.equal(expression(body), spec.giteaGate, `an expression uses the server URL: ${body.trim()}`);
            }
        }
        for (const banned of ["RELEASE_APP", "changesets/action", "softprops", "create-github-app-token", "secrets: inherit"]) {
            assert.ok(!code.includes(banned), `${file} for Gitea mentions ${banned}`);
        }
        for (const [, ref] of code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
            assert.ok(!/^https?:/.test(ref), `uses: ${ref} names a host; use the bare owner/repo form`);
            if (ref.startsWith("HeroicLands/")) {
                assert.match(ref, /^HeroicLands\/\.github\/actions\/[a-z-]+@main$/, `unexpected shared action reference ${ref}`);
            }
        }
    });
}

test("release: the script names, the asset guard and the release asset list are the same on both forges", () => {
    const file = "release-foundry-package.yml";
    const a = stepsByName(load(GITHUB, file), "release");
    const b = stepsByName(load(GITEA, file), "release");

    for (const [name, script] of [
        ["Build the package", "npm run ${{ inputs.build-script }}"],
        ["Package the release", "npm run build:pack-release"],
    ]) {
        assert.equal(a.get(name).run, script, `GitHub "${name}"`);
        assert.equal(b.get(name).run, script, `Gitea "${name}"`);
    }

    const githubRelease = a.get("Create GitHub Release").with;
    const giteaRelease = b.get("Create GitHub Release").with;
    const files = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(files(giteaRelease.files), files(githubRelease.files), "the asset list differs");
    assert.deepEqual(files(githubRelease.files), [
        "build/dist/${{ inputs.package-kind }}.zip",
        "build/dist/${{ inputs.package-kind }}.json",
        "build/dist/*.jsonl",
        "build/dist/*.pdf",
    ]);
    assert.equal(giteaRelease["body-path"], githubRelease.body_path);
    assert.equal(giteaRelease.name, githubRelease.name);
    assert.equal(giteaRelease.prerelease, githubRelease.prerelease);
    assert.equal(giteaRelease["make-latest"], githubRelease.make_latest);
    assert.equal(giteaRelease.tag, githubRelease.tag_name);
});

test("release: the Gitea checkout takes the bot token and the whole history", () => {
    const checkout = stepsByName(load(GITEA, "release-foundry-package.yml"), "release").get("Checkout code");
    assert.equal(checkout.with.token, "${{ secrets.RELEASE_BOT_TOKEN }}");
    assert.equal(checkout.with["fetch-depth"], 0);
});

test("release: the Gitea resume block is the only difference in the decision, and it is present", () => {
    const file = "release-foundry-package.yml";
    const github = stepsByName(load(GITHUB, file), "release").get("Decide whether to release").run;
    const gitea = stepsByName(load(GITEA, file), "release").get("Decide whether to release").run;
    assert.notEqual(gitea, github, "the Gitea decision has no resume block");
    assert.equal(withoutResume(gitea), github);
    // The already-released guard and the tag computation are in the shared body.
    assert.match(github, /TAG="v\$VERSION"/);
    assert.match(github, /git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG"/);
    assert.match(github, /Tag \$TAG already exists — nothing to release\./);
});

test("deploy: the completeness guard names the bounds and refuses on both sides of them", () => {
    const file = "deploy-package-site.yml";
    for (const forge of [GITHUB, GITEA]) {
        const steps = stepsByName(load(forge, file), "deploy");
        const guard = steps.get("Verify the tree is a complete site");
        assert.equal(guard.env.MIN, "${{ steps.pkg.outputs.min }}", forge);
        assert.equal(guard.env.MAX, "${{ steps.pkg.outputs.max }}", forge);
        assert.match(guard.run, /"\$pages" -lt "\$MIN"/, forge);
        assert.match(guard.run, /"\$MAX" -gt 0 \] && \[ "\$pages" -gt "\$MAX"/, forge);
        const bounds = steps.get("Read the package and the bounds it declares");
        assert.equal(bounds.env.MIN_IN, "${{ inputs.min-pages }}", forge);
        assert.equal(bounds.env.MAX_IN, "${{ inputs.max-pages }}", forge);
        assert.equal(steps.get("Build the site").run, 'npm run "$BUILD_SCRIPT"', forge);
        assert.equal(steps.get("Build the site").env.BUILD_SCRIPT, "${{ inputs.build-script }}", forge);
    }
});

test("deploy: the Gitea build step is given no forge token", () => {
    const build = stepsByName(load(GITEA, "deploy-package-site.yml"), "deploy").get("Build the site");
    assert.deepEqual(Object.keys(build.env), ["BUILD_SCRIPT"]);
});

test("deploy: the upload step is the same on both forges", () => {
    const upload = (forge) =>
        stepsByName(load(forge, "deploy-package-site.yml"), "deploy").get("Deploy to Cloudflare Pages (production)");
    assert.deepEqual(upload(GITEA), upload(GITHUB));
});

test("the pull-request workflows are the same file on both forges", () => {
    for (const file of ["changesets.yml", "no-attribution.yml"]) {
        assert.deepEqual(load(GITEA, file), load(GITHUB, file), file);
    }
});

test("every Gitea workflow file has a GitHub counterpart, apart from the parity check itself", () => {
    const names = (forge) => readdirSync(new URL(`${forge}/workflows/`, root)).sort();
    assert.deepEqual(
        names(GITEA).filter((name) => name !== "workflow-parity.yml"),
        names(GITHUB),
    );
});
