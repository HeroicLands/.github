// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLock, verifySnapshot } from "./snapshot.mjs";
import { restore } from "./restore.mjs";
const fixture = fileURLToPath(new URL("fixtures/cache", import.meta.url));
const recipe = JSON.parse(
  await readFile(new URL("fixtures/recipe.json", import.meta.url)),
);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = await createLock(fixture, recipe);
  const snapshot = path.join(
    root,
    "snapshots",
    lock.recipeDigest,
    lock.bundleDigest,
  );
  await mkdir(path.dirname(snapshot), { recursive: true });
  await cp(fixture, snapshot, { recursive: true });
  return { root, lock, snapshot, destination: path.join(root, "build-cache") };
}
test("restore selects only the reviewed snapshot and makes no acquisition", async (t) => {
  const { root, lock, destination } = await setup(t);
  await mkdir(
    path.join(root, "snapshots", "neighbor", "metadata", "example@2.0.0"),
    { recursive: true },
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("unexpected acquisition");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await restore(root, lock, destination);
  await verifySnapshot(destination, lock);
  await assert.rejects(
    readFile(path.join(destination, "metadata/example@2.0.0/index.jsonl")),
    { code: "ENOENT" },
  );
  await assert.rejects(restore(root, lock, destination), { code: "EEXIST" });
});
test("corruption and an absent snapshot fail without creating a cache", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  await writeFile(path.join(snapshot, "navigation/nav.json"), "wrong");
  await assert.rejects(restore(root, lock, destination));
  await assert.rejects(
    readFile(path.join(destination, "navigation/nav.json")),
    { code: "ENOENT" },
  );
  await rm(snapshot, { recursive: true });
  await assert.rejects(restore(root, lock, destination), { code: "ENOENT" });
});
