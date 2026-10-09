/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { taggedCommit, versionCommit, versionTag } from "./release-tag.mjs";

const action = new URL("./release-tag.mjs", import.meta.url).pathname;

const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Git with no global or system configuration, so nothing on this machine leaks in. */
const isolated = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const key of Object.keys(isolated)) if (/^(GIT_(AUTHOR|COMMITTER)_|GITHUB_)/.test(key)) delete isolated[key];
const who = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: isolated, encoding: "utf8" }).trim();

/** Write package.json with a version and commit it, returning the commit. */
function commitVersion(work, version, message, extra = {}) {
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "@scratch/pkg", version, ...extra }, null, 2) + "\n");
    git(work, "add", "-A");
    git(work, ...who, "commit", "-q", "-m", message);
    return git(work, "rev-parse", "HEAD");
}

/**
 * A clone with a bare remote. History on `main`: the 0.1.0 release, the
 * Version Packages commit for 0.2.0, a dependency bump that keeps 0.2.0, and
 * a change that does not touch package.json.
 */
function checkout() {
    const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
    scratch.push(dir);
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: isolated });
    execFileSync("git", ["init", "-q", "-b", "main", work], { env: isolated });
    git(work, "remote", "add", "origin", remote);
    mkdirSync(join(work, ".changeset"));
    writeFileSync(join(work, ".changeset/README.md"), "# Changesets\n");
    const first = commitVersion(work, "0.1.0", "Start");
    git(work, "push", "-q", "origin", `${first}:refs/tags/v0.1.0`);
    const bump = commitVersion(work, "0.2.0", "chore(release): version packages");
    const deps = commitVersion(work, "0.2.0", "Update a dependency", { dependencies: { yaml: "^2.8.1" } });
    writeFileSync(join(work, "README.md"), "# scratch\n");
    git(work, "add", "-A");
    git(work, ...who, "commit", "-q", "-m", "Document it");
    git(work, "push", "-q", "origin", "main");
    return { dir, work, remote, first, bump, deps, head: git(work, "rev-parse", "HEAD") };
}

/** Run the action in a checkout, returning its exit status, output and step outputs. */
function run(work) {
    const out = join(work, "..", `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    const child = spawnSync(process.execPath, [action], {
        cwd: work,
        env: { ...isolated, GITHUB_OUTPUT: out },
        encoding: "utf8",
    });
    const outputs = Object.fromEntries(
        readFileSync(out, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, outputs };
}

const remoteTag = (remote, tag) => {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
        cwd: remote,
        env: isolated,
        encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
};

test("versionTag: accepts X.Y.Z and a prerelease, refuses everything else", () => {
    assert.equal(versionTag("23.1.0"), "v23.1.0");
    assert.equal(versionTag("0.2.3"), "v0.2.3");
    assert.equal(versionTag("1.0.0-beta.1"), "v1.0.0-beta.1");
    for (const bad of ["1.2", "01.2.3", "1.2.3.4", "1.2.3+build.5", "v1.2.3", "", undefined, 1]) {
        assert.throws(() => versionTag(bad), /is not X\.Y\.Z/, String(bad));
    }
});

test("taggedCommit: an annotated tag's peeled commit wins over the tag object", () => {
    const listing = "aaa\trefs/tags/v1.0.0\nbbb\trefs/tags/v1.0.0^{}\n";
    assert.equal(taggedCommit(listing, "v1.0.0"), "bbb");
    assert.equal(taggedCommit("ccc\trefs/tags/v1.0.0\n", "v1.0.0"), "ccc");
    assert.equal(taggedCommit("ddd\trefs/tags/v1.0.0-rc\n", "v1.0.0"), undefined);
});

test("versionCommit: the commit that set the version, not HEAD and not a later package.json change", () => {
    const { work, bump, first } = checkout();
    assert.equal(versionCommit(work, "0.2.0"), bump);
    git(work, "checkout", "-q", first);
    assert.equal(versionCommit(work, "0.1.0"), first, "the root commit sets its own version");
});

test("versionCommit: a version HEAD does not declare is a finding", () => {
    const { work } = checkout();
    assert.throws(() => versionCommit(work, "9.9.9"), /no commit on the first-parent history/);
});

test("an untagged version is tagged at its version commit and pushed", () => {
    const { work, remote, bump, head } = checkout();
    assert.notEqual(head, bump);
    const result = run(work);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.outputs, { version: "0.2.0", tag: "v0.2.0", commit: bump, pushed: "true" });
    assert.equal(remoteTag(remote, "v0.2.0"), bump);
});

test("a re-run finds the tag at the version commit and pushes nothing", () => {
    const { work, remote, bump } = checkout();
    assert.equal(run(work).status, 0);
    const again = run(work);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.outputs.pushed, "false");
    assert.match(again.stdout, /already names the version commit/);
    assert.equal(remoteTag(remote, "v0.2.0"), bump);
});

test("a tag that exists elsewhere is left where it is, with a warning", () => {
    const { work, remote, deps } = checkout();
    git(work, "push", "-q", "origin", `${deps}:refs/tags/v0.2.0`);
    const result = run(work);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.pushed, "false");
    assert.match(result.stdout, /^package\.json: warning: v0\.2\.0 already exists at /m);
    assert.equal(remoteTag(remote, "v0.2.0"), deps);
});

test("pending changesets are refused before anything is read from the remote", () => {
    const { work, remote } = checkout();
    writeFileSync(join(work, ".changeset/brave-owls.md"), '---\n"@scratch/pkg": minor\n---\n\nMaps load faster.\n');
    const result = run(work);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\.changeset\/brave-owls\.md: error: 1 changeset\(s\) are pending/m);
    assert.equal(result.outputs.pushed, undefined);
    assert.equal(remoteTag(remote, "v0.2.0"), undefined);
});

test("a remote that cannot be read fails closed rather than reading as untagged", () => {
    const { work, dir } = checkout();
    git(work, "remote", "set-url", "origin", join(dir, "missing.git"));
    const result = run(work);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^git: error: `git ls-remote --exit-code --tags origin refs\/tags\/v0\.2\.0` exited 128/m);
    assert.equal(result.outputs.pushed, undefined);
});

test("a version that is not X.Y.Z is refused", () => {
    const { work, remote } = checkout();
    commitVersion(work, "0.3", "A bad bump");
    const result = run(work);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^package\.json: error: version "0\.3" is not X\.Y\.Z/m);
    assert.equal(remoteTag(remote, "v0.3"), undefined);
});
