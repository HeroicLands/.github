// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLock,
  digest,
  validateLock,
  verifySnapshot,
} from "./snapshot.mjs";
const fixture = fileURLToPath(new URL("fixtures/cache", import.meta.url));
const recipe = JSON.parse(
  await readFile(new URL("fixtures/recipe.json", import.meta.url)),
);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  return root;
}
test("complete inventory and digest are deterministic", async (t) => {
  const root = await setup(t);
  const lock = await createLock(root, recipe);
  assert.deepEqual(
    lock,
    await createLock(root, {
      tool: recipe.tool,
      sourceClosure: recipe.sourceClosure,
      version: recipe.version,
      package: recipe.package,
    }),
  );
  assert.deepEqual(
    lock.inventory
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path),
    [
      "foreign/example@1.2.3/items/item.json",
      "metadata/example@1.2.3/index.jsonl",
      "navigation/nav.json",
    ],
  );
  await verifySnapshot(root, lock);
});
test("unsafe names and mismatched pins are rejected", async (t) => {
  const root = await setup(t);
  const lock = await createLock(root, recipe);
  for (const bad of [
    "../escape",
    "/absolute",
    "metadata/../escape",
    "metadata\\escape",
  ]) {
    const altered = structuredClone(lock);
    altered.inventory[0].path = bad;
    altered.bundleDigest = digest({
      recipeDigest: altered.recipeDigest,
      inventory: altered.inventory,
    });
    assert.throws(() => validateLock(altered));
  }
  const wrongRecipe = structuredClone(lock);
  wrongRecipe.recipe.version = "1.2.4";
  assert.throws(() => validateLock(wrongRecipe));
  wrongRecipe.recipeDigest = digest(wrongRecipe.recipe);
  wrongRecipe.bundleDigest = digest({
    recipeDigest: wrongRecipe.recipeDigest,
    inventory: wrongRecipe.inventory,
  });
  assert.throws(() => validateLock(wrongRecipe), /version mismatch/);
  const wrongDigest = structuredClone(lock);
  wrongDigest.bundleDigest = "0".repeat(64);
  assert.throws(() => validateLock(wrongDigest), /bundle digest/);
});
test("inventory rejects missing, extra, changed and symbolic files", async (t) => {
  const root = await setup(t);
  const lock = await createLock(root, recipe);
  const file = path.join(root, "navigation/nav.json");
  await writeFile(file, "altered");
  await assert.rejects(verifySnapshot(root, lock));
  await rm(file);
  await assert.rejects(verifySnapshot(root, lock));
  await writeFile(
    file,
    await readFile(path.join(fixture, "navigation/nav.json")),
  );
  await writeFile(path.join(root, "navigation/extra"), "extra");
  await assert.rejects(verifySnapshot(root, lock));
  await rm(path.join(root, "navigation/extra"));
  await symlink(file, path.join(root, "navigation/link"));
  await assert.rejects(verifySnapshot(root, lock), /symbolic/);
});
