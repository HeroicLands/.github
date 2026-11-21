// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateLock, verifySnapshot } from "./snapshot.mjs";

async function noSymlinkParents(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`${current}: symbolic links are forbidden`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}
export async function restore(cacheRoot, lock, destination) {
  validateLock(lock);
  const snapshot = path.join(
    cacheRoot,
    "snapshots",
    lock.recipeDigest,
    lock.bundleDigest,
  );
  await noSymlinkParents(snapshot);
  await noSymlinkParents(destination);
  await verifySnapshot(snapshot, lock);
  // Exclusive creation ensures a neighboring version cannot survive a restore.
  await mkdir(destination, { recursive: false });
  try {
    for (const entry of lock.inventory) {
      const dest = path.join(destination, ...entry.path.split("/"));
      if (entry.type === "directory") await mkdir(dest);
      else
        await copyFile(
          path.join(snapshot, ...entry.path.split("/")),
          dest,
          constants.COPYFILE_EXCL,
        );
    }
    await verifySnapshot(destination, lock);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
const usage = `Usage: node restore.mjs --cache-root ROOT --lock LOCK.json --destination BUILD/cache\n\nRestore the exact reviewed snapshot into a new, absent cache directory. Its parent must exist.\n`;
async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]))
    return void process.stdout.write(usage);
  if (
    args.length !== 6 ||
    args[0] !== "--cache-root" ||
    args[2] !== "--lock" ||
    args[4] !== "--destination"
  )
    throw new Error(usage.trim());
  const lock = JSON.parse(await readFile(args[3], "utf8"));
  await restore(args[1], lock, args[5]);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${process.argv[1]}: error: ${error.message}. Refresh the trusted dependency snapshot and review its lock before retrying.\n`,
    );
    process.exitCode = 1;
  });
