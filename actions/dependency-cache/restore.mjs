/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isEntryPoint } from "../lib/entry.mjs";
import { validateLock, verifySnapshot } from "./snapshot.mjs";
import { atInput, inputError, readJson, report } from "./diagnostics.mjs";

async function noSymlinkParents(boundary, target) {
  let current = path.resolve(boundary);
  const relative = path.relative(current, path.resolve(target));
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw inputError(current, "symbolic links are forbidden");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

export function validateExpected(lock, expected) {
  if (
    !expected ||
    typeof expected.package !== "string" ||
    typeof expected.version !== "string"
  )
    throw new Error("expected package and exact version are required");
  if (
    lock.recipe.package !== expected.package ||
    lock.recipe.version !== expected.version
  )
    throw new Error(
      `lock: expected ${expected.package}@${expected.version}, received ${lock.recipe.package}@${lock.recipe.version}`,
    );
}

export async function restore(cacheRoot, lock, destination, expected) {
  validateLock(lock);
  validateExpected(lock, expected);
  const snapshot = path.join(
    cacheRoot,
    "snapshots",
    lock.recipeDigest,
    lock.bundleDigest,
  );
  // The caller trusts these roots; system aliases above them are permitted.
  await noSymlinkParents(path.dirname(path.resolve(destination)), destination);
  try {
    await noSymlinkParents(cacheRoot, snapshot);
    await verifySnapshot(snapshot, lock);
  } catch (error) {
    error.refreshSnapshot = true;
    error.inputPath ??= error.path ?? snapshot;
    throw error;
  }
  // Exclusive creation ensures a neighboring version cannot survive a restore.
  await fs.mkdir(destination, { recursive: false });
  try {
    for (const entry of lock.inventory) {
      const dest = path.join(destination, ...entry.path.split("/"));
      if (entry.type === "directory") await fs.mkdir(dest);
      else
        await fs.copyFile(
          path.join(snapshot, ...entry.path.split("/")),
          dest,
          constants.COPYFILE_EXCL,
        );
    }
    await verifySnapshot(destination, lock);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
const usage = `Usage: node restore.mjs --cache-root ROOT --lock LOCK.json --package PACKAGE --version VERSION --destination BUILD/cache\n\nRestore the exact reviewed snapshot into a new, absent cache directory. Its parent must exist.\n`;
async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]))
    return void process.stdout.write(usage);
  if (
    args.length !== 10 ||
    args[0] !== "--cache-root" ||
    args[2] !== "--lock" ||
    args[4] !== "--package" ||
    args[6] !== "--version" ||
    args[8] !== "--destination"
  )
    throw new Error(usage.trim());
  const expected = { package: args[5], version: args[7] };
  const lock = await readJson(args[3], (value) => {
    validateLock(value);
    validateExpected(value, expected);
  });
  await atInput(args[9], () => restore(args[1], lock, args[9], expected));
}
if (isEntryPoint(import.meta.url)) main(process.argv.slice(2)).catch(report);
