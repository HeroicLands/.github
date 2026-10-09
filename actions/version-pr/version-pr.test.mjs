/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changelogSection, extraHeaderResets, findPull, nextPage, pendingChangesets, pullBody } from "./version-pr.mjs";

const action = new URL("./version-pr.mjs", import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const REPO = "HeroicLands/scratch-caller";

const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Git with no global or system configuration, so nothing on this machine leaks in. */
const isolated = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const key of Object.keys(isolated)) if (/^(GIT_(AUTHOR|COMMITTER)_|GITHUB_)/.test(key)) delete isolated[key];
const who = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: isolated, encoding: "utf8" }).trim();

/**
 * A stand-in for `changeset version` plus the lockfile refresh: it consumes the
 * changesets, bumps the version, prepends a changelog section, commits when the
 * config says `"commit": true`, and then leaves a lockfile change uncommitted.
 */
const VERSION_SCRIPT = `
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
if (config.mode === "noop") process.exit(0);
const notes = readdirSync(".changeset").filter((n) => n.endsWith(".md") && n !== "README.md");
const bullets = notes.map((n) => "- " + readFileSync(".changeset/" + n, "utf8").split("---").pop().trim());
notes.forEach((n) => rmSync(".changeset/" + n));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = config.next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
const log = readFileSync("CHANGELOG.md", "utf8").replace(/^# .*\\n/, "");
writeFileSync("CHANGELOG.md", "# scratch\\n\\n## " + config.next + "\\n\\n### Minor Changes\\n\\n" + bullets.join("\\n") + "\\n" + log);
if (config.commit) {
    execFileSync("git", ["add", "-A"]);
    execFileSync("git", ["commit", "-q", "-m", "RELEASING: Releasing 1 package(s)"]);
}
writeFileSync("package-lock.json", JSON.stringify({ name: "scratch", version: config.next, lockfileVersion: 3 }) + "\\n");
`;

/** A working clone with a bare remote, `main` pushed, and the given changesets pending. */
function checkout({ commit = false, mode, changesets = { "brave-owls": "Maps load faster." } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "version-pr-"));
    scratch.push(dir);
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: isolated });
    execFileSync("git", ["init", "-q", "-b", "main", work], { env: isolated });
    git(work, "remote", "add", "origin", remote);
    mkdirSync(join(work, ".changeset"));
    writeFileSync(join(work, ".changeset/config.json"), JSON.stringify({ commit, mode, next: "0.1.0" }));
    writeFileSync(join(work, ".changeset/README.md"), "# Changesets\n");
    for (const [name, text] of Object.entries(changesets)) {
        writeFileSync(join(work, `.changeset/${name}.md`), `---\n"scratch": minor\n---\n\n${text}\n`);
    }
    writeFileSync(join(work, "version.mjs"), VERSION_SCRIPT);
    writeFileSync(
        join(work, "package.json"),
        JSON.stringify({ name: "scratch", version: "0.0.1", private: true, scripts: { "changeset:version": "node version.mjs" } }, null, 2) + "\n",
    );
    writeFileSync(join(work, "package-lock.json"), JSON.stringify({ name: "scratch", version: "0.0.1", lockfileVersion: 3 }) + "\n");
    writeFileSync(join(work, "CHANGELOG.md"), "# scratch\n\n## 0.0.1\n\n- The first release.\n");
    git(work, "add", "-A");
    git(work, ...who, "commit", "-q", "-m", "Start");
    git(work, "push", "-q", "origin", "main");
    return { dir, work, remote };
}

/**
 * A fake of the four Gitea endpoints. Open pull requests are built from the
 * recorded one; lists page at 50 with a `Link` to a host this run cannot reach,
 * so following the link rather than its page number fails the test.
 */
async function gitea({ pulls = [], fail = {}, merge = { status: 201, body: "" } } = {}) {
    const state = { pulls: pulls.map((p) => pullFrom(p)), requests: [], next: 100 };
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const url = new URL(req.url, "http://x");
        const key = `${req.method} ${url.pathname}`;
        state.requests.push({ key, query: url.search, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
        const send = (status, json, headers = {}) => {
            res.writeHead(status, { "Content-Type": "application/json", ...headers });
            res.end(json === undefined ? "" : JSON.stringify(json));
        };
        if (fail[key]) return send(fail[key].status, fail[key].json);
        const base = `/api/v1/repos/${REPO}/pulls`;
        if (key === "GET /api/v1/user") return send(200, fixture("gitea-user.json"));
        if (key === `GET ${base}`) {
            const page = Number(url.searchParams.get("page"));
            const open = state.pulls.filter((p) => p.state === "open");
            const headers = open.length > page * 50
                ? { Link: `<https://git.example.invalid/api/v1/repos/${REPO}/pulls?limit=50&page=${page + 1}&state=open>; rel="next",<https://git.example.invalid/x?page=9>; rel="last"` }
                : {};
            return send(200, open.slice((page - 1) * 50, page * 50), headers);
        }
        if (key === `POST ${base}`) {
            const pr = pullFrom({ number: state.next++, ...JSON.parse(body) });
            state.pulls.push(pr);
            return send(201, pr);
        }
        const one = new RegExp(`^${base}/(\\d+)(/merge)?$`).exec(url.pathname);
        if (one && req.method === "PATCH") {
            const pr = state.pulls.find((p) => p.number === Number(one[1]));
            Object.assign(pr, JSON.parse(body));
            return send(201, pr);
        }
        if (one && one[2] && req.method === "POST") return send(merge.status, merge.status === 201 ? undefined : { message: merge.body });
        send(404, { message: "not found" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    after(() => server.close());
    state.url = `http://127.0.0.1:${server.address().port}/api/v1`;
    return state;
}

/** A pull request object shaped like the recorded one. */
function pullFrom({ number, head = "changeset-release/main", base = "main", title = "x", body = "", fork }) {
    const pr = structuredClone(fixture("gitea-pull.json"));
    Object.assign(pr, { number, id: number, title, body, state: "open", merged: false });
    pr.head.ref = head;
    pr.base.ref = base;
    if (fork) pr.head.repo.full_name = fork;
    return pr;
}

/** Run the action in a checkout against a fake forge. */
function run(work, forge, env = {}) {
    const out = join(work, "..", `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [action], {
            cwd: work,
            env: { ...isolated, GITHUB_API_URL: forge.url, GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: out, VERSION_PR_TOKEN: "bot-token", ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => {
            const outputs = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")));
            resolve({ status, stdout, stderr, outputs });
        });
    });
}

const remoteHead = (remote) => git(remote, "rev-parse", "refs/heads/changeset-release/main");

/** The release branch on the remote is exactly one commit on `base`, and carries the version. */
function assertOneCommit(remote, base) {
    const head = remoteHead(remote);
    assert.equal(git(remote, "rev-parse", `${head}^`), base);
    assert.equal(git(remote, "log", "-1", "--format=%s%n%an <%ae>%n%cn <%ce>", head),
        "chore(release): version packages\nheroiclands-bot <heroiclands-bot@heroiclands.org>\nheroiclands-bot <heroiclands-bot@heroiclands.org>");
    assert.equal(JSON.parse(git(remote, "show", `${head}:package.json`)).version, "0.1.0");
    assert.equal(JSON.parse(git(remote, "show", `${head}:package-lock.json`)).version, "0.1.0");
    assert.equal(git(remote, "ls-tree", "--name-only", `${head}:.changeset`), "README.md\nconfig.json");
}

test("pending changesets are the Markdown files under .changeset other than its README", () => {
    const { work } = checkout({ changesets: { b: "B", a: "A" } });
    assert.deepEqual(pendingChangesets(work), [".changeset/a.md", ".changeset/b.md"]);
    assert.deepEqual(pendingChangesets(join(work, "missing")), []);
});

test("the changelog section is everything between the first two version headings", () => {
    const text = "# pkg\n\n## 0.2.0\n\n### Minor Changes\n\n- New maps.\n\n## 0.1.0\n\n- Old.\n";
    assert.equal(changelogSection(text), "### Minor Changes\n\n- New maps.");
    assert.equal(changelogSection("# pkg\n"), "");
    assert.equal(pullBody("0.2.0", "- New maps."), "Merging this pull request releases v0.2.0.\n\n- New maps.\n");
});

test("the next page comes from the Link header's page number, not its address", () => {
    assert.equal(nextPage('<https://elsewhere.invalid/api/v1/x?limit=50&page=3>; rel="next",<https://elsewhere.invalid/x?page=9>; rel="last"'), 3);
    assert.equal(nextPage('<https://elsewhere.invalid/x?page=9>; rel="last"'), undefined);
    assert.equal(nextPage(null), undefined);
});

test("a fork's branch of the same name is not the release pull request", () => {
    const pulls = [pullFrom({ number: 1, fork: "someone/scratch-caller" }), pullFrom({ number: 2, base: "next" }), pullFrom({ number: 3 })];
    assert.equal(findPull(pulls, { repo: REPO, branch: "changeset-release/main", base: "main" }).number, 3);
});

test("every persisted extraheader is reset for the push", () => {
    assert.deepEqual(
        extraHeaderResets("http.http://atlas.example.invalid:3080/.extraheader AUTHORIZATION: basic eA==\nhttp.https://github.com/.extraheader AUTHORIZATION: basic eQ==\n"),
        ["-c", "http.http://atlas.example.invalid:3080/.extraheader=", "-c", "http.https://github.com/.extraheader="],
    );
    assert.deepEqual(extraHeaderResets(""), []);
});

test("no changesets: reports false, calls nothing and pushes nothing", async () => {
    const { work, remote } = checkout({ changesets: {} });
    const forge = await gitea();
    const out = await run(work, forge);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.outputs, { "has-changesets": "false" });
    assert.deepEqual(forge.requests, []);
    assert.equal(git(remote, "branch", "--list", "changeset-release/main"), "");
});

test("a version script that does not commit ends as one commit on the base, and the pull request is opened and scheduled", async () => {
    const { work, remote } = checkout({ commit: false });
    git(work, "config", "http.https://example.invalid/.extraheader", "AUTHORIZATION: basic c3RhbGU=");
    const base = git(work, "rev-parse", "HEAD");
    const forge = await gitea({ pulls: [{ number: 7, head: "feature/7_x" }] });
    const out = await run(work, forge);
    assert.equal(out.status, 0, out.stderr);
    assertOneCommit(remote, base);
    assert.deepEqual(out.outputs, { "has-changesets": "true", "pr-number": "100" });
    const keys = forge.requests.map((r) => r.key);
    assert.deepEqual(keys, [
        "GET /api/v1/user",
        `GET /api/v1/repos/${REPO}/pulls`,
        `POST /api/v1/repos/${REPO}/pulls`,
        `POST /api/v1/repos/${REPO}/pulls/100/merge`,
    ]);
    assert.ok(forge.requests.every((r) => r.auth === "token bot-token"));
    const opened = forge.requests[2].body;
    assert.deepEqual({ ...opened, body: undefined }, { head: "changeset-release/main", base: "main", title: "chore(release): version packages", body: undefined });
    assert.equal(opened.body, "Merging this pull request releases v0.1.0.\n\n### Minor Changes\n\n- Maps load faster.\n");
    assert.deepEqual(forge.requests[3].body, { Do: "squash", merge_when_checks_succeed: true });
});

test("a version script that commits on its own still ends as one commit on the base", async () => {
    const { work, remote } = checkout({ commit: true });
    const base = git(work, "rev-parse", "HEAD");
    const out = await run(work, await gitea());
    assert.equal(out.status, 0, out.stderr);
    assertOneCommit(remote, base);
});

test("an open pull request on the second page is updated, not duplicated", async () => {
    const { work } = checkout();
    const others = Array.from({ length: 52 }, (_, i) => ({ number: i + 1, head: `feature/${i + 1}_x` }));
    others[3] = { number: 4, fork: "someone/scratch-caller" };
    const forge = await gitea({ pulls: [...others, { number: 60, title: "old title", body: "old" }] });
    const out = await run(work, forge);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.outputs["pr-number"], "60");
    const lists = forge.requests.filter((r) => r.key === `GET /api/v1/repos/${REPO}/pulls`).map((r) => r.query);
    assert.deepEqual(lists, ["?state=open&limit=50&page=1", "?state=open&limit=50&page=2"]);
    const patch = forge.requests.find((r) => r.key === `PATCH /api/v1/repos/${REPO}/pulls/60`);
    assert.equal(patch.body.title, "chore(release): version packages");
    assert.match(patch.body.body, /^Merging this pull request releases v0\.1\.0\./);
    assert.ok(!forge.requests.some((r) => r.key === `POST /api/v1/repos/${REPO}/pulls`));
    assert.ok(forge.requests.some((r) => r.key === `POST /api/v1/repos/${REPO}/pulls/60/merge`));
});

test("a refused API call exits 1 with a finding naming the endpoint, the status and the body", async () => {
    const { work } = checkout();
    const forge = await gitea({ fail: { [`POST /api/v1/repos/${REPO}/pulls`]: { status: 403, json: { message: "user should have permission to write" } } } });
    const out = await run(work, forge);
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^repos/${REPO}/pulls: error: POST answered 403: .*user should have permission to write`, "m"));
    assert.equal(out.outputs["has-changesets"], undefined);
});

test("pending changesets that version nothing exit 1", async () => {
    const { work, remote } = checkout({ mode: "noop" });
    const out = await run(work, await gitea());
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^\.changeset\/config\.json: error: 1 changeset\(s\) are pending but `npm run changeset:version` changed nothing/m);
    assert.equal(git(remote, "branch", "--list", "changeset-release/main"), "");
});

test("a failing version script exits 1", async () => {
    const { work } = checkout();
    const out = await run(work, await gitea(), { VERSION_SCRIPT: "no-such-script" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^package\.json: error: `npm run no-such-script` exited/m);
});

test("no token exits 1 before anything runs", async () => {
    const { work } = checkout();
    const forge = await gitea();
    const out = await run(work, forge, { VERSION_PR_TOKEN: "" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^token: error: no token supplied/m);
    assert.deepEqual(forge.requests, []);
});

test("an already-scheduled merge is success; any other refusal of the schedule is not", async () => {
    const already = await run(checkout().work, await gitea({ merge: { status: 405, body: "pull request is already scheduled to auto merge when checks succeed [pull_id: 100]" } }));
    assert.equal(already.status, 0, already.stderr);
    assert.match(already.stdout, /already scheduled/);
    const refused = await run(checkout().work, await gitea({ merge: { status: 405, body: "Please try again later" } }));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`^repos/${REPO}/pulls/100/merge: error: POST answered 405: .*try again later`, "m"));
});

test("a re-run on the same base pushes nothing and keeps an edit made to the release note", async () => {
    const { dir, work, remote } = checkout();
    const forge = await gitea();
    assert.equal((await run(work, forge)).status, 0);

    // The owner edits the release note on the branch.
    const edit = join(dir, "edit");
    execFileSync("git", ["clone", "-q", "-b", "changeset-release/main", remote, edit], { env: isolated });
    writeFileSync(join(edit, "CHANGELOG.md"), readFileSync(join(edit, "CHANGELOG.md"), "utf8").replace("- Maps load faster.", "- Maps load much faster."));
    git(edit, ...who, "commit", "-q", "-am", "Edit the release note");
    git(edit, "push", "-q", "origin", "changeset-release/main");
    const edited = remoteHead(remote);

    git(work, "switch", "-q", "main");
    git(work, "reset", "-q", "--hard", "origin/main");
    const again = await run(work, forge);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already carries this version/);
    assert.equal(remoteHead(remote), edited);
    const patch = forge.requests.findLast((r) => r.key === `PATCH /api/v1/repos/${REPO}/pulls/100`);
    assert.match(patch.body.body, /Maps load much faster/);

    // A third run with nothing changed edits nothing.
    git(work, "switch", "-q", "main");
    git(work, "reset", "-q", "--hard", "origin/main");
    const before = forge.requests.length;
    assert.equal((await run(work, forge)).status, 0);
    assert.ok(!forge.requests.slice(before).some((r) => r.key.startsWith("PATCH")));
});

test("a new commit on the base regenerates the branch from scratch", async () => {
    const { work, remote } = checkout();
    const forge = await gitea();
    assert.equal((await run(work, forge)).status, 0);
    const first = remoteHead(remote);

    git(work, "switch", "-q", "main");
    git(work, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(work, ".changeset/quiet-moles.md"), '---\n"scratch": patch\n---\n\nTables sort by name.\n');
    git(work, "add", "-A");
    git(work, ...who, "commit", "-q", "-m", "Add a change");
    git(work, "push", "-q", "origin", "main");
    const base = git(work, "rev-parse", "HEAD");

    const out = await run(work, forge);
    assert.equal(out.status, 0, out.stderr);
    assert.notEqual(remoteHead(remote), first);
    assertOneCommit(remote, base);
    assert.match(git(remote, "show", `${remoteHead(remote)}:CHANGELOG.md`), /Tables sort by name\./);
    assert.ok(existsSync(join(work, "CHANGELOG.md")));
});
