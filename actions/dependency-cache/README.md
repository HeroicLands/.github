# Dependency snapshot helper

These internal Node.js 24 scripts inventory a dependency cache and restore a
reviewed snapshot without acquiring dependencies. The fixture under `fixtures/`
is test data and is not a production lock.

Create a candidate lock from a complete staging cache:

```sh
node actions/dependency-cache/snapshot.mjs --root build/cache --recipe recipe.json --output candidate.json
```

The recipe is a JSON object with `package`, exact `version`, `sourceClosure`
(a nonempty array of source identifiers), and `tool` with `name`, `version`, and
`source`. The candidate lock holds that recipe, its SHA-256 digest, the complete
sorted inventory of directories and files, and a bundle digest. Each file entry
holds its byte length and SHA-256 digest. Digests use UTF-8 JSON with object
keys sorted recursively, no whitespace, and array order preserved. The bundle
digest covers the recipe digest and inventory. Review the source closure,
warming tool, receipts, provenance, inventory and bytes before accepting a
lock in trusted source. A candidate alone does not establish trust.

Publish accepted bytes under
`ROOT/snapshots/<recipeDigest>/<bundleDigest>/`, with `metadata`, `foreign`
and `navigation` directly inside the snapshot. Metadata and foreign contain
only the exact `<package>@<version>` directory selected by the recipe. The
snapshot preserves every file and directory, including verification receipts.

Restore into an absent isolated cache directory whose parent already exists:

```sh
node actions/dependency-cache/restore.mjs --cache-root ROOT --lock accepted.json --destination build/cache
```

The helper validates the lock, path names, complete inventory and file bytes,
then copies and verifies them in the new cache. An existing destination is an
error, so an older or newer local version cannot influence the build. A missing,
corrupt or unapproved snapshot fails with an instruction to refresh the trusted
snapshot and review its lock. The helper never fetches, repairs or writes to
the shared snapshot. Both commands accept `--help`.

The producer and host jobs share a user ID. File permissions and a read-only
container mount do not prevent another host job under that user from changing
shared files or making its own network requests.
