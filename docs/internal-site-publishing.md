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

## PR artifact interface

A PR artifact uses `PUBLICATION_MODE=pr`, `SOURCE_REPOSITORY`, `PR_NUMBER`,
`SOURCE_SHA`, `PUBLICATION_PACKAGE` and the page limits. The repository is the
canonical `HeroicLands/<repository>` name, the PR number is a positive decimal
without leading zeros, and the SHA is the full lowercase head SHA. The build
uses `--root internal.heroiclands.org` and the base URL
`https://www.internal.heroiclands.org/pr/<repository>/<number>/<package>/`.
The trusted helper validates and stages the generated tree into an empty
artifact directory. It copies the nested package contents to
`publication/site/<package>/` and the root headers to `publication/site/_headers`,
then writes and validates the manifest. HTML retains its nested links:

```bash
PUBLICATION_MODE=pr SOURCE_REPOSITORY=HeroicLands/thalorna PR_NUMBER=123 \
  PUBLICATION_PACKAGE=thalorna SOURCE_SHA="$SOURCE_SHA" MIN_PAGES=1000 \
  node trusted-deploy/actions/internal-site-deploy/publish.mjs stage build/site publication
```

The version 2 manifest and receipt bind the repository, PR number, package,
head SHA and derived base URL to independently supplied trusted context. The
transfer helper derives the matching PR destination and `--mkpath` arguments.
The main deploy workflow publishes main artifacts. The PR workflows require a
trusted base-branch controller and a reviewed, immutable helper revision.

The trusted publisher helpers derive a lock name from the repository and PR
number, shared across packages. The PR lookup accepts only a same-repository PR;
publication requires base `main`, an open, non-draft PR with `ci/preview`
and the exact candidate head. The cleanup helper rechecks closed state under
the same supplied lock and leaves a reopened PR untouched. Label removal does
not request a build or delete existing pages. Cleanup arguments protect sibling
PRs at the receiver and select the numbered subtree. The disposable forced-SSH fixture checks nested creation and deletion against real
`rrsync -wo -munge`, with sibling PR, main and CDN sentinels. Deployed-receiver
acceptance also checks the provisioned account, host key and live paths.

## PR workflows

A trusted base-branch controller calls `build-internal-preview.yml` with the
canonical repository context, PR number, exact head SHA, package, artifact name,
page bounds and a full `trusted-ref` identifying the reviewed shared helper.
The caller chooses an immutable shared revision accepted on `main` and supplies
that same helper revision. The build job rechecks eligibility, verifies the checked-out
head before package code runs and declares no deployment secret input or mapping.
A label-add request starts a build; a synchronized or reopened PR refreshes only when the
current PR retains the label. The native `label_updated` event distinguishes
added labels from removed labels. Forks fail the same-repository check.

After a successful build, the trusted controller calls
`deploy-internal-preview.yml` with operation `publish` and the same independent
context. The publisher downloads the exact uploaded artifact ID supplied by the caller,
verifies its name and current run within the caller repository, and limits its
ZIP to 512 MiB, and checks at most 100,000 entries, 256 MiB per file and 2 GiB
total expanded bytes before extracting anything. Streamed extraction also
enforces each declared size. It rejects links, special files, duplicate names
and unsafe paths, then validates the manifest before exposing its named SSH
key. Under the repository/PR flock it rechecks the current PR, transfers pages
and receipt, reads back the receipt, rechecks the PR and posts the exact-head
`preview/<package>/pr-<number>` status. The controller calls the same workflow
with operation `cleanup` on close, independent of the build and label. Cleanup
rechecks closed state under the same lock, including a PR retargeted from main,
supersedes preview statuses on the
current head and uses the pinned receiver key; a reopened PR is left untouched. The cleanup input SHA identifies the event's
head and does not restrict deletion of a currently closed PR.

On a reopen event the controller calls the deploy workflow with operation
`reopen` before deciding whether the label requests a build. This operation
rechecks the open PR and invalidates matching statuses on its current head under
the same lock, including when the label is absent. It requires the job token
and does not forward the SSH key. Cleanup fails before deletion
if status lookup or invalidation fails. Historical heads can retain statuses;
the preview link consumer checks the current PR identity and exact current
receipt/readback before exposing a link rather than relying on a status URL
alone. No scheduled recovery covers a suppressed event.

The PR build runs in the `ubuntu-vm` container, with a 4 GiB container limit and
a 30-minute runner timeout. Its Node heap is capped at 3072 MiB. An
out-of-memory or timeout failure remains a failure. Build and publisher jobs use
the existing shared `runner` account and rootless Docker infrastructure. Build
jobs permit the runner's daemon endpoint and proxy socket. This arrangement does
not isolate publication credentials from PR code; omitted workflow secret
mappings do not establish what the forge includes in task payloads. Publisher
keys use private identity directories, and SSH, rsync and locking use absolute
`/usr/bin/ssh`, `/usr/bin/rsync` and `/usr/bin/flock` paths. These controls do not
provide separate-user credential isolation.

The caller grants the ordinary job token the Code-write permission needed for
status publication and supplies only `PREVIEW_SSH_PRIVATE_KEY` by name to the
deploy workflow. Fork tokens are not assumed to have status-write authority.
The source workflows take effect for a repository when its trusted controller
pins an immutable shared revision accepted on `main`. The disposable forced-SSH
fixture covers nested
creation and bounded cleanup; live receiver acceptance covers the deployed
pairing. No scheduled recovery covers a suppressed close event.

### Callable inputs and permissions

The reusable workflows take these inputs. The build returns `artifact-id`, the
identifier from its successful upload. Pass that output to the publish call;
cleanup and reopen omit it. Deploy returns no workflow outputs. This exact ID
selects the intended upload even when retries retain same-name artifacts under
one run ID; no repository-wide name search chooses an upload.

| Input           | Build default | Deploy default | Meaning                                                                                         |
| --------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `trusted-ref`   | required      | required       | Reviewed full lowercase shared-helper SHA; pin the external workflow call to the same revision. |
| `pr-number`     | required      | required       | Positive PR number from the trusted controller.                                                 |
| `source-sha`    | required      | required       | Full current PR head SHA; cleanup uses the close-event head for context.                        |
| `package`       | required      | required       | Lowercase package prefix.                                                                       |
| `artifact-name` | required      | empty          | Same-run artifact name; required when the operation is `publish`.                               |
| `artifact-id`   | unavailable   | empty          | Exact build upload ID; required when the operation is `publish`.                                |
| `min-pages`     | `1`           | `1`            | Minimum number of package `index.html` pages.                                                   |
| `max-pages`     | `0`           | `0`            | Maximum page count; zero means no count ceiling.                                                |
| `operation`     | unavailable   | required       | `publish`, `cleanup` or `reopen`.                                                               |

Build calls grant `contents: read` and omit a secrets mapping. Deploy calls grant
`contents: write` for commit statuses and `actions: read` for the same-run artifact.
Only `publish` and `cleanup` receive `PREVIEW_SSH_PRIVATE_KEY`; `reopen` uses the
ordinary job token alone. The reusable declaration marks the key optional so a
reopen call can omit it; publication and cleanup reject a missing key.

Both workflows require Gitea and `HL_DEPLOY_ENABLED=true`. With that variable
unset or false the operation is skipped, including cleanup and reopen status
invalidation. A successful run containing a skipped deploy is not publication
or deletion evidence. There is no reconciler: after a disabled gate, skipped
close event or failed cleanup, an operator must re-run trusted cleanup for the
closed PR. Do not treat enabling the variable as recovery of missed events.

A caller in this shared repository can use local reusable references at its
trusted main dispatch revision, as the receiver diagnostic does:

```yaml
permissions:
    contents: write
    actions: read
jobs:
    build:
        if: ${{ github.ref == 'refs/heads/main' }}
        permissions:
            contents: read
        uses: ./.gitea/workflows/build-internal-preview.yml
        with:
            trusted-ref: ${{ github.sha }}
            pr-number: ${{ inputs.pr-number }}
            source-sha: ${{ inputs.source-sha }}
            package: thalorna
            artifact-name: preview-pages
    publish:
        needs: build
        if: ${{ github.ref == 'refs/heads/main' }}
        uses: ./.gitea/workflows/deploy-internal-preview.yml
        with:
            trusted-ref: ${{ github.sha }}
            operation: publish
            pr-number: ${{ inputs.pr-number }}
            source-sha: ${{ inputs.source-sha }}
            package: thalorna
            artifact-name: preview-pages
            artifact-id: ${{ needs.build.outputs.artifact-id }}
        secrets:
            PREVIEW_SSH_PRIVATE_KEY: ${{ secrets.PREVIEW_SSH_PRIVATE_KEY }}
    cleanup:
        if: ${{ github.event.action == 'closed' }}
        uses: ./.gitea/workflows/deploy-internal-preview.yml
        with:
            trusted-ref: ${{ github.sha }}
            operation: cleanup
            pr-number: ${{ github.event.pull_request.number }}
            source-sha: ${{ github.event.pull_request.head.sha }}
            package: thalorna
        secrets:
            PREVIEW_SSH_PRIVATE_KEY: ${{ secrets.PREVIEW_SSH_PRIVATE_KEY }}
```

The example shows the call interfaces; a package repository's base-branch
controller supplies its own eligibility and event conditions and uses external
`HeroicLands/.github/.gitea/workflows/` references pinned to the reviewed full
commit. Its `trusted-ref` is that same shared commit, not the package's event
SHA. The repository context always comes from the caller, never an artifact.
The source repository must contain a package-build site for the build call.
Cleanup has no build dependency and ignores label removal and draft state.

### Preview build capacity diagnostic

The build-only capacity workflow accepts a ready Thalorna pull request number and
its current full head SHA, and a memory profile of `4g` (default) or `2g`.
The profiles request matching container memory and swap limits. The `4g` profile
uses a 3072 MiB Node heap, and the `2g` profile uses a 1536 MiB Node heap. The job verifies the actual cgroup limit
before building; a runner that retains a different limit fails the profile. The
`2g` profile measures the smaller limit independently of the production `4g`
profile. It validates the same-repository identity against the forge and runs
the shared preview build commands with the nested preview base
URL. It does not publish a preview or require the preview label. The pages
artifact is the normalized build output; telemetry records elapsed time, maximum
resident memory and shell exit status for each command, plus available cgroup
memory values. GNU time also reports signal termination. An unavailable cgroup value is recorded explicitly. A failed command,
timeout, interrupted upload or missing artifact is not a capacity result. A
job-level timeout can prevent the telemetry upload.

The forced SSH fixture runs in a CI job container with an ephemeral
key and loopback server. It exercises nested creation, repeat publication,
receipt readback, PR cleanup and cancellation against `rrsync`. Its sentinels
cover sibling PR, main and CDN paths. This fixture exercises its disposable receiver;
the deployed receiver requires its own acceptance evidence.

### Deployed receiver diagnostic

Both diagnostics require dispatch from `refs/heads/main`; another ref fails the
explicit dispatch guard and skips every diagnostic operation. Helper checkouts
use the dispatch SHA, and receiver jobs call the deploy workflow locally from
that same revision. The capacity diagnostic requires the container image,
network access for normal dependencies, GNU time and the selected memory budget.

The manually dispatched receiver diagnostic requires `HL_DEPLOY_ENABLED=true`,
`actions: read` and `contents: write`, the named `PREVIEW_SSH_PRIVATE_KEY`, atlas's
pinned host key, the provisioned forced-rrsync receiver and HTTPS receipt
readback. It uses the shared runner arrangement described above. A ready
same-repository controlled PR must carry the existing `ci/preview`
label for publication; cleanup requires that PR to be closed. It stages a small fixture for a
controlled, ready same-repository PR with `ci/preview`. Supply its number and
full current head SHA. The trusted publisher validates the artifact and checks
the PR and receipt before recording status. After that controlled PR closes,
the `cleanup` operation checks its closed state, invalidates its status and
removes its preview subtree. The diagnostic declares the named preview key only on
the publisher call and does not run PR code. Check the receipt, status and sibling,
main and CDN paths when assessing the result. This fixture does not establish
consumer-controller behavior or site-build capacity.
