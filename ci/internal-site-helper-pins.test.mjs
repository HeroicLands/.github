/* SPDX-License-Identifier: GPL-3.0-or-later */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const load = (forge, file) =>
    parse(readFileSync(new URL(`../${forge}/workflows/${file}`, import.meta.url), "utf8"));
const GITEA = ".gitea";

test("internal page and CDN adapters checkout the same immutable trusted helper from Gitea", () => {
    const pins = ["deploy-internal-site.yml", "publish-package-cdn.yml"].map((file) => {
        const workflow = load(GITEA, file);
        const trusted = Object.values(workflow.jobs)
            .flatMap((job) => job.steps ?? [])
            .filter((step) => step.with?.repository === "HeroicLands/.github");
        assert.equal(trusted.length, 1, `${file} must checkout exactly one trusted helper`);
        const step = trusted[0];
        assert.match(step.uses, /^actions\/checkout@[a-f0-9]{40}$/);
        assert.match(
            step.with.ref ?? "",
            /^[a-f0-9]{40}$/,
            `${file} helper ref must be a literal full commit`,
        );
        assert.equal(step.with.repository, "HeroicLands/.github");
        assert.equal(step.with["github-server-url"], "https://git.pupluppy.org");
        assert.equal(step.with["persist-credentials"], false);
        return step.with.ref;
    });
    assert.equal(pins[0], pins[1], "page and CDN helpers must advance together");
});
