/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
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
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical,
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
    "navigation/a:b",
    "navigation/back\\slash",
  ]) {
    const altered = structuredClone(lock);
    altered.inventory[0].path = bad;
    altered.bundleDigest = digest({
      recipeDigest: altered.recipeDigest,
      inventory: altered.inventory,
    });
    assert.throws(() => validateLock(altered), /unsafe path/);
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

test("canonical JSON matches fixed independent SHA-256 vectors", () => {
  assert.equal(canonical({ a: 1 }), '{"a":1}');
  assert.equal(
    digest({ a: 1 }),
    "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
  );
  assert.equal(
    digest({}),
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
  assert.equal(
    canonical({ z: [{ b: 2, a: 1 }], a: true }),
    '{"a":true,"z":[{"a":1,"b":2}]}',
  );
});

test("unsafe leaf names are rejected even with valid roots and parents", async (t) => {
  const root = await setup(t);
  for (const name of ["a:b", "back\\slash"]) {
    const file = path.join(root, "navigation", name);
    await writeFile(file, "unsafe");
    await assert.rejects(createLock(root, recipe), /unsafe path/);
    await rm(file);
  }
});

test("snapshot CLI reports recipe and output inputs without invented positions", async (t) => {
  const root = await setup(t);
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "dependency-diagnostics-"),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("snapshot.mjs", import.meta.url));
  const recipeFile = path.join(scratch, "recipe.json");
  const output = path.join(scratch, "candidate.json");
  const invoke = () =>
    spawnSync(
      process.execPath,
      [script, "--root", root, "--recipe", recipeFile, "--output", output],
      { encoding: "utf8" },
    );
  await writeFile(recipeFile, JSON.stringify({ ...recipe, version: "" }));
  const invalid = invoke();
  assert.equal(invalid.status, 1);
  assert.ok(
    invalid.stderr.startsWith(
      `${path.relative(process.cwd(), recipeFile)}: error:`,
    ),
  );
  await writeFile(recipeFile, JSON.stringify(recipe));
  await writeFile(output, "preserved");
  const existing = invoke();
  assert.equal(existing.status, 1);
  assert.ok(
    existing.stderr.startsWith(
      `${path.relative(process.cwd(), output)}: error:`,
    ),
  );
  assert.equal(await readFile(output, "utf8"), "preserved");
});

test("the script runs when reached through a symlinked directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "entry-guard-"));
  try {
    symlinkSync(
      new URL(".", import.meta.url).pathname,
      path.join(dir, "linked"),
      "dir",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(dir, "linked", "snapshot.mjs")],
      {
        cwd: dir,
        env: {},
        encoding: "utf8",
        input: "",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node snapshot\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
