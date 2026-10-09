/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { forgeOf } from "../lib/forge.mjs";
import { FORGE_ENV } from "../lib/fake-forge.mjs";
import { buildRegistry, currentLabels, diff, sync } from "./labels-core.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers });

/**
 * A label store that answers as each forge does. `honest: false` makes the
 * Gitea store answer a delete with 204 and remove nothing, as it does for an
 * address it does not recognise.
 */
function labelServer(style, initial, { pageSize = 50, honest = true } = {}) {
    let nextId = 100;
    const labels = initial.map((l) => ({ id: nextId++, description: "", exclusive: false, ...l }));
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(init.body) : undefined;
        const m = u.pathname.match(/\/repos\/o\/r\/labels(?:\/(.+))?$/);
        calls.push({ method, path: u.pathname, body });
        if (!m) return new Response("no", { status: 404 });
        if (method === "GET") {
            const page = Number(u.searchParams.get("page") ?? 1);
            const slice = labels.slice((page - 1) * pageSize, page * pageSize);
            const shown = slice.map((l) =>
                style === "gitea" ? { ...l, color: l.color } : { id: l.id, name: l.name, color: l.color, description: l.description },
            );
            const headers = {};
            if (style === "gitea") headers["X-Total-Count"] = String(labels.length);
            return json(shown, 200, headers);
        }
        if (method === "POST") {
            labels.push({ id: nextId++, description: "", exclusive: false, ...body });
            return json(body, 201);
        }
        const at =
            style === "gitea"
                ? labels.findIndex((l) => String(l.id) === m[1])
                : labels.findIndex((l) => l.name === decodeURIComponent(m[1]));
        if (method === "DELETE") {
            if (at >= 0 && honest) labels.splice(at, 1);
            return new Response(null, { status: 204 });
        }
        if (at < 0) return new Response("label does not exist", { status: 404 });
        const rename = style === "gitea" ? body.name : body.new_name;
        const { new_name: _n, name: _m, ...rest } = body;
        if (rename) labels[at].name = rename;
        Object.assign(labels[at], rest);
        return json(labels[at]);
    };
    return { labels, calls };
}

const registryOf = (...entries) =>
    buildRegistry(entries, JSON.stringify(entries), "labels.yml").registry;

const wanted = registryOf(
    { name: "keep", color: "#AABBCC", description: "kept" },
    { name: "recolor", color: "112233" },
    { name: "type/bug", color: "d73a4a", exclusive: true },
    { name: "fresh", color: "000000" },
);

const existing = [
    { name: "keep", color: "aabbcc", description: "kept" },
    { name: "recolor", color: "ffffff" },
    { name: "type/bug", color: "d73a4a" },
    { name: "stray", color: "123456" },
];

test("GitHub: labels are addressed by name and renamed with new_name", async () => {
    const forge = forgeOf(FORGE_ENV.github);
    const server = labelServer("github", existing);
    const current = await currentLabels(forge, "o/r", "t");
    const result = await sync(forge, "o/r", "t", wanted, current);
    assert.deepEqual(result, { created: 1, updated: 1, deleted: 1, remaining: [] });
    const patch = server.calls.find((c) => c.method === "PATCH");
    assert.equal(patch.path, "/repos/o/r/labels/recolor");
    assert.equal(patch.body.new_name, "recolor");
    assert.equal(patch.body.name, undefined);
    assert.equal(server.calls.find((c) => c.method === "DELETE").path, "/repos/o/r/labels/stray");
    assert.equal(server.calls.find((c) => c.method === "POST").body.exclusive, undefined);
    assert.deepEqual(server.labels.map((l) => l.name).sort(), ["fresh", "keep", "recolor", "type/bug"]);
});

test("GitHub: exclusive is not compared, so a declared scope never reads as drift", async () => {
    const forge = forgeOf(FORGE_ENV.github);
    labelServer("github", existing);
    const current = await currentLabels(forge, "o/r", "t");
    assert.equal(diff(forge, wanted, current).toUpdate.some((l) => l.name === "type/bug"), false);
});

test("Gitea: labels are addressed by id and renamed with name", async () => {
    const forge = forgeOf(FORGE_ENV.gitea);
    const server = labelServer("gitea", existing);
    const current = await currentLabels(forge, "o/r", "t");
    const result = await sync(forge, "o/r", "t", wanted, current);
    assert.deepEqual(result, { created: 1, updated: 2, deleted: 1, remaining: [] });
    const recolor = current.get("recolor");
    const patch = server.calls.find((c) => c.method === "PATCH" && c.path.endsWith(`/${recolor.id}`));
    assert.equal(patch.body.name, "recolor");
    assert.equal(patch.body.new_name, undefined);
    const del = server.calls.find((c) => c.method === "DELETE");
    assert.equal(del.path, `/api/v1/repos/o/r/labels/${current.get("stray").id}`);
    assert.equal(server.calls.find((c) => c.method === "POST").body.exclusive, false);
    assert.equal(server.labels.find((l) => l.name === "type/bug").exclusive, true);
    assert.deepEqual(server.labels.map((l) => l.name).sort(), ["fresh", "keep", "recolor", "type/bug"]);
});

test("Gitea: a delete answered 204 that removed nothing is caught by the read-back", async () => {
    const forge = forgeOf(FORGE_ENV.gitea);
    labelServer("gitea", existing, { honest: false });
    const current = await currentLabels(forge, "o/r", "t");
    const result = await sync(forge, "o/r", "t", wanted, current);
    assert.deepEqual(result.remaining, ["- stray"]);
});

test("Gitea: colours come back without a hash and are compared as such", async () => {
    const forge = forgeOf(FORGE_ENV.gitea);
    labelServer("gitea", [{ name: "keep", color: "#AABBCC", description: "kept" }]);
    const current = await currentLabels(forge, "o/r", "t");
    assert.equal(current.get("keep").color, "aabbcc");
    assert.equal(diff(forge, registryOf({ name: "keep", color: "#aabbcc", description: "kept" }), current).toUpdate.length, 0);
});

test("Gitea: a repository with more labels than one page is read whole", async () => {
    const forge = forgeOf(FORGE_ENV.gitea);
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `l${i}`, color: "000000" }));
    labelServer("gitea", many);
    const current = await currentLabels(forge, "o/r", "t");
    assert.equal(current.size, 60);
    const registry = registryOf(...many.slice(0, 55));
    assert.equal(diff(forge, registry, current).toDelete.length, 5);
});

test("a label that came back without an id cannot be addressed on Gitea", async () => {
    const forge = forgeOf(FORGE_ENV.gitea);
    const current = new Map([["x", { name: "x", color: "000000", description: "", exclusive: false }]]);
    labelServer("gitea", []);
    await assert.rejects(sync(forge, "o/r", "t", registryOf(), current), /without an id/);
});

test("the registry accepts exclusive and refuses a non-boolean one", () => {
    const ok = buildRegistry([{ name: "type/a", color: "fff", exclusive: true }], "", "labels.yml");
    assert.equal(ok.registry.get("type/a").exclusive, true);
    assert.equal(ok.findings.length, 0);
    const bad = buildRegistry([{ name: "type/a", color: "fff", exclusive: "yes" }], "type/a", "labels.yml");
    assert.match(bad.findings[0].message, /exclusive must be true or false/);
    assert.equal(bad.findings[0].line, 1);
});

test("the registry reports duplicates, missing fields and long descriptions", () => {
    const { findings } = buildRegistry(
        [{ name: "a", color: "fff" }, { name: "a", color: "fff" }, { name: "b" }, { name: "c", color: "fff", description: "x".repeat(101) }],
        "",
        "labels.yml",
    );
    assert.equal(findings.length, 3);
    assert.equal(buildRegistry({}, "", "labels.yml").findings[0].message, "must be a list of labels");
});
