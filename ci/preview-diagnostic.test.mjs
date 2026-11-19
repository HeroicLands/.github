/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("capacity commands track the shared preview build", () => {
    const build = parse(read(".gitea/workflows/build-internal-preview.yml"));
    const diagnostic = parse(read(".gitea/workflows/diagnose-preview-capacity.yml")).jobs.capacity;
    assert.equal(build.jobs.build.container.image, diagnostic.container.image);
    assert.equal(build.jobs.build.container.options, "--memory=4g --memory-swap=4g");
    assert.equal(
        build.jobs.build.steps.find((step) => step.name === "Install and build").env.NODE_OPTIONS,
        "--max-old-space-size=3072",
    );
    const run = build.jobs.build.steps.find((step) => step.name === "Install and build").run;
    const expected = run
        .trim()
        .split("\n")
        .map((line) => line.trim());
    const measured = read("ci/preview-diagnostic/measure.sh")
        .split("\n")
        .filter((line) => /^measure (install|dependencies|site) /.test(line))
        .map((line) => line.replace(/^measure \S+ /, ""));
    assert.deepEqual(measured, expected);
});

test("capacity telemetry has GNU time in the bounded job container", () => {
    const job = parse(read(".gitea/workflows/diagnose-preview-capacity.yml")).jobs.capacity;
    assert.equal(job["runs-on"], "ubuntu-vm");
    assert.equal(job["timeout-minutes"], 30);
    const setup = job.steps.findIndex(
        (step) => step.name === "Install GNU time in the job container",
    );
    const measure = job.steps.findIndex(
        (step) => step.name === "Install and build with capacity telemetry",
    );
    assert.ok(setup >= 0 && setup < measure);
    assert.match(job.steps[setup].run, /test -f \/\.dockerenv && test "\$\(id -u\)" = 0/);
    assert.match(job.steps[setup].run, /apt-get install -y --no-install-recommends time/);
    assert.match(job.steps[setup].run, /\/usr\/bin\/time --version/);
    assert.equal(
        job.container.options,
        "${{ inputs.memory-profile == '4g' && '--memory=4g --memory-swap=4g' || '--memory=2g --memory-swap=2g' }}",
    );
    assert.equal(
        job.steps[measure].env.NODE_OPTIONS,
        "${{ inputs.memory-profile == '4g' && '--max-old-space-size=3072' || '--max-old-space-size=1536' }}",
    );
    const guard = job.steps.find((step) => step.name === "Verify measurement profile").run;
    assert.match(guard, /2g\) expected=2147483648/);
    assert.match(guard, /4g\) expected=4294967296/);
    assert.match(guard, /Invalid memory profile/);
    assert.match(guard, /memory\.max/);
});

test("receiver diagnostic stages only a fixed fixture and calls the guarded publisher", () => {
    const workflow = parse(read(".gitea/workflows/diagnose-preview-receiver.yml"));
    const { fixture, publish, cleanup } = workflow.jobs;
    const revision = "${{ github.sha }}";
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, [
        "publish",
        "cleanup",
    ]);
    assert.equal(
        fixture.if,
        "${{ github.ref == 'refs/heads/main' && inputs.operation == 'publish' }}",
    );
    assert.equal(fixture.permissions.contents, "read");
    const checkout = fixture.steps.find((step) => step.name === "Checkout reviewed shared helper");
    assert.equal(checkout.with.repository, "HeroicLands/.github");
    assert.equal(checkout.with.ref, revision);
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(
        fixture.steps.filter((step) => step.uses?.startsWith("actions/checkout@")).length,
        1,
    );
    assert.ok(
        fixture.steps.every((step) => !JSON.stringify(step).includes("PREVIEW_SSH_PRIVATE_KEY")),
    );
    const stage = fixture.steps.find((step) => step.name === "Stage a bounded fixture").run;
    assert.match(stage, /\[\[ "\$SOURCE_REPOSITORY" == HeroicLands\/\.github \]\]/);
    assert.match(stage, /\[\[ "\$PR_NUMBER" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
    assert.match(stage, /\[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    assert.match(stage, /publish\.mjs stage generated publication/);
    assert.match(stage, /index\.html/);
    assert.match(stage, /404\.html/);
    assert.match(stage, /generated\/_headers/);
    assert.equal(
        fixture.steps.find((step) => step.name === "Save fixture artifact").with.name,
        "preview-receiver-fixture",
    );
    for (const [operation, job] of Object.entries({ publish, cleanup })) {
        assert.equal(
            job.if,
            `\${{ github.ref == 'refs/heads/main' && inputs.operation == '${operation}' }}`,
        );
        assert.equal(job.uses, "./.gitea/workflows/deploy-internal-preview.yml");
        assert.equal(job.with["trusted-ref"], revision);
        assert.equal(job.with.operation, operation);
        assert.equal(job.with["pr-number"], "${{ inputs.pr-number }}");
        assert.equal(job.with["source-sha"], "${{ inputs.source-sha }}");
        assert.equal(job.with.package, "thalorna");
        assert.equal(job.with["min-pages"], 1);
        assert.deepEqual(Object.keys(job.secrets), ["PREVIEW_SSH_PRIVATE_KEY"]);
        assert.equal(job.secrets.PREVIEW_SSH_PRIVATE_KEY, "${{ secrets.PREVIEW_SSH_PRIVATE_KEY }}");
    }
    assert.equal(publish.needs, "fixture");
    assert.equal(publish.with["artifact-name"], "preview-receiver-fixture");
    assert.equal(cleanup.needs, undefined);
    const reusable = parse(read(".gitea/workflows/deploy-internal-preview.yml"));
    const publishStep = reusable.jobs.deploy.steps.find(
        (step) => step.name === "Publish or clean under the PR lock",
    );
    assert.match(publishStep.run, /preview-publish publication/);
    assert.match(publishStep.run, /preview-cleanup/);
});

test("diagnostic dispatches reject non-main refs and use their trusted source revision", () => {
    for (const name of ["capacity", "receiver"]) {
        const workflow = parse(read(`.gitea/workflows/diagnose-preview-${name}.yml`));
        const guard = workflow.jobs["trusted-dispatch"].steps[0];
        assert.equal(guard.env.DISPATCH_REF, "${{ github.ref }}");
        assert.match(guard.run, /test "\$DISPATCH_REF" = refs\/heads\/main/);
        for (const [jobName, job] of Object.entries(workflow.jobs)) {
            if (jobName === "trusted-dispatch") continue;
            assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
            for (const step of job.steps ?? []) {
                if (step.with?.repository === "HeroicLands/.github")
                    assert.equal(step.with.ref, "${{ github.sha }}");
            }
        }
    }
    assert.equal(
        parse(read(".gitea/workflows/diagnose-preview-capacity.yml")).on.workflow_dispatch.inputs[
            "memory-profile"
        ].default,
        "4g",
    );
});

test("preview builds use the shared runner while retaining resource and checkout guards", () => {
    for (const name of ["build-internal-preview", "diagnose-preview-capacity"]) {
        const workflow = parse(read(`.gitea/workflows/${name}.yml`));
        const job = workflow.jobs.build ?? workflow.jobs.capacity;
        assert.equal(job["runs-on"], "ubuntu-vm");
        assert.equal(job["timeout-minutes"], 30);
        const memory = job.steps.findIndex((step) =>
            ["Verify build memory limit", "Verify measurement profile"].includes(step.name),
        );
        assert.ok(
            memory >= 0 &&
                memory < job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@")),
        );
        assert.match(job.steps[memory].run, /memory\.max/);
        assert.match(job.steps[memory].run, /memory\.swap\.max/);
        assert.doesNotMatch(
            JSON.stringify(job),
            /DOCKER_HOST|CONTAINER_HOST|Reject container daemon access/,
        );
        // Workflow declarations do not prove the contents of the forge's task payload.
        assert.equal(workflow.on.workflow_call?.secrets, undefined);
        assert.doesNotMatch(JSON.stringify(job), /secrets\./);
        for (const step of job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")))
            assert.equal(step.with["persist-credentials"], false);
    }
});

test("PR CI executes the measurement helper regression suite", () => {
    const workflow = parse(read(".gitea/workflows/workflow-parity.yml"));
    assert.ok(
        workflow.jobs["workflow-parity"].steps.some((step) =>
            step.run?.includes("ci/preview-diagnostic/measure-command.test.mjs"),
        ),
    );
});

test("preview workflow documentation covers the declared callable input surface", () => {
    const guide = read("docs/internal-site-publishing.md");
    const documentedInputs = new Set(
        [...guide.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]),
    );
    for (const file of ["build-internal-preview", "deploy-internal-preview"]) {
        const workflow = parse(read(`.gitea/workflows/${file}.yml`));
        for (const name of Object.keys(workflow.on.workflow_call.inputs))
            assert.ok(
                documentedInputs.has(name),
                `${file} input ${name} needs a documented table row`,
            );
    }
    const workflow = parse(read(".gitea/workflows/deploy-internal-preview.yml"));
    assert.equal(workflow.permissions.actions, "read");
    const download = workflow.jobs.deploy.steps.find((step) => step.name === "Download pages");
    assert.match(download.run, /python3 -I .*download\.py publication/);
    assert.equal(download.env.RUN_ID, "${{ github.run_id }}");
    assert.equal(download.env.ARTIFACT_NAME, "${{ inputs.artifact-name }}");
    assert.equal(download.env.ARTIFACT_ID, "${{ inputs.artifact-id }}");
    assert.equal(download.env.PREVIEW_SSH_PRIVATE_KEY, undefined);
});

test("publication receives the exact uploader artifact ID through trusted job outputs", () => {
    const build = parse(read(".gitea/workflows/build-internal-preview.yml"));
    assert.equal(
        build.on.workflow_call.outputs["artifact-id"].value,
        "${{ jobs.build.outputs.artifact-id }}",
    );
    assert.equal(build.jobs.build.outputs["artifact-id"], "${{ steps.pages.outputs.artifact-id }}");
    const upload = build.jobs.build.steps.find((step) => step.id === "pages");
    assert.match(upload.uses, /^actions\/upload-artifact@/);
    assert.equal(upload.with.name, "${{ inputs.artifact-name }}");
    const diagnostic = parse(read(".gitea/workflows/diagnose-preview-receiver.yml"));
    assert.equal(
        diagnostic.jobs.fixture.outputs["artifact-id"],
        "${{ steps.pages.outputs.artifact-id }}",
    );
    assert.match(
        diagnostic.jobs.fixture.steps.find((step) => step.id === "pages").uses,
        /^actions\/upload-artifact@/,
    );
    assert.equal(
        diagnostic.jobs.publish.with["artifact-id"],
        "${{ needs.fixture.outputs.artifact-id }}",
    );
    assert.equal(diagnostic.jobs.cleanup.with["artifact-id"], undefined);
});
