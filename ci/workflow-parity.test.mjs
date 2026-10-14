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
import { describe, test } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const text = (forge, file) => readFileSync(new URL(`${forge}/workflows/${file}`, root), "utf8");
const load = (forge, file) => parse(text(forge, file));

/**
 * Gitea runner labels that stand for GitHub's hosted `ubuntu-latest`. GitHub
 * has no `light`, `lint` or `e2e` runners, so the GitHub copy of a job keeps
 * `ubuntu-latest` while the Gitea copy routes it to a lighter host.
 */
const GITEA_LABELS_FOR_GITHUB = {
    light: "ubuntu-latest",
    lint: "ubuntu-latest",
    e2e: "ubuntu-latest",
    book: "ubuntu-latest",
};

/** Labels a Gitea job may ask for: the mapped ones and those the build host serves. */
const GITEA_LABELS = new Set(["ubuntu-latest", "ubuntu-vm", "x86", "linux", ...Object.keys(GITEA_LABELS_FOR_GITHUB)]);

/** A Gitea `runs-on` as GitHub would spell it. A label in neither set throws. */
function githubLabel(label) {
    // A label the caller chooses through an input is not a name to map.
    if (/^\$\{\{\s*inputs\.[A-Za-z0-9_-]+(\s*\|\|\s*'[a-z-]+')?\s*\}\}$/.test(label)) return label;
    assert.ok(GITEA_LABELS.has(label), `runs-on: ${label} is not a runner label with a declared mapping`);
    return GITEA_LABELS_FOR_GITHUB[label] ?? label;
}

/** A Gitea workflow with every job's `runs-on` mapped to the GitHub label. */
function asGithub(workflow) {
    const jobs = Object.fromEntries(
        Object.entries(workflow.jobs ?? {}).map(([name, job]) => [
            name,
            "runs-on" in job ? { ...job, "runs-on": githubLabel(job["runs-on"]) } : job,
        ]),
    );
    return { ...workflow, jobs };
}

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
    const steps = [].concat(job).flatMap((name) => workflow.jobs[name].steps);
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
        // The Gitea copy splits the work into these jobs; the steps of
        // `giteaJobs` together are the steps of the GitHub `release` job, and
        // `book` is Gitea-only.
        giteaJobs: ["decide", "release"],
        giteaExtraJobs: ["book"],
        giteaGate: `github.server_url != ${HOST} && vars.HL_RELEASE_ENABLED == 'true'`,
        // Steps present only in the GitHub copy, with the reason they exist there.
        githubOnly: ["Mint the release app token"],
        // Steps present only in the Gitea copy.
        giteaOnly: [
            "Tag the release",
            "Find the declared books",
            "Checkout the release commit",
            "Setup Node for the release",
            "Install the release dependencies",
            "Take the release decision",
            "Fetch the books",
        ],
        // Shared steps whose Gitea body adds the book hand-over.
        differs: ["Package the release"],
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
        giteaJobs: ["deploy"],
        giteaExtraJobs: [],
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
    spec.differs ??= [];

    test(`${file}: the step lists differ only where declared`, () => {
        const githubNames = [...stepsByName(github, spec.job).keys()];
        const giteaNames = [...stepsByName(gitea, spec.giteaJobs).keys()];
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
        const b = stepsByName(gitea, spec.giteaJobs);
        let compared = 0;
        for (const [name, step] of a) {
            if (!b.has(name)) continue;
            const other = b.get(name);
            assert.equal(expression(other.if), expression(step.if), `"${name}": the condition differs`);
            assert.equal(other.id, step.id, `"${name}": the step id differs`);
            if (spec.differs.includes(name)) continue;
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
        // The workflow's outputs read the job that always runs: `decide` on
        // Gitea, where `release` is skipped when there is nothing to release.
        const giteaOutputs = JSON.parse(
            JSON.stringify(gitea.on.workflow_call.outputs ?? {}).replaceAll("jobs.decide.outputs", "jobs.release.outputs"),
        );
        assert.deepEqual(giteaOutputs, github.on.workflow_call.outputs ?? {}, "the outputs differ");
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
        assert.deepEqual(
            Object.keys(gitea.jobs).filter((name) => !spec.giteaExtraJobs.includes(name) && !spec.giteaJobs.includes(name)),
            [],
            "the Gitea copy has a job nothing declares",
        );
        assert.deepEqual(
            Object.keys(gitea.jobs).filter((name) => !spec.giteaExtraJobs.includes(name)).filter((name) => name !== spec.job),
            spec.giteaJobs.filter((name) => name !== spec.job),
            "the Gitea copy's jobs differ from the declared split",
        );
        assert.ok(spec.job in gitea.jobs);
        // The gate sits on the first job. A later job of the split depends on
        // it and carries no gate of its own, so it never runs without it.
        for (const [name, job] of Object.entries(gitea.jobs)) {
            if (name === spec.giteaJobs[0]) {
                assert.equal(expression(job.if), spec.giteaGate, `Gitea job ${name} has the wrong gate`);
            } else {
                assert.ok(
                    [].concat(job.needs).includes(spec.giteaJobs[0]),
                    `Gitea job ${name} does not depend on ${spec.giteaJobs[0]}, which carries the gate`,
                );
            }
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
    const b = stepsByName(load(GITEA, file), ["decide", "release"]);

    for (const [name, script] of [
        ["Build the package", "npm run ${{ inputs.build-script }}"],
        ["Package the release", "npm run build:pack-release"],
    ]) {
        assert.equal(a.get(name).run, script, `GitHub "${name}"`);
        if (name === "Package the release") continue;
        assert.equal(b.get(name).run, script, `Gitea "${name}"`);
    }
    // With the books built elsewhere the package script is told to leave them
    // out; without them it is the script as written.
    const packaging = b.get("Package the release");
    assert.match(packaging.run, /npm run build:pack-release -- --no-pdf/);
    assert.match(packaging.run, /^\s*npm run build:pack-release$/m);

    for (const name of ["List the declared books", "Read changelog section for this version", "The assets exist"]) {
        assert.equal(a.get(name).run, b.get(name).run, `"${name}" differs between the forges`);
    }

    const githubRelease = a.get("Create GitHub Release").with;
    const giteaRelease = b.get("Create GitHub Release").with;
    const files = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(files(giteaRelease.files), files(githubRelease.files), "the asset list differs");
    assert.deepEqual(files(githubRelease.files), [
        "build/dist/${{ inputs.package-kind }}.zip",
        "build/dist/${{ inputs.package-kind }}.json",
        "build/dist/*.jsonl",
        "build/dist/icons.zip",
        "build/dist/images.zip",
        "${{ steps.books.outputs.files }}",
    ]);
    assert.equal(giteaRelease["body-path"], githubRelease.body_path);
    assert.equal(giteaRelease.name, githubRelease.name);
    assert.equal(giteaRelease.prerelease, githubRelease.prerelease);
    assert.equal(giteaRelease["make-latest"], githubRelease.make_latest);
    assert.equal(giteaRelease.tag, githubRelease.tag_name);
});

test("release: the Gitea checkout takes the bot token and the whole history", () => {
    const checkout = stepsByName(load(GITEA, "release-foundry-package.yml"), "decide").get("Checkout code");
    assert.equal(checkout.with.token, "${{ secrets.RELEASE_BOT_TOKEN }}");
    assert.equal(checkout.with["fetch-depth"], 0);
});

test("release: the Gitea resume block is the only difference in the decision, and it is present", () => {
    const file = "release-foundry-package.yml";
    const github = stepsByName(load(GITHUB, file), "release").get("Decide whether to release").run;
    const gitea = stepsByName(load(GITEA, file), "decide").get("Decide whether to release").run;
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
        assert.deepEqual(asGithub(load(GITEA, file)), load(GITHUB, file), file);
    }
});

test("every runs-on in a Gitea workflow is a declared label", () => {
    let checked = 0;
    for (const file of readdirSync(new URL(`${GITEA}/workflows/`, root))) {
        for (const job of Object.values(load(GITEA, file).jobs ?? {})) {
            if (!("runs-on" in job)) continue;
            githubLabel(job["runs-on"]);
            checked += 1;
        }
    }
    assert.ok(checked > 0, "no runs-on was checked");
});

test("a Gitea runs-on without a declared mapping is refused", () => {
    assert.throws(() => githubLabel("gpu"), /not a runner label/);
    assert.equal(githubLabel("light"), "ubuntu-latest");
    assert.equal(githubLabel("lint"), "ubuntu-latest");
    assert.equal(githubLabel("ubuntu-vm"), "ubuntu-vm");
});

/**
 * Gitea workflows with no GitHub copy: the parity check itself; the npm
 * release, whose GitHub half is each package's own `release.yml` because npm's
 * trusted publisher is bound to that file; and the full e2e run, which needs
 * the `e2e` runner and the Foundry stage it hosts; and the Renovate run, which
 * needs Gitea's API and the `lint` runner; and the CDN publish, whose credentials
 * live on Gitea.
 */
const GITEA_ONLY = [
    "workflow-parity.yml",
    "release-npm-package.yml",
    "e2e-full.yml",
    "renovate.yml",
    "publish-package-cdn.yml",
];

test("every Gitea workflow file has a GitHub counterpart, apart from the Gitea-only ones", () => {
    const names = (forge) => readdirSync(new URL(`${forge}/workflows/`, root)).sort();
    assert.deepEqual(
        names(GITEA).filter((name) => !GITEA_ONLY.includes(name)),
        names(GITHUB),
    );
    for (const name of GITEA_ONLY) assert.ok(names(GITEA).includes(name), `${name} is missing`);
});

/** The outputs an `actions/<name>/action.yml` in this repository declares. */
const actionOutputs = (name) =>
    Object.keys(parse(readFileSync(new URL(`actions/${name}/action.yml`, root), "utf8")).outputs ?? {});

test("every step output a Gitea workflow reads is one the shared action declares", () => {
    // An output name that does not exist reads as the empty string with no
    // error, so a renamed output silently skips every step gated on it.
    let checked = 0;
    for (const file of readdirSync(new URL(`${GITEA}/workflows/`, root))) {
        const workflow = load(GITEA, file);
        // Comments may quote a wrong spelling as the example of what breaks.
        const source = text(GITEA, file)
            .split("\n")
            .filter((line) => !/^\s*#/.test(line))
            .join("\n");
        for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
            const shared = new Map();
            for (const step of job.steps ?? []) {
                const match = /^HeroicLands\/\.github\/actions\/([a-z-]+)@main$/.exec(step.uses ?? "");
                if (match && step.id) shared.set(step.id, match[1]);
            }
            for (const [id, action] of shared) {
                const declared = actionOutputs(action);
                const pattern = new RegExp(`steps\\.${id}\\.outputs(?:\\.([A-Za-z0-9_]+)|\\['([^']+)'\\])`, "g");
                for (const m of source.matchAll(pattern)) {
                    const name = m[1] ?? m[2];
                    assert.ok(declared.includes(name), `${file} (${jobName}) reads steps.${id}.outputs ${name}, which actions/${action} does not declare`);
                    if (name.includes("-")) assert.equal(m[2], name, `${file} reads the kebab-case output ${name} without bracket notation`);
                    checked += 1;
                }
            }
        }
    }
    assert.ok(checked > 0, "no shared action output was checked");
});

describe("release-npm-package.yml", () => {
    const file = "release-npm-package.yml";
    const workflow = load(GITEA, file);
    const source = text(GITEA, file);
    const code = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    const steps = stepsByName(workflow, "release");

    test("its one job carries the Gitea gate and nothing else runs", () => {
        assert.deepEqual(Object.keys(workflow.jobs), ["release"]);
        assert.equal(expression(workflow.jobs.release.if), `github.server_url != ${HOST} && vars.HL_RELEASE_ENABLED == 'true'`);
        assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
    });

    test("it never publishes and holds no npm or GitHub credential", () => {
        for (const banned of [
            /npm\s+publish/,
            /deploy:npm/,
            /changeset\s+publish/,
            /id-token/,
            /NPM_TOKEN|NODE_AUTH_TOKEN/,
            /registry-url/,
            /GH_RELEASE_TOKEN|github-release/,
            /secrets:\s*inherit/,
            /changesets\/action|softprops|create-github-app-token|RELEASE_APP/,
        ]) {
            assert.doesNotMatch(code, banned, `${file} matches ${banned}`);
        }
        assert.deepEqual(Object.keys(workflow.on.workflow_call.secrets), ["RELEASE_BOT_TOKEN"]);
        const used = new Set([...code.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
        assert.deepEqual([...used], ["RELEASE_BOT_TOKEN"]);
        for (const step of steps.values()) {
            assert.ok(!/\bnpm\b(?!\s+ci\b)/.test(step.run ?? ""), `"${step.name}" runs npm for something other than ci`);
        }
    });

    test("it versions, then tags only when no changesets are pending", () => {
        assert.deepEqual([...steps.keys()], [
            "Checkout code",
            "Setup Node",
            "Install dependencies",
            "Create or update the Version Packages PR",
            "Tag the version commit",
        ]);
        const versionPr = steps.get("Create or update the Version Packages PR");
        assert.equal(versionPr.uses, "HeroicLands/.github/actions/version-pr@main");
        assert.equal(versionPr.id, "changesets");
        assert.equal(versionPr.with.token, "${{ secrets.RELEASE_BOT_TOKEN }}");
        const tag = steps.get("Tag the version commit");
        assert.equal(tag.uses, "HeroicLands/.github/actions/release-tag@main");
        assert.equal(tag.id, "tag");
        assert.equal(expression(tag.if), "steps.changesets.outputs['has-changesets'] == 'false'");
        assert.equal(steps.get("Install dependencies").run, "npm ci");
    });

    test("the checkout takes the bot token and the whole history", () => {
        const checkout = steps.get("Checkout code");
        assert.equal(checkout.with.token, "${{ secrets.RELEASE_BOT_TOKEN }}");
        assert.equal(checkout.with["fetch-depth"], 0);
    });

    test("it shares the Foundry release's concurrency shape and names no host", () => {
        assert.deepEqual(workflow.jobs.release.concurrency, {
            group: "npm-package-release-${{ github.repository }}",
            "cancel-in-progress": false,
        });
        assert.equal(workflow.jobs.release["runs-on"], "ubuntu-latest");
        for (const [, ref] of code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
            assert.ok(!/^https?:/.test(ref), `uses: ${ref} names a host; use the bare owner/repo form`);
        }
        for (const [, body] of code.matchAll(/\$\{\{([^}]*)\}\}/g)) {
            if (/server_url|api_url/.test(body)) {
                assert.equal(expression(body), `github.server_url != ${HOST} && vars.HL_RELEASE_ENABLED == 'true'`);
            }
        }
    });
});

describe("e2e-full.yml", () => {
    const file = "e2e-full.yml";
    const workflow = load(GITEA, file);
    const code = text(GITEA, file)
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    const steps = stepsByName(workflow, "e2e");

    test("it is only called, and takes the package and its build script", () => {
        assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
        const inputs = workflow.on.workflow_call.inputs;
        assert.deepEqual(Object.keys(inputs).sort(), ["build-script", "package", "s3"]);
        assert.equal(inputs.s3.default, false);
        assert.equal(inputs.s3.type, "boolean");
        assert.equal(inputs.package.required, true);
        assert.equal(inputs["build-script"].default, "build:noci");
        assert.equal(workflow.on.workflow_call.secrets, undefined);
    });

    test("its one job runs on the e2e label and holds no secret", () => {
        assert.deepEqual(Object.keys(workflow.jobs), ["e2e"]);
        assert.equal(workflow.jobs.e2e["runs-on"], "e2e");
        assert.doesNotMatch(code, /secrets\./);
        assert.deepEqual(workflow.permissions, { contents: "read" });
    });

    test("it builds, then runs the package's own e2e:full", () => {
        assert.deepEqual([...steps.keys()], [
            "Checkout code",
            "Place the package's settings",
            "Install dependencies",
            "Build the stage",
            "Run the full suite",
            "Upload the Cypress output",
            "Remove the package's settings",
        ]);
        assert.equal(steps.get("Build the stage").run, 'npm run "$BUILD_SCRIPT"');
        assert.equal(steps.get("Build the stage").env.BUILD_SCRIPT, "${{ inputs.build-script }}");
        assert.match(steps.get("Run the full suite").run, /^npm run e2e:full 2>&1 \| tee e2e-full\.log \|\| status=\$\?$/m);
        assert.match(steps.get("Run the full suite").run, /^exit "\$status"$/m);
        assert.equal(expression(steps.get("Upload the Cypress output").if), "failure()");
        assert.equal(expression(steps.get("Remove the package's settings").if), "always()");
    });

    test("an input reaches a script only through the environment", () => {
        for (const step of steps.values()) {
            assert.doesNotMatch(step.run ?? "", /\$\{\{\s*inputs\./, `"${step.name}" interpolates an input into its script`);
        }
    });

    test("the settings come from the runner's secrets directory and the data root from its e2e root", () => {
        const place = steps.get("Place the package's settings");
        assert.equal(place.env.PACKAGE, "${{ inputs.package }}");
        assert.equal(place.env.S3, "${{ inputs.s3 }}");
        assert.ok(place.run.includes('echo "FOUNDRYVTT_CONTAINER_S3=1"'));
        assert.ok(place.run.includes('echo "SOHL_E2E_S3=1"'));
        assert.match(place.run, /settings="\$HL_E2E_SECRETS\/\$PACKAGE\.env\.local"/);
        assert.match(place.run, /install -m 600 "\$settings" \.env\.local/);
        for (const line of [
            'echo "FOUNDRYVTT_TEST_DATA=$HL_E2E_ROOT/data"',
            'echo "FOUNDRYVTT_CACHE=$HL_E2E_ROOT/cache"',
            'echo "CYPRESS_CACHE_FOLDER=$HL_E2E_ROOT/cypress"',
        ]) {
            assert.ok(place.run.includes(line), `missing: ${line}`);
        }
    });
});

describe("release-foundry-package.yml: the book job", () => {
    const gitea = load(GITEA, "release-foundry-package.yml");
    const all = stepsByName(gitea, ["decide", "release"]);

    test("it runs on the runner the caller names, and only when one is named", () => {
        assert.equal(gitea.jobs.book["runs-on"], "${{ inputs.book-runner || 'ubuntu-latest' }}");
        assert.equal(gitea.on.workflow_call.inputs["book-runner"].default, "");
        assert.equal(gitea.on.workflow_call.inputs["book-runner"].required, false);
    });

    test("an empty book runner finds no books to hand over", () => {
        const step = gitea.jobs.decide.steps.find((s) => s.name === "Find the declared books");
        assert.match(step.run, /-z "\$BOOK_RUNNER"/);
        assert.equal(step.env.BOOK_RUNNER, "${{ inputs.book-runner }}");
    });

    test("the book job always runs and only its steps are gated; the release waits for it with a plain condition", () => {
        const opted = "needs.decide.outputs.release == 'true' && needs.decide.outputs.books == 'true' && inputs.book-runner != ''";
        assert.equal(gitea.jobs.book.if, undefined, "a skippable book job would skip the release");
        assert.deepEqual([].concat(gitea.jobs.book.needs), ["decide"]);
        const [note, ...work] = gitea.jobs.book.steps;
        assert.equal(note.if, undefined);
        assert.ok(work.length > 0);
        for (const step of work) assert.equal(expression(step.if), opted, `"${step.name}" is not gated on the opt-in`);
        assert.deepEqual([].concat(gitea.jobs.release.needs).sort(), ["book", "decide"]);
        const release = expression(gitea.jobs.release.if);
        assert.equal(release, "needs.decide.outputs.release == 'true'");
        assert.ok(!/always\(\)|\.result/.test(release), "a skipped need skips the job whatever always() says");
    });

    test("the release takes the books only when they were built", () => {
        const down = stepsByName(gitea, ["decide", "release"]).get("Fetch the books");
        assert.match(expression(down.if), /needs\.decide\.outputs\.books == 'true'/);
        const pack = stepsByName(gitea, ["decide", "release"]).get("Package the release");
        assert.equal(pack.env.BOOKS_PREBUILT, "${{ needs.decide.outputs.books == 'true' }}");
    });

    test("the books travel as one artifact, uploaded by the book job and downloaded by the release", () => {
        const up = gitea.jobs.book.steps.find((s) => /actions\/upload-artifact@/.test(s.uses ?? ""));
        const down = all.get("Fetch the books");
        assert.ok(up && down, "the artifact hand-over is missing a half");
        assert.equal(up.with.name, down.with.name);
        assert.equal(down.with.path, "build/dist");
        assert.equal(up.with["if-no-files-found"], "error");
    });

    test("the book job names no secret beyond the checkout token and reaches the script through the environment", () => {
        const source = JSON.stringify(gitea.jobs.book);
        assert.deepEqual([...new Set([...source.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]))], ["RELEASE_BOT_TOKEN"]);
        for (const step of gitea.jobs.book.steps) {
            assert.ok(!/\$\{\{/.test(step.run ?? ""), `"${step.name}" interpolates an expression into a shell body`);
        }
    });
});
