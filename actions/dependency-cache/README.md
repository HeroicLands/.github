<!--
Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Dependency snapshot helper

These internal scripts require Node.js 24 or later. They inventory a dependency
cache and restore a reviewed snapshot without acquiring dependencies. The
fixture under `fixtures/` is test data and is not a production lock.

Create a candidate lock from a complete staging cache:

```sh
node actions/dependency-cache/snapshot.mjs --root build/cache --recipe recipe.json --output candidate.json
```

Both commands require their options exactly once and in the order shown. The
candidate output must be absent; snapshot creation never overwrites a file.
Both commands accept `--help` on its own.

The recipe is a JSON object with `package`, exact `version`, `sourceClosure`
(a nonempty array of distinct source identifiers), and `tool` with `name`,
`version`, and `source`. [The fixture recipe](fixtures/recipe.json) is a complete
test example. The [lock schema](lock.schema.json) defines the machine-readable
format and required fields. `validateLock` additionally checks the relationships
between fields: digests, sorted unique paths, declared parents, safe path
segments, required cache roots and exact package/version directories.

The candidate lock holds `format: 1`, `recipe`, `recipeDigest`, `inventory`, and
`bundleDigest`, with no other top-level fields. The complete sorted inventory
contains directory entries (`path`, `type: "directory"`) and file entries
(`path`, `type: "file"`, `bytes`, `sha256`). Empty directories are included.
Each file digest covers its exact bytes. Other digests use SHA-256 over UTF-8
canonical JSON: object keys sorted recursively, no whitespace, array order
preserved, and JSON string escaping. Numbers must be safe integers.
`recipeDigest` covers the complete recipe; `bundleDigest` covers the object
`{ "recipeDigest": recipeDigest, "inventory": inventory }`. No recipe or
inventory field is excluded from its digest.

Review the source closure, warming tool, receipts, provenance, inventory and
bytes before accepting a lock in trusted source. A candidate alone does not
establish trust. Store the accepted lock in reviewed source outside the writable
shared cache, such as a pinned infrastructure checkout. Read it from that trusted
location, never from the snapshot, staging directory or cache producer's output.
The expected package and exact version come independently from the consumer's
reviewed configuration, not from the lock being checked.

Publish accepted bytes under
`ROOT/snapshots/<recipeDigest>/<bundleDigest>/`, with `metadata`, `foreign`
and `navigation` directly inside the snapshot. Metadata and foreign contain
only the exact `<package>@<version>` directory selected by the recipe. The
snapshot preserves every file and directory, including verification receipts.

Restore into an absent isolated cache directory whose parent already exists:

```sh
node actions/dependency-cache/restore.mjs --cache-root ROOT --lock trusted/accepted.json --package example --version 1.2.3 --destination build/cache
```

The JavaScript interface is
`restore(cacheRoot, lock, destination, { package, version })`. Expected identity
is mandatory. A valid lock for a different package or version is rejected before
copying. The helper validates the lock, path names, complete inventory and file
bytes, then copies and verifies them in the new cache. An existing destination
is an error, so an older or newer local version cannot influence the build.
A failed copy or destination verification removes the partial destination.

The cache root and destination's existing parent are caller-selected trust
boundaries and must be real directories. Symbolic links at these boundaries or
below them are rejected. System path aliases above them, including macOS's
`/var`, are permitted. The complete snapshot tree rejects symbolic links,
absolute paths, traversal and unsupported file types. A boundary selects the
trusted tree; the caller must also trust the parent directories that locate it.

A missing or corrupt shared snapshot fails with an instruction to refresh the
trusted snapshot and review its lock. Run the trusted producer's refresh process,
review the resulting candidate against the source closure and accepted bytes,
and publish the accepted snapshot and reviewed lock through their respective
trusted channels. Usage errors, invalid locks, identity mismatches and existing
destinations require correcting those inputs; they do not request a refresh.
Diagnostics identify the offending input path and include line and column only
when known. Usage diagnostics identify `<arguments>`.

The helper never fetches, repairs or writes to the shared snapshot. The producer
and host jobs share a user ID. File permissions and a read-only container mount
do not prevent another host job under that user from changing shared files or
making its own network requests. Verification detects mismatched bytes; it does
not isolate hostile code running under that user or prevent concurrent changes
between filesystem operations.
