/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * The reusable workflows in `.gitea/workflows/` are the only copies: every check
 * runs on Gitea, and the one GitHub workflow a package carries is its own
 * `release.yml`. These tests hold what each reusable workflow promises its
 * callers: the build contract, a completeness guard, an already-released guard,
 * an asset list, its secrets and its gate. Every step that carries a `run:` body
 * is read from the Gitea file, so a renamed, added or removed step fails here
 * rather than going unnoticed.
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

/** Labels a Gitea job may ask for: those the build host and its runners serve. */
const GITEA_LABELS = new Set(["ubuntu-latest", "ubuntu-vm", "x86", "linux", "light", "lint", "e2e", "book"]);

/** Fails when a `runs-on` is neither a declared label nor an input the caller chooses. */
function assertLabel(label) {
    // A label the caller chooses through an input is not a name to check.
    if (/^\$\{\{\s*inputs\.[A-Za-z0-9_-]+(\s*\|\|\s*'[a-z-]+')?\s*\}\}$/.test(label)) return;
    assert.ok(GITEA_LABELS.has(label), `runs-on: ${label} is not a declared runner label`);
}

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
        // The jobs the workflow splits into; the gate sits on the first, and
        // `book` is a separate job that depends on nothing here.
        giteaJobs: ["decide", "release"],
        giteaExtraJobs: ["book"],
        giteaGate: `github.server_url != ${HOST} && vars.HL_RELEASE_ENABLED == 'true'`,
        secrets: ["RELEASE_BOT_TOKEN", "GH_RELEASE_TOKEN"],
    },
    "deploy-package-site.yml": {
        giteaJobs: ["deploy"],
        giteaExtraJobs: [],
        giteaGate: `github.server_url != ${HOST} && vars.HL_DEPLOY_ENABLED == 'true'`,
        secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
};

for (const [file, spec] of Object.entries(reusable)) {
    const gitea = load(GITEA, file);

    test(`${file}: the secrets the Gitea copy declares are exactly the ones it is passed`, () => {
        const declared = Object.keys(gitea.on.workflow_call.secrets ?? {}).sort();
        assert.deepEqual(declared, [...spec.secrets].sort());
        const used = new Set([...text(GITEA, file).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
        for (const name of used) assert.ok(declared.includes(name), `secrets.${name} is used but not declared`);
    });

    test(`${file}: every job carries its enabling gate or depends on the one that does`, () => {
        assert.deepEqual(
            Object.keys(gitea.jobs).filter((name) => !spec.giteaExtraJobs.includes(name)),
            spec.giteaJobs,
            "the workflow's jobs differ from the declared split",
        );
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

    test(`${file}: the workflow builds no link from the server URL and holds no GitHub-only machinery`, () => {
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
            assert.ok(!code.includes(banned), `${file} mentions ${banned}`);
        }
        for (const [, ref] of code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
            assert.ok(!/^https?:/.test(ref), `uses: ${ref} names a host; use the bare owner/repo form`);
            if (ref.startsWith("HeroicLands/")) {
                assert.match(ref, /^HeroicLands\/\.github\/actions\/[a-z-]+@main$/, `unexpected shared action reference ${ref}`);
            }
        }
    });
}

test("release: the script names, the asset guard and the release asset list", () => {
    const file = "release-foundry-package.yml";
    const b = stepsByName(load(GITEA, file), ["decide", "release"]);

    assert.equal(b.get("Build the package").run, "npm run ${{ inputs.build-script }}");
    // With the books built elsewhere the package script is told to leave them
    // out; without them it is the script as written.
    const packaging = b.get("Package the release");
    assert.match(packaging.run, /npm run build:pack-release -- --no-pdf/);
    assert.match(packaging.run, /^\s*npm run build:pack-release$/m);

    const files = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(files(b.get("Create GitHub Release").with.files), [
        "build/dist/${{ inputs.package-kind }}.zip",
        "build/dist/${{ inputs.package-kind }}.json",
        "build/dist/*.jsonl",
        "build/dist/icons.zip",
        "build/dist/images.zip",
        "${{ steps.books.outputs.files }}",
    ]);
});

test("release: the checkout takes the bot token and the whole history", () => {
    const checkout = stepsByName(load(GITEA, "release-foundry-package.yml"), "decide").get("Checkout code");
    assert.equal(checkout.with.token, "${{ secrets.RELEASE_BOT_TOKEN }}");
    assert.equal(checkout.with["fetch-depth"], 0);
});

test("release: the decision carries the resume block, the already-released guard and the tag", () => {
    const run = stepsByName(load(GITEA, "release-foundry-package.yml"), "decide").get("Decide whether to release").run;
    assert.match(run, /# RESUME-BEGIN/);
    assert.notEqual(withoutResume(run), run, "the decision has no resume block");
    assert.match(run, /TAG="v\$VERSION"/);
    assert.match(run, /git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG"/);
    assert.match(run, /Tag \$TAG already exists — nothing to release\./);
});

test("deploy: the completeness guard names the bounds and refuses on both sides of them", () => {
    const steps = stepsByName(load(GITEA, "deploy-package-site.yml"), "deploy");
    const guard = steps.get("Verify the tree is a complete site");
    assert.equal(guard.env.MIN, "${{ steps.pkg.outputs.min }}");
    assert.equal(guard.env.MAX, "${{ steps.pkg.outputs.max }}");
    assert.match(guard.run, /"\$pages" -lt "\$MIN"/);
    assert.match(guard.run, /"\$MAX" -gt 0 \] && \[ "\$pages" -gt "\$MAX"/);
    const bounds = steps.get("Read the package and the bounds it declares");
    assert.equal(bounds.env.MIN_IN, "${{ inputs.min-pages }}");
    assert.equal(bounds.env.MAX_IN, "${{ inputs.max-pages }}");
    assert.equal(steps.get("Build the site").run, 'npm run "$BUILD_SCRIPT"');
    assert.equal(steps.get("Build the site").env.BUILD_SCRIPT, "${{ inputs.build-script }}");
});

test("deploy: the build step is given no forge token", () => {
    const build = stepsByName(load(GITEA, "deploy-package-site.yml"), "deploy").get("Build the site");
    assert.deepEqual(Object.keys(build.env), ["BUILD_SCRIPT"]);
});

test("every runs-on in a Gitea workflow is a declared label", () => {
    let checked = 0;
    for (const file of readdirSync(new URL(`${GITEA}/workflows/`, root))) {
        for (const job of Object.values(load(GITEA, file).jobs ?? {})) {
            if (!("runs-on" in job)) continue;
            assertLabel(job["runs-on"]);
            checked += 1;
        }
    }
    assert.ok(checked > 0, "no runs-on was checked");
});

test("a runs-on without a declared label is refused", () => {
    assert.throws(() => assertLabel("gpu"), /not a declared runner label/);
    assert.doesNotThrow(() => assertLabel("light"));
    assert.doesNotThrow(() => assertLabel("ubuntu-vm"));
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
