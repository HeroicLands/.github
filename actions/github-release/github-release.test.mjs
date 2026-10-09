/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assetDifferences, checkManifests, contentType, githubRepository } from "./github-release.mjs";

const action = new URL("./github-release.mjs", import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const OWNER = "HeroicLands";
const REPO = "scratch-release";
const SITE = `https://github.com/${OWNER}/${REPO}`;
const TAG = "v0.1.0";

const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const isolated = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const key of Object.keys(isolated)) if (/^(GIT_(AUTHOR|COMMITTER)_|GITHUB_|RELEASE_)/.test(key)) delete isolated[key];
const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", ...args], { cwd, env: isolated, encoding: "utf8" }).trim();
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A Foundry manifest with the addresses `manifest.mjs` derives. */
const manifest = (over = {}) => ({
    id: "scratch",
    version: "0.1.0",
    manifest: `${SITE}/releases/latest/download/module.json`,
    download: `${SITE}/releases/download/${TAG}/module.zip`,
    flags: { metadataUrl: `${SITE}/releases/download/${TAG}/scratch-metadata.jsonl` },
    ...over,
});

/** A checkout with a tagged commit and the built release files. */
function checkout({ repository = `git+${SITE}.git`, annotated = false, module = manifest(), notes = "### Minor Changes\n\n- Maps load faster.\n" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "github-release-"));
    scratch.push(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch", version: "0.1.0", repository: { type: "git", url: repository } }));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): version packages");
    git(dir, "tag", ...(annotated ? ["-a", "-m", TAG] : []), TAG);
    mkdirSync(join(dir, "build/dist"), { recursive: true });
    writeFileSync(join(dir, "build/dist/module.json"), JSON.stringify(module, null, 2));
    writeFileSync(join(dir, "build/dist/module.zip"), Buffer.alloc(4096, 7));
    writeFileSync(join(dir, "build/dist/scratch-metadata.jsonl"), '{"id":"a"}\n');
    writeFileSync(join(dir, "build/release-notes.md"), notes);
    return { dir, commit: git(dir, "rev-parse", "HEAD"), local: (path) => readFileSync(join(dir, path)) };
}

/**
 * A fake of GitHub's REST API, its uploads host and the web host's download
 * redirects, on one server. Releases and refs are built from recorded
 * responses. `ref.after` is how many polls answer 404 before the tag appears.
 */
async function github({ ref, releases = [], latest, freezeLatest = false, shortBy = 0, redirectTag } = {}) {
    const state = { requests: [], releases: [], nextId: 500, nextAsset: 9000, latest, polls: 0 };
    const template = fixture("github-release.json");
    state.release = (fields) => {
        const r = structuredClone(template);
        const id = fields.id ?? state.nextId++;
        Object.assign(r, { id, draft: true, prerelease: false, assets: [], html_url: `${SITE}/releases/tag/${fields.tag_name}`, ...fields });
        r.assets = (fields.assets ?? []).map((a) => state.asset(a));
        state.releases.unshift(r);
        return r;
    };
    state.asset = ({ name, bytes, state: assetState = "uploaded", size }) => {
        const a = structuredClone(template.assets[0]);
        Object.assign(a, { id: state.nextAsset++, name, size: size ?? bytes.length, state: assetState, digest: digest(bytes) });
        return a;
    };
    for (const r of releases) state.release(r);

    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, "http://x");
        const path = url.pathname;
        const record = { method: req.method, path, query: url.search, headers: req.headers };
        if (raw.length && !path.startsWith("/uploads/")) record.json = JSON.parse(raw);
        if (path.startsWith("/uploads/")) record.length = raw.length;
        state.requests.push(record);
        const send = (status, json, headers = {}) => {
            res.writeHead(status, { "Content-Type": "application/json", ...headers });
            res.end(json === undefined ? "" : JSON.stringify(json));
        };
        const notFound = () => send(404, fixture("github-not-found.json"));
        const api = `/repos/${OWNER}/${REPO}`;

        if (req.method === "GET" && path === `${api}/git/ref/tags/${TAG}`) {
            state.polls++;
            if (!ref || state.polls <= (ref.after ?? 0)) return notFound();
            const body = structuredClone(fixture("github-ref-annotated.json"));
            body.ref = `refs/tags/${TAG}`;
            body.object = ref.annotated ? { ...body.object, sha: "a".repeat(40), type: "tag" } : { ...body.object, sha: ref.sha, type: "commit" };
            return send(200, body);
        }
        if (req.method === "GET" && path === `${api}/git/tags/${"a".repeat(40)}`) {
            const body = structuredClone(fixture("github-tag-object.json"));
            body.object = { ...body.object, sha: ref.sha, type: "commit" };
            return send(200, body);
        }
        if (req.method === "GET" && path === `${api}/releases/tags/${TAG}`) {
            const r = state.releases.find((x) => x.tag_name === TAG && !x.draft);
            return r ? send(200, r) : notFound();
        }
        if (req.method === "GET" && path === `${api}/releases/latest`) {
            const r = state.releases.find((x) => x.tag_name === state.latest && !x.draft);
            return r ? send(200, r) : state.latest ? send(200, state.release({ tag_name: state.latest, draft: false })) : notFound();
        }
        if (req.method === "GET" && path === `${api}/releases`) {
            const page = Number(url.searchParams.get("page"));
            const per = 2;
            const more = state.releases.length > page * per;
            return send(200, state.releases.slice((page - 1) * per, page * per),
                more ? { Link: `<https://api.github.com${api}/releases?per_page=100&page=${page + 1}>; rel="next"` } : {});
        }
        if (req.method === "POST" && path === `${api}/releases`) return send(201, state.release(record.json));
        let m = new RegExp(`^${api}/releases/(\\d+)$`).exec(path);
        if (m && req.method === "PATCH") {
            const r = state.releases.find((x) => x.id === Number(m[1]));
            const { make_latest, ...rest } = record.json;
            Object.assign(r, rest);
            if (!r.draft && make_latest === "true" && !freezeLatest) state.latest = r.tag_name;
            return send(200, r);
        }
        m = new RegExp(`^${api}/releases/(\\d+)/assets$`).exec(path);
        if (m && req.method === "GET") {
            const r = state.releases.find((x) => x.id === Number(m[1]));
            return send(200, Number(url.searchParams.get("page")) === 1 ? r.assets : []);
        }
        m = new RegExp(`^${api}/releases/assets/(\\d+)$`).exec(path);
        if (m && req.method === "DELETE") {
            for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[1]));
            res.writeHead(204);
            return res.end();
        }
        m = new RegExp(`^/uploads${api}/releases/(\\d+)/assets$`).exec(path);
        if (m && req.method === "POST") {
            const r = state.releases.find((x) => x.id === Number(m[1]));
            const a = state.asset({ name: url.searchParams.get("name"), bytes: raw, size: raw.length - shortBy });
            r.assets.push(a);
            return send(201, a);
        }
        m = new RegExp(`^/web/${OWNER}/${REPO}/releases/latest/download/(.+)$`).exec(path);
        if (m) {
            res.writeHead(302, { Location: `/web/${OWNER}/${REPO}/releases/download/${redirectTag ?? state.latest}/${m[1]}` });
            return res.end();
        }
        m = new RegExp(`^/web/${OWNER}/${REPO}/releases/download/([^/]+)/(.+)$`).exec(path);
        if (m) {
            const a = state.releases.find((x) => x.tag_name === m[1])?.assets.find((x) => x.name === m[2]);
            if (!a) return notFound();
            res.writeHead(302, { Location: `/cdn/${a.id}` });
            return res.end();
        }
        m = /^\/cdn\/(\d+)$/.exec(path);
        if (m) {
            const a = state.releases.flatMap((x) => x.assets).find((x) => x.id === Number(m[1]));
            res.writeHead(200, { "Content-Length": String(a.size) });
            return res.end();
        }
        send(404, { message: `no fake for ${req.method} ${path}` });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    after(() => server.close());
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.writes = () => state.requests.filter((r) => !["GET", "HEAD"].includes(r.method));
    return state;
}

const FILES = "build/dist/module.zip\nbuild/dist/module.json\nbuild/dist/*.jsonl\nbuild/dist/*.pdf";

/** Run the action in a checkout against the fake. */
function run(dir, fake, env = {}) {
    const out = join(dir, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [action], {
            cwd: dir,
            env: {
                ...isolated,
                GITHUB_OUTPUT: out,
                RELEASE_TOKEN: "gh-token",
                RELEASE_TAG: TAG,
                RELEASE_NAME: `Release ${TAG}`,
                RELEASE_BODY_PATH: "build/release-notes.md",
                RELEASE_PRERELEASE: "false",
                RELEASE_MAKE_LATEST: "true",
                RELEASE_FILES: FILES,
                RELEASE_WAIT_SECONDS: "1",
                RELEASE_POLL_SECONDS: "0.01",
                RELEASE_API_URL: fake.url,
                RELEASE_UPLOADS_URL: `${fake.url}/uploads`,
                RELEASE_SERVER_URL: `${fake.url}/web`,
                ...env,
            },
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

/** The three files the checkout builds, as the fake should end up holding them. */
const built = (c) => [
    { name: "module.zip", bytes: c.local("build/dist/module.zip") },
    { name: "module.json", bytes: c.local("build/dist/module.json") },
    { name: "scratch-metadata.jsonl", bytes: c.local("build/dist/scratch-metadata.jsonl") },
];

test("only a GitHub repository URL is accepted, in the shapes package.json writes it", () => {
    for (const url of [`git+${SITE}.git`, `${SITE}.git`, SITE, `${SITE}/`]) {
        assert.deepEqual(githubRepository({ url }), { owner: OWNER, repo: REPO, url: SITE });
    }
    assert.deepEqual(githubRepository(SITE), { owner: OWNER, repo: REPO, url: SITE });
    for (const url of ["https://git.pupluppy.org/HeroicLands/scratch-release", "git@github.com:HeroicLands/x.git", "https://github.com/HeroicLands", ""]) {
        assert.throws(() => githubRepository({ url }), /not https:\/\/github\.com\/<owner>\/<repo>/);
    }
});

test("content types follow the extension", () => {
    assert.equal(contentType("module.zip"), "application/zip");
    assert.equal(contentType("module.json"), "application/json");
    assert.equal(contentType("book.PDF"), "application/pdf");
    assert.equal(contentType("x-metadata.jsonl"), "application/octet-stream");
});

test("asset differences name what is missing, short, unfinished, altered or extra", () => {
    const files = [{ name: "a.zip", size: 3, digest: "sha256:1" }, { name: "b.json", size: 2, digest: "sha256:2" }];
    assert.deepEqual(assetDifferences(files, [{ name: "a.zip", size: 3, state: "uploaded", digest: "sha256:1" }, { name: "b.json", size: 2, state: "uploaded" }]), []);
    assert.deepEqual(
        assetDifferences(files, [{ name: "a.zip", size: 2, state: "uploaded" }, { name: "c.pdf", size: 1, state: "uploaded" }]),
        ["a.zip is 2 bytes, not 3", "b.json is missing", "c.pdf is not one of this release's files"],
    );
    assert.deepEqual(assetDifferences(files.slice(0, 1), [{ name: "a.zip", size: 3, state: "starter" }]), ["a.zip is starter, not uploaded"]);
    assert.deepEqual(assetDifferences(files.slice(0, 1), [{ name: "a.zip", size: 3, digest: "sha256:9" }]), ["a.zip has digest sha256:9, not sha256:1"]);
});

test("a manifest must point at releases/latest for itself and at this tag's assets", () => {
    const c = checkout();
    const files = (names) => names.map((name) => ({ name, path: join(c.dir, "build/dist", name) }));
    const all = files(["module.zip", "module.json", "scratch-metadata.jsonl"]);
    assert.equal(checkManifests(all, SITE, TAG), 1);
    assert.throws(() => checkManifests(files(["module.zip", "module.json"]), SITE, TAG), /flags\.metadataUrl is .* not .*<an asset of this release>/);
    assert.throws(() => checkManifests(all, SITE, "v0.2.0"), /download is .*; .*version is "0\.1\.0", but the tag is v0\.2\.0/);
    writeFileSync(join(c.dir, "build/dist/module.json"), JSON.stringify(manifest({ manifest: `${SITE}/releases/download/${TAG}/module.json` })));
    assert.throws(() => checkManifests(all, SITE, TAG), /manifest is .*, not https:\/\/github\.com\/HeroicLands\/scratch-release\/releases\/latest\/download\/module\.json/);
    writeFileSync(join(c.dir, "build/dist/module.json"), JSON.stringify({ name: "not a manifest" }));
    assert.equal(checkManifests(all, SITE, TAG), 0);
});

test("a new release: waits for the tag, drafts, uploads, checks, publishes as Latest and proves the manifest address", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit, after: 2 } });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /on GitHub at .* \(poll 3\)/);

    const writes = fake.writes();
    assert.ok(!fake.requests.some((r) => r.path.includes("/git/") && r.method !== "GET"), "no git ref is written on GitHub");
    assert.deepEqual(writes.map((r) => `${r.method} ${r.path}`), [
        `POST /repos/${OWNER}/${REPO}/releases`,
        `POST /uploads/repos/${OWNER}/${REPO}/releases/500/assets`,
        `POST /uploads/repos/${OWNER}/${REPO}/releases/500/assets`,
        `POST /uploads/repos/${OWNER}/${REPO}/releases/500/assets`,
        `PATCH /repos/${OWNER}/${REPO}/releases/500`,
    ]);
    assert.deepEqual(writes[0].json, { tag_name: TAG, name: `Release ${TAG}`, body: "### Minor Changes\n\n- Maps load faster.\n", prerelease: false, draft: true });
    const uploads = writes.slice(1, 4).map((r) => [r.query, r.headers["content-type"], Number(r.headers["content-length"]), r.length]);
    assert.deepEqual(uploads, [
        ["?name=module.zip", "application/zip", 4096, 4096],
        ["?name=module.json", "application/json", c.local("build/dist/module.json").length, c.local("build/dist/module.json").length],
        ["?name=scratch-metadata.jsonl", "application/octet-stream", 11, 11],
    ]);
    assert.deepEqual(writes[4].json, { draft: false, prerelease: false, make_latest: "true" });
    assert.ok(fake.requests.every((r) => r.path.startsWith("/web") || r.path.startsWith("/cdn") || r.headers.authorization === "Bearer gh-token"));
    assert.ok(fake.requests.filter((r) => r.path.startsWith("/web") || r.path.startsWith("/cdn")).every((r) => !r.headers.authorization && r.method === "HEAD"));
    assert.deepEqual(
        fake.requests.filter((r) => r.path.includes("/latest/download/")).map((r) => r.path.split("/").pop()).sort(),
        ["module.json", "module.zip", "scratch-metadata.jsonl"],
    );
    assert.deepEqual(out.outputs, { "release-url": `${SITE}/releases/tag/${TAG}`, "release-id": "500" });
});

test("an annotated tag is followed to its commit", async () => {
    const c = checkout({ annotated: true });
    const fake = await github({ ref: { sha: c.commit, annotated: true } });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(fake.requests.some((r) => r.path === `/repos/${OWNER}/${REPO}/git/tags/${"a".repeat(40)}`));
});

test("a mirrored tag at a different commit stops the release before anything is written", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: "b".repeat(40) } });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^repos/${OWNER}/${REPO}/git/ref/tags/${TAG}: error: names commit b{40} on GitHub, but ${TAG} is ${c.commit} here`, "m"));
    assert.deepEqual(fake.writes(), []);
    assert.ok(!fake.requests.some((r) => r.path.includes("/releases")));
});

test("a tag the mirror never delivers times out", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit, after: 1e9 } });
    const out = await run(c.dir, fake, { RELEASE_WAIT_SECONDS: "0.2", RELEASE_POLL_SECONDS: "0.05" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^repos/${OWNER}/${REPO}/git/ref/tags/${TAG}: error: the push mirror has not delivered ${TAG} to GitHub after 0\\.2 s; re-run once it has`, "m"));
    assert.ok(fake.polls >= 2);
    assert.deepEqual(fake.writes(), []);
});

test("a published release with exactly these assets is a no-op", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit }, latest: TAG, releases: [{ id: 42, tag_name: TAG, draft: false, assets: built(c) }] });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /already published with these assets; nothing to do/);
    assert.deepEqual(fake.writes(), []);
    assert.deepEqual(out.outputs, { "release-url": `${SITE}/releases/tag/${TAG}`, "release-id": "42" });
});

test("a published release whose assets differ is refused, not overwritten", async () => {
    const c = checkout();
    const missing = await github({ ref: { sha: c.commit }, latest: TAG, releases: [{ id: 42, tag_name: TAG, draft: false, assets: built(c).slice(0, 2) }] });
    const out = await run(c.dir, missing);
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^repos/${OWNER}/${REPO}/releases/tags/${TAG}: error: ${TAG} is already published and differs: scratch-metadata\\.jsonl is missing\\. A published release is never edited here`, "m"));
    assert.deepEqual(missing.writes(), []);

    const altered = built(c);
    altered[0] = { name: "module.zip", bytes: Buffer.alloc(4096, 8) };
    const same = await github({ ref: { sha: c.commit }, latest: TAG, releases: [{ id: 42, tag_name: TAG, draft: false, assets: altered }] });
    const out2 = await run(c.dir, same);
    assert.equal(out2.status, 1);
    assert.match(out2.stderr, /module\.zip has digest sha256:[0-9a-f]+, not sha256:/);
    assert.deepEqual(same.writes(), []);
});

test("a draft on a later page is reused, and a stale or foreign asset on it is replaced", async () => {
    const c = checkout();
    const fake = await github({
        ref: { sha: c.commit },
        releases: [
            { id: 77, tag_name: TAG, draft: true, assets: [{ name: "module.zip", bytes: Buffer.from("stale") }, { name: "old.pdf", bytes: Buffer.from("x") }] },
            { id: 3, tag_name: "v0.0.3", draft: false },
            { id: 2, tag_name: "v0.0.2", draft: false },
        ],
    });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(fake.requests.filter((r) => r.path.endsWith("/releases") && r.method === "GET").map((r) => r.query), ["?per_page=100&page=1", "?per_page=100&page=2"]);
    const writes = fake.writes().map((r) => `${r.method} ${r.path}`);
    assert.ok(!writes.includes(`POST /repos/${OWNER}/${REPO}/releases`));
    assert.equal(writes.filter((w) => w.startsWith("DELETE")).length, 2);
    assert.equal(writes.at(-1), `PATCH /repos/${OWNER}/${REPO}/releases/77`);
    const draft = fake.releases.find((r) => r.id === 77);
    assert.equal(draft.draft, false);
    assert.deepEqual(draft.assets.map((a) => [a.name, a.size]).sort(), [["module.json", c.local("build/dist/module.json").length], ["module.zip", 4096], ["scratch-metadata.jsonl", 11]]);
});

test("an upload that lands at the wrong size leaves the draft unpublished", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit }, shortBy: 1 });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^repos\/HeroicLands\/scratch-release\/releases\/500\/assets: error: the draft's assets do not match after upload: module\.zip is 4095 bytes, not 4096; module\.json is \d+ bytes/m);
    assert.ok(!fake.writes().some((r) => r.method === "PATCH"));
    assert.equal(fake.releases.find((r) => r.id === 500).draft, true);
});

test("a release meant to be Latest that /releases/latest does not name fails", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit }, latest: "v0.0.9", freezeLatest: true, releases: [{ tag_name: "v0.0.9", draft: false }] });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^repos/${OWNER}/${REPO}/releases/latest: error: names v0\\.0\\.9, not ${TAG}: the manifest address still serves another version`, "m"));
    assert.equal(fake.requests.filter((r) => r.path.endsWith("/releases/latest")).length, 5);
    assert.equal(out.outputs["release-url"], undefined);
});

test("releases/latest/download that redirects to another tag fails", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit }, redirectTag: "v0.0.9" });
    const out = await run(c.dir, fake);
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`^${OWNER}/${REPO}/releases/latest/download/module\\.zip: error: redirects to .*/releases/download/v0\\.0\\.9/module\\.zip, not to ${TAG}'s module\\.zip`, "m"));
});

test("a prerelease is published without Latest, and is not served as Latest", async () => {
    const c = checkout();
    const fake = await github({ ref: { sha: c.commit }, latest: "v0.0.9", releases: [{ tag_name: "v0.0.9", draft: false }] });
    const out = await run(c.dir, fake, { RELEASE_PRERELEASE: "true", RELEASE_MAKE_LATEST: "false" });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(fake.writes().at(-1).json, { draft: false, prerelease: true, make_latest: "false" });
    assert.ok(!fake.requests.some((r) => r.path.startsWith("/web")));
});

test("inputs that cannot be right stop the run before any request", async () => {
    const cases = [
        [{}, { RELEASE_PRERELEASE: "true", RELEASE_MAKE_LATEST: "true" }, /^make-latest: error: is true for a prerelease/m],
        [{}, { RELEASE_PRERELEASE: "yes" }, /^prerelease: error: must be the literal true or false, not "yes"/m],
        [{}, { RELEASE_TOKEN: "" }, /^token: error: no token supplied/m],
        [{}, { RELEASE_FILES: "build/dist/*.pdf" }, /^files: error: no file matches/m],
        [{ repository: "https://git.pupluppy.org/HeroicLands/scratch-release" }, {}, /^package\.json: error: repository\.url is "https:\/\/git\.pupluppy\.org\/HeroicLands\/scratch-release", not https:\/\/github\.com/m],
        [{ module: manifest({ download: `${SITE}/releases/download/v0.0.9/module.zip` }) }, {}, /^build\/dist\/module\.json: error: download is .*v0\.0\.9.*Installed copies would not reach this release/m],
        [{ notes: "x".repeat(125001) }, {}, /^build\/release-notes\.md: error: is 125001 characters; a GitHub release body holds at most 125000/m],
        [{}, { RELEASE_TAG: "v9.9.9" }, /^tag: error: v9\.9\.9 is not a tag in this checkout|version is "0\.1\.0", but the tag is v9\.9\.9/m],
    ];
    for (const [shape, env, pattern] of cases) {
        const c = checkout(shape);
        const fake = await github({ ref: { sha: c.commit } });
        const out = await run(c.dir, fake, env);
        assert.equal(out.status, 1, `${JSON.stringify(env)} ${out.stdout}`);
        assert.match(out.stderr, pattern);
        assert.deepEqual(fake.requests, []);
    }
});
