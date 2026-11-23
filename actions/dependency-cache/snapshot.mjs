/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEntryPoint } from "../lib/entry.mjs";
import { atInput, inputError, readJson, report } from "./diagnostics.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const roots = ["foreign", "metadata", "navigation"];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  throw new Error("invalid JSON value");
}
export const digest = (value) => hash(canonical(value));

function keys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  )
    throw new Error(`${label}: invalid fields`);
}
function safePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    /[\x00-\x1f:]/.test(value) ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.isAbsolute(value)
  )
    throw Object.assign(new Error(`${JSON.stringify(value)}: unsafe path`), {
      literal: value,
    });
}
export function validateRecipe(recipe) {
  keys(recipe, ["package", "version", "sourceClosure", "tool"], "recipe");
  if (
    typeof recipe.package !== "string" ||
    typeof recipe.version !== "string" ||
    !tokenPattern.test(recipe.package) ||
    !tokenPattern.test(recipe.version)
  )
    throw new Error("recipe: invalid package or version");
  if (
    !Array.isArray(recipe.sourceClosure) ||
    !recipe.sourceClosure.length ||
    recipe.sourceClosure.some((s) => typeof s !== "string" || !s.trim()) ||
    new Set(recipe.sourceClosure).size !== recipe.sourceClosure.length
  )
    throw new Error("recipe: invalid source closure");
  keys(recipe.tool, ["name", "version", "source"], "recipe.tool");
  if (
    Object.values(recipe.tool).some((s) => typeof s !== "string" || !s.trim())
  )
    throw new Error("recipe.tool: invalid identity");
}
export function validateLock(lock) {
  keys(
    lock,
    ["format", "recipe", "recipeDigest", "inventory", "bundleDigest"],
    "lock",
  );
  if (lock.format !== 1) throw new Error("lock: unsupported format");
  validateRecipe(lock.recipe);
  if (
    !digestPattern.test(lock.recipeDigest) ||
    lock.recipeDigest !== digest(lock.recipe)
  )
    throw new Error("lock: recipe digest mismatch");
  if (!Array.isArray(lock.inventory) || !lock.inventory.length)
    throw new Error("lock: empty inventory");
  let previous = "";
  const dirs = new Set();
  for (const entry of lock.inventory) {
    keys(
      entry,
      entry.type === "directory"
        ? ["path", "type"]
        : ["path", "type", "bytes", "sha256"],
      "inventory entry",
    );
    safePath(entry.path);
    if (entry.path <= previous)
      throw new Error(`${entry.path}: inventory must be sorted and unique`);
    previous = entry.path;
    const parts = entry.path.split("/");
    if (!roots.includes(parts[0]))
      throw new Error(`${entry.path}: unexpected cache root`);
    if (parts.length > 1 && !dirs.has(parts.slice(0, -1).join("/")))
      throw new Error(`${entry.path}: missing parent directory`);
    if (
      parts.length > 1 &&
      parts[0] !== "navigation" &&
      parts[1] !== `${lock.recipe.package}@${lock.recipe.version}`
    )
      throw new Error(`${entry.path}: package or version mismatch`);
    if (entry.type === "directory") dirs.add(entry.path);
    else if (
      entry.type !== "file" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !digestPattern.test(entry.sha256)
    )
      throw new Error(`${entry.path}: invalid file entry`);
  }
  for (const root of roots)
    if (!dirs.has(root)) throw new Error(`${root}: missing cache root`);
  for (const root of ["metadata", "foreign"])
    if (!dirs.has(`${root}/${lock.recipe.package}@${lock.recipe.version}`))
      throw new Error(`${root}: missing pinned package`);
  if (
    !digestPattern.test(lock.bundleDigest) ||
    lock.bundleDigest !==
      digest({ recipeDigest: lock.recipeDigest, inventory: lock.inventory })
  )
    throw new Error("lock: bundle digest mismatch");
}

export async function inventory(root) {
  const entries = [];
  async function visit(relative) {
    const full = relative ? path.join(root, ...relative.split("/")) : root;
    const stat = await lstat(full);
    if (stat.isSymbolicLink())
      throw inputError(full, "symbolic links are forbidden");
    if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, type: "directory" });
      for (const name of (await readdir(full)).sort()) {
        await atInput(path.join(full, name), () => safePath(name));
        await visit(relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isFile() && relative) {
      const bytes = await readFile(full);
      entries.push({
        path: relative,
        type: "file",
        bytes: bytes.length,
        sha256: hash(bytes),
      });
    } else throw inputError(full, "unsupported file type");
  }
  await visit("");
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
export async function createLock(root, recipe) {
  validateRecipe(recipe);
  const recipeDigest = digest(recipe);
  const entries = await inventory(root);
  const lock = {
    format: 1,
    recipe,
    recipeDigest,
    inventory: entries,
    bundleDigest: digest({ recipeDigest, inventory: entries }),
  };
  validateLock(lock);
  return lock;
}
export async function verifySnapshot(root, lock) {
  validateLock(lock);
  const actual = await inventory(root);
  if (canonical(actual) !== canonical(lock.inventory)) {
    const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
    const expectedByPath = new Map(
      lock.inventory.map((entry) => [entry.path, entry]),
    );
    const changed = [
      ...new Set([...actualByPath.keys(), ...expectedByPath.keys()]),
    ]
      .sort()
      .find(
        (name) =>
          !actualByPath.has(name) ||
          !expectedByPath.has(name) ||
          canonical(actualByPath.get(name)) !==
            canonical(expectedByPath.get(name)),
      );
    throw inputError(
      path.join(root, ...changed.split("/")),
      "inventory or file bytes differ from lock",
    );
  }
}
const usage = `Usage: node snapshot.mjs --root CACHE --recipe RECIPE.json --output LOCK.json\n\nInventory a complete cache and write a candidate lock for review. The cache contains metadata, foreign and navigation directories.\n`;
async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]))
    return void process.stdout.write(usage);
  if (
    args.length !== 6 ||
    args[0] !== "--root" ||
    args[2] !== "--recipe" ||
    args[4] !== "--output"
  )
    throw new Error(usage.trim());
  const recipe = await readJson(args[3], validateRecipe);
  const lock = await atInput(args[1], () => createLock(args[1], recipe));
  await atInput(args[5], () =>
    writeFile(args[5], `${JSON.stringify(lock, null, 2)}\n`, {
      flag: "wx",
    }),
  );
}
if (isEntryPoint(import.meta.url)) main(process.argv.slice(2)).catch(report);
