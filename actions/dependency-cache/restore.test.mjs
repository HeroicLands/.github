/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLock, digest, verifySnapshot } from "./snapshot.mjs";
import { restore } from "./restore.mjs";
const fixture = fileURLToPath(new URL("fixtures/cache", import.meta.url));
const recipe = JSON.parse(
  await readFile(new URL("fixtures/recipe.json", import.meta.url)),
);
const expected = { package: recipe.package, version: recipe.version };
const script = fileURLToPath(new URL("restore.mjs", import.meta.url));
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
async function absent(destination) {
  await assert.rejects(lstat(destination), { code: "ENOENT" });
}
async function neighbor(root) {
  const staging = path.join(root, "neighbor-staging");
  await cp(fixture, staging, { recursive: true });
  for (const category of ["metadata", "foreign"])
    await rename(
      path.join(staging, category, "example@1.2.3"),
      path.join(staging, category, "example@2.0.0"),
    );
  await writeFile(
    path.join(staging, "metadata/example@2.0.0/index.jsonl"),
    "neighbor bytes\n",
  );
  const lock = await createLock(staging, { ...recipe, version: "2.0.0" });
  const snapshot = path.join(
    root,
    "snapshots",
    lock.recipeDigest,
    lock.bundleDigest,
  );
  await mkdir(path.dirname(snapshot), { recursive: true });
  await rename(staging, snapshot);
  return { lock, snapshot };
}
function cli(root, lockFile, destination, identity = expected) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--cache-root",
      root,
      "--lock",
      lockFile,
      "--package",
      identity.package,
      "--version",
      identity.version,
      "--destination",
      destination,
    ],
    { encoding: "utf8" },
  );
}

test("restore selects a reviewed snapshot beside a complete valid neighboring version", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  const other = await neighbor(root);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected acquisition");
  });
  await restore(root, lock, destination, expected);
  await verifySnapshot(destination, lock);
  await absent(path.join(destination, "metadata/example@2.0.0"));
  await assert.rejects(restore(root, lock, destination, expected), {
    code: "EEXIST",
  });
  await verifySnapshot(other.snapshot, other.lock);
  await verifySnapshot(snapshot, lock);
  await rm(destination, { recursive: true });
  await rm(snapshot, { recursive: true });
  await assert.rejects(restore(root, lock, destination, expected), {
    code: "ENOENT",
  });
  await absent(destination);
  await verifySnapshot(other.snapshot, other.lock);
});

test("corruption fails without creating a cache or repairing shared bytes", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  const file = path.join(snapshot, "navigation/nav.json");
  await writeFile(file, "wrong");
  await assert.rejects(restore(root, lock, destination, expected), {
    inputPath: file,
    refreshSnapshot: true,
  });
  await absent(destination);
  assert.equal(await readFile(file, "utf8"), "wrong");
});

test("a valid lock must match the consumer's package and exact version", async (t) => {
  const { root, lock, destination } = await setup(t);
  for (const identity of [
    undefined,
    { package: "another", version: "1.2.3" },
    { package: "example", version: "1.2.4" },
  ]) {
    await assert.rejects(
      restore(root, lock, destination, identity),
      /expected/,
    );
    await absent(destination);
  }
  const other = await neighbor(root);
  await assert.rejects(
    restore(root, other.lock, destination, expected),
    /expected example@1.2.3/,
  );
  await absent(destination);
});

test("snapshot ancestor symlinks are rejected even when their complete bytes match", async (t) => {
  for (const component of ["snapshots", "recipe", "bundle"]) {
    const { root, lock, snapshot, destination } = await setup(t);
    const target =
      component === "snapshots"
        ? path.join(root, "snapshots")
        : component === "recipe"
          ? path.dirname(snapshot)
          : snapshot;
    const moved = path.join(root, "actual-tree");
    await rename(target, moved);
    await symlink(moved, target, "dir");
    await verifySnapshot(component === "bundle" ? moved : snapshot, lock);
    await assert.rejects(
      restore(root, lock, destination, expected),
      /symbolic links/,
    );
    await absent(destination);
  }
});

test("system path aliases above the trust boundaries are accepted", async (t) => {
  const { root, lock } = await setup(t);
  const actual = path.join(root, "actual");
  await mkdir(actual);
  await rename(path.join(root, "snapshots"), path.join(actual, "snapshots"));
  await mkdir(path.join(actual, "build"));
  const alias = path.join(root, "alias");
  await symlink(actual, alias, "dir");
  // Both boundaries are real directories beneath the aliased parent.
  const cacheRoot = path.join(alias, "cache");
  await mkdir(cacheRoot);
  await rename(
    path.join(actual, "snapshots"),
    path.join(cacheRoot, "snapshots"),
  );
  const destination = path.join(alias, "build", "cache");
  await restore(cacheRoot, lock, destination, expected);
  await verifySnapshot(destination, lock);
});

test("destination links and linked destination parents are rejected without deleting their targets", async (t) => {
  const { root, lock, destination } = await setup(t);
  const target = path.join(root, "target");
  await mkdir(target);
  await writeFile(path.join(target, "keep"), "preserved");
  await symlink(target, destination, "dir");
  await assert.rejects(
    restore(root, lock, destination, expected),
    /symbolic links/,
  );
  await assert.rejects(
    restore(root, lock, path.join(destination, "cache"), expected),
    /symbolic links/,
  );
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "preserved");
});

test("copy failure removes the partially copied destination and leaves the snapshot intact", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  const copy = fs.copyFile;
  let copied = 0;
  t.mock.method(fs, "copyFile", async (...args) => {
    if (copied++ > 0)
      throw Object.assign(new Error("fixture copy failure"), {
        code: "ENOSPC",
      });
    await copy(...args);
  });
  await assert.rejects(restore(root, lock, destination, expected), {
    code: "ENOSPC",
  });
  assert.equal(copied, 2);
  await absent(destination);
  await verifySnapshot(snapshot, lock);
});

test("post-copy verification rejects altered destination bytes and removes the cache", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  const copy = fs.copyFile;
  t.mock.method(fs, "copyFile", async (...args) => {
    await copy(...args);
    await writeFile(args[1], "altered during copy");
  });
  await assert.rejects(
    restore(root, lock, destination, expected),
    /file bytes differ/,
  );
  await absent(destination);
  await verifySnapshot(snapshot, lock);
});

test("CLI diagnostics locate inputs and reserve refresh advice for snapshot failure", async (t) => {
  const { root, lock, snapshot, destination } = await setup(t);
  const lockFile = path.join(root, "accepted.json");
  await writeFile(lockFile, JSON.stringify(lock));
  const relative = (file) => path.relative(process.cwd(), file);
  const wrong = cli(root, lockFile, destination, {
    package: "example",
    version: "2.0.0",
  });
  assert.equal(wrong.status, 1);
  assert.ok(wrong.stderr.startsWith(`${relative(lockFile)}: error:`));
  assert.doesNotMatch(wrong.stderr, /Refresh/);
  await mkdir(destination);
  const existing = cli(root, lockFile, destination);
  assert.equal(existing.status, 1);
  assert.ok(existing.stderr.startsWith(`${relative(destination)}: error:`));
  assert.doesNotMatch(existing.stderr, /Refresh/);
  await rm(destination, { recursive: true });
  const corruptFile = path.join(snapshot, "navigation/nav.json");
  await writeFile(corruptFile, "wrong");
  const corrupt = cli(root, lockFile, destination);
  assert.equal(corrupt.status, 1);
  assert.ok(corrupt.stderr.startsWith(`${relative(corruptFile)}: error:`));
  assert.match(corrupt.stderr, /Refresh the trusted dependency snapshot/);
  const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^<arguments>: error: Usage:/);
  assert.doesNotMatch(usage.stderr, /Refresh/);
  await writeFile(lockFile, "{\n invalid JSON\n}");
  const malformed = cli(root, lockFile, destination);
  assert.equal(malformed.status, 1);
  assert.ok(malformed.stderr.startsWith(`${relative(lockFile)}:`));
  assert.doesNotMatch(malformed.stderr, /Refresh/);
});

test("unsafe lock diagnostics locate the literal in the trusted input", async (t) => {
  const { root, lock, destination } = await setup(t);
  const lockFile = path.join(root, "unsafe.json");
  lock.inventory[0].path = "../escape";
  // The recipe can contain the same string without owning the path finding.
  lock.recipe.sourceClosure.push("../escape");
  lock.recipeDigest = digest(lock.recipe);
  const text = JSON.stringify(lock, null, 2);
  await writeFile(lockFile, text);
  const before = text
    .slice(0, text.indexOf('"../escape"', text.indexOf('"inventory"')))
    .split("\n");
  const result = cli(root, lockFile, destination);
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.startsWith(
      `${path.relative(process.cwd(), lockFile)}:${before.length}:${before.at(-1).length + 1}: error:`,
    ),
  );
  assert.match(result.stderr, /unsafe path/);
  assert.doesNotMatch(result.stderr, /Refresh/);
  await absent(destination);
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
      [path.join(dir, "linked", "restore.mjs")],
      {
        cwd: dir,
        env: {},
        encoding: "utf8",
        input: "",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node restore\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
