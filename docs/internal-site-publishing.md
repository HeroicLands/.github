# Internal site publishing

Build pages, publish CDN assets and deploy pages separately. The shared
`.gitea/workflows/deploy-internal-site.yml` consumes an artifact produced by an
earlier job in the same run. It executes trusted deployment tools from
`HeroicLands/.github`, never package source code or a build command. Existing
public release deployments continue using Cloudflare Pages and their existing
projects and Worker routes.

## Build job

Use a normally published package-build release supporting `site build --root`.
Fetch the package's declared dependencies separately, then build with the
explicit internal root:

```bash
package-build site build --root internal.heroiclands.org
```

The build job needs no deployment credentials. It does not upload CDN assets.
Stage the generated tree as `publication/site/`, preserving the package prefix:

```text
publication/
  publication.json
  site/
    _headers
    thalorna/
      index.html
      404.html
      ...other generated pages, fonts and search files...
```

The trusted helper in this repository can create the manifest after staging.
Check out `HeroicLands/.github` into a separate `trusted-deploy` directory, then:

```bash
PUBLICATION_PACKAGE=thalorna SOURCE_SHA="$GITHUB_SHA" MIN_PAGES=1000 \
  node trusted-deploy/actions/internal-site-deploy/publish.mjs manifest publication
```

This command inventories already-built files and validates the artifact. It
neither builds pages nor changes their contents. Upload `publication/` as one
artifact using the ordinary upload-artifact action. The deploy workflow only
downloads artifacts from its own run.

## Internal deploy job

Call the workflow after the build job, only for main/nonrelease publication:

```yaml
internal:
  needs: build
  if: ${{ github.ref == 'refs/heads/main' }}
  uses: HeroicLands/.github/.gitea/workflows/deploy-internal-site.yml@main
  with:
    artifact-name: internal-pages
    package: thalorna
    source-sha: ${{ github.sha }}
    min-pages: 1000
  secrets:
    PREVIEW_SSH_PRIVATE_KEY: ${{ secrets.PREVIEW_SSH_PRIVATE_KEY }}
```

| Input           | Default                             | Purpose                                         |
| --------------- | ----------------------------------- | ----------------------------------------------- |
| `artifact-name` | required                            | Artifact holding `publication.json` and `site/` |
| `package`       | required                            | Lowercase letters/digits; the package prefix    |
| `source-sha`    | required                            | Full 40-character SHA used by the build         |
| `min-pages`     | `1`                                 | Minimum number of package `index.html` files    |
| `max-pages`     | `0`                                 | Maximum count; zero removes the ceiling         |
| `node-version`  | organization Node target, else `24` | Trusted publisher runtime                       |

The job requires `HL_DEPLOY_ENABLED=true`, runs on Gitea and main only, and
uses the caller's ordinary job token for read-only main/ancestry queries.
`PREVIEW_SSH_PRIVATE_KEY` is the sole named secret. It authenticates the dedicated
`preview-publish` account at atlas, whose forced-rrsync receiver is rooted at
`/srv/preview` and permits no remote shell. Atlas's checked-in ED25519 identity
is pinned exclusively: page transfers ignore the runner's SSH configuration
and global host-key file, and the CDN alias also disables global host keys.
Runtime key discovery is not used.

The publisher validates the complete artifact before its credential-bearing
step, then validates it again before acquiring a sender lock. It accepts
`published receipt <= candidate <= current main` by commit ancestry. An older
build can publish while main advances, but it cannot replace a newer publication
or publish divergent history. The sender's persistent package lock and workflow
serialization cover the whole page/receipt sequence on the existing single
publication runner host.

Only `www/<package>/` is transferred, with delayed file updates/deletion and
ordinary directory/file modes. Sibling package paths and shared `cdn/` are
outside this operation. The previous completion receipt is protected during the
page transfer; a new receipt is written only after that transfer succeeds.
Publication completes only after an HTTPS readback serves that receipt with the
candidate source SHA. A missing, hidden or mismatched receipt fails the job.
This is file-level publication, not an atomic tree replacement. An interrupted
transfer can leave some updated pages; it leaves the previous receipt until a
complete page transfer succeeds. Private temporary identity, host-pin and file
list files are removed on success or failure. Cancellation terminates the local
transfer process group before cleanup.

## Artifact and receipt contract

`publication.json` is a UTF-8 JSON object with:

- `schemaVersion: 1`
- `package` and `sourceSha`, matching the trusted workflow inputs
- `builtAt`, an ISO timestamp including milliseconds and `Z`
- `baseUrl: https://www.internal.heroiclands.org/<package>/`
- `assetsOrigin: https://cdn.internal.heroiclands.org`
- `pageCount`, the actual package `index.html` count within the declared bounds
- `files`, an array of `{ key, bytes, sha256 }` for every payload file

Keys are relative to the artifact root. Only `site/_headers` and
`site/<package>/**` are accepted. Every declared file must match its nonnegative
byte count and SHA-256 digest; empty auxiliary files are allowed. Extra/missing
files, duplicate paths,
traversal, links, special files and authored `.preview-publication.json` files
are refused. The homepage must contain a nonempty `main`; the package's
`index.html`, `404.html` and deployment-root `_headers` are mandatory. No
`assets.json`, CDN bytes, source/provenance files outside the package tree or
HTML rewriting belong in this artifact.

The completion receipt is served at
`https://www.internal.heroiclands.org/<package>/.preview-publication.json`.
It contains schema version, package, source SHA, build/publish timestamps, base
URL, assets origin and page count. No asset-closure manifest is required. A
missing receipt allows a first publication attempt, but its completion receipt
must become readable over HTTPS before that attempt succeeds. An invalid or
unreadable receipt fails closed. Deploy jobs expose no additional workflow
outputs.

## Manual CDN publication

Run `.gitea/workflows/publish-package-cdn.yml` separately. Its `dest` input is
`internal` by default; select `cloudflare` explicitly for public R2 publication.
The existing set/name, transforms and dry-run semantics remain package-build's
responsibility. Consume a normally released package-build supporting
`cdn publish --dest`; there is no unpublished dependency override.

For internal writes, pass `PREVIEW_SSH_PRIVATE_KEY` by name. The adapter creates
a private pinned SSH alias and sets `CDN_INTERNAL_DESTINATION` to
`heroiclands-internal:cdn`, the relative destination required by forced rrsync.
It leaves the runner's SSH configuration untouched. R2 credentials are unused
for internal publication. Internal dry runs need no SSH credential.

For `dest: cloudflare`, pass `CDN_ENDPOINT`, `CDN_BUCKET`,
`CDN_ACCESS_KEY_ID` and `CDN_SECRET_ACCESS_KEY` by name. They are optional in the
shared workflow declaration because only Cloudflare requires them; the publisher
checks the selected backend's requirements. The internal key is not forwarded
to the Cloudflare publisher. Neither site building nor page deployment starts
this manual CDN workflow.

## Developer checks

The helper uses only built-in Node modules. The real local transfer fixture
also requires `rsync`; the parity workflow installs it when the job image lacks
it. Workflow fixtures use the scoped `ci` dependency manifest:

```bash
npm ci --prefix ci
node --test ci/internal-site-deploy.test.mjs ci/workflows.test.mjs
```

Fixtures exercise artifact rejection, actual local rsync deletion, monotonic
publication and HTTPS completion readback, abort/SIGTERM process-group cleanup,
pinned-key cleanup, manual destinations and the shared workflow contract. The
nested deletion fixture runs the sender's own generated file inventory. They do
not deploy pages or contact atlas, Gitea or Cloudflare.
