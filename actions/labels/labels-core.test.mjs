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
 * An organisation label store that answers as Gitea does: paged lists with
 * `X-Total-Count`, labels addressed by numeric id. `honest: false` makes a
 * delete answer 204 and remove nothing, as Gitea does for an address it does
 * not recognise.
 */
function labelServer(initial, { pageSize = 50, honest = true } = {}) {
    let nextId = 100;
    const labels = initial.map((l) => ({ id: nextId++, description: "", exclusive: false, ...l }));
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(init.body) : undefined;
        const m = u.pathname.match(/\/orgs\/acme\/labels(?:\/(.+))?$/);
        calls.push({ method, path: u.pathname, body });
        if (!m) return new Response("no", { status: 404 });
        if (method === "GET") {
            const page = Number(u.searchParams.get("page") ?? 1);
            const slice = labels.slice((page - 1) * pageSize, page * pageSize);
            return json(slice, 200, { "X-Total-Count": String(labels.length) });
        }
        if (method === "POST") {
            labels.push({ id: nextId++, description: "", exclusive: false, ...body });
            return json(body, 201);
        }
        const at = labels.findIndex((l) => String(l.id) === m[1]);
        if (method === "DELETE") {
            if (at >= 0 && honest) labels.splice(at, 1);
            return new Response(null, { status: 204 });
        }
        if (at < 0) return new Response("label does not exist", { status: 404 });
        Object.assign(labels[at], body);
        return json(labels[at]);
    };
    return { labels, calls };
}

const forge = forgeOf(FORGE_ENV.gitea);

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

test("labels are read from the organisation, not a repository", async () => {
    const server = labelServer(existing);
    await currentLabels(forge, "acme", "t");
    assert.ok(server.calls.every((c) => c.path === "/api/v1/orgs/acme/labels"));
});

test("sync creates, updates and deletes through the organisation endpoints, by id", async () => {
    const server = labelServer(existing);
    const current = await currentLabels(forge, "acme", "t");
    const result = await sync(forge, "acme", "t", wanted, current);
    assert.deepEqual(result, { created: 1, updated: 2, deleted: 1, remaining: [] });
    const recolor = current.get("recolor");
    const patch = server.calls.find((c) => c.method === "PATCH" && c.path.endsWith(`/${recolor.id}`));
    assert.equal(patch.path, `/api/v1/orgs/acme/labels/${recolor.id}`);
    assert.equal(patch.body.name, "recolor");
    assert.equal(patch.body.new_name, undefined);
    const del = server.calls.find((c) => c.method === "DELETE");
    assert.equal(del.path, `/api/v1/orgs/acme/labels/${current.get("stray").id}`);
    const post = server.calls.find((c) => c.method === "POST");
    assert.equal(post.path, "/api/v1/orgs/acme/labels");
    assert.equal(post.body.exclusive, false);
    assert.equal(server.labels.find((l) => l.name === "type/bug").exclusive, true);
    assert.deepEqual(server.labels.map((l) => l.name).sort(), ["fresh", "keep", "recolor", "type/bug"]);
});

test("exclusivity is compared, so a scope that is not exclusive reads as drift", async () => {
    labelServer(existing);
    const current = await currentLabels(forge, "acme", "t");
    assert.deepEqual(diff(wanted, current).toUpdate.map((l) => l.name).sort(), ["recolor", "type/bug"]);
});

test("a matching organisation reports no difference", async () => {
    labelServer([{ name: "a", color: "ABCDEF", description: "d", exclusive: true }]);
    const current = await currentLabels(forge, "acme", "t");
    const plan = diff(registryOf({ name: "a", color: "abcdef", description: "d", exclusive: true }), current);
    assert.deepEqual(plan, { toCreate: [], toUpdate: [], toDelete: [] });
});

test("a delete answered 204 that removed nothing is caught by the read-back", async () => {
    labelServer(existing, { honest: false });
    const current = await currentLabels(forge, "acme", "t");
    const result = await sync(forge, "acme", "t", wanted, current);
    assert.deepEqual(result.remaining, ["- stray"]);
});

test("colours come back without a hash and are compared as such", async () => {
    labelServer([{ name: "keep", color: "#AABBCC", description: "kept" }]);
    const current = await currentLabels(forge, "acme", "t");
    assert.equal(current.get("keep").color, "aabbcc");
    assert.equal(diff(registryOf({ name: "keep", color: "#aabbcc", description: "kept" }), current).toUpdate.length, 0);
});

test("an organisation with more labels than one page is read whole", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `l${i}`, color: "000000" }));
    labelServer(many);
    const current = await currentLabels(forge, "acme", "t");
    assert.equal(current.size, 60);
    assert.equal(diff(registryOf(...many.slice(0, 55)), current).toDelete.length, 5);
});

test("a label that came back without an id cannot be addressed", async () => {
    const current = new Map([["x", { name: "x", color: "000000", description: "", exclusive: false }]]);
    labelServer([]);
    await assert.rejects(sync(forge, "acme", "t", registryOf(), current), /without an id/);
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
        [{ name: "a", color: "fff" }, { name: "a", color: "fff" }, { name: "b" }, { name: "c", color: "fff", description: "x".repeat(256) }],
        "",
        "labels.yml",
    );
    assert.equal(findings.length, 3);
    assert.equal(buildRegistry({}, "", "labels.yml").findings[0].message, "must be a list of labels");
});
