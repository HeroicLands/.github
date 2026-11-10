# Runner job images

The Dockerfiles for the images that container-mode Gitea Actions runners run
jobs in. The configuration of the runner hosts themselves lives in the
HeroicLands infrastructure repository, whose install scripts build these images
from this directory.

| Path | Contents |
| ---- | -------- |
| `image/Dockerfile` | The job image, built for `linux/amd64` and `linux/arm64` |
| `image/Dockerfile.e2e` | The e2e image, built on the job image |

## The job image

`heroiclands/ci-job:<tag>` is `catthehacker/ubuntu:act-24.04` (pinned by index
digest, published for amd64 and arm64) plus the tool set the x86 runner's host
provides: Node, Typst, GraphViz, poppler-utils, unzip, rsync, jq, yq v4 and Python 3.13 (with `venv`; the fonts build pins it, and Ubuntu 24.04's own `python3` is 3.12). Node,
Typst and yq are pinned to exact versions with a SHA-256 per architecture,
verified during the build. GraphViz, poppler-utils, jq, rsync and unzip come from the
Ubuntu 24.04 archive, and Python 3.13 from the deadsnakes archive for Ubuntu. Each host builds the image for its local architecture;
the tag in the runner configuration, such as `ci-job:4`, selects that image.

## The e2e image

`heroiclands/ci-e2e:<tag>` is the job image of the same tag plus what Cypress
needs headless: Xvfb, GTK, NSS, ALSA and the other libraries Electron and
Chromium link against, and fonts. A suite run with `--browser chromium` finds a
Chromium on `PATH`: Ubuntu 24.04 ships Chromium only as a snap, which does not
run in a container, so the image carries the Chrome for Testing build
Playwright publishes for linux-arm64 and linux-x64, pinned by version and
SHA-256. `chromium --version` answers `Chromium <version>`, which is how Cypress
recognises it. Only the `e2e` label uses this image, so other jobs do not carry
its weight. It is built with `--build-arg BASE=heroiclands/ci-job:<tag>`.

## The central Node target

The owner sets `CI_NODE_VERSION`, the organization Actions variable on Gitea
and GitHub where workflows run. Its value is a bare major such as `26`, not a
patch or a version range. Shared workflows default to the variable and use
`24` when it is missing or empty. A nonempty `node-version` caller input takes
precedence; an empty input falls back to the central target. Own setup-node
steps use the same variable and fallback. CI Node selection is separate from
packages' declared `engines.node` requirements.

Reusable input defaults use `${{ vars.CI_NODE_VERSION || '24' }}`.
All version consumers use
`${{ inputs.node-version || vars.CI_NODE_VERSION || '24' }}`. The CDN manual
trigger has an empty literal default and applies that expression at consumption:
Gitea's dispatch fallback reads a literal default. The Foundry book runner
checks that its effective Node major equals the same resolved target.

[GitHub's context table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
defines the contexts available in reusable defaults and step inputs.
[Gitea's variable documentation](https://docs.gitea.com/usage/actions/actions-variables/)
describes organization variables and their precedence.

On Gitea use organization Settings → Actions → Variables. On GitHub use
organization Settings → Secrets and variables → Actions → Variables, with
visibility covering all intended caller repositories. Check repository and
environment variables with the same name: their precedence can shadow the
organization value. Record the variable's actual existence, value and
visibility before changing it.

| Operation | Name | Value |
| --- | --- | --- |
| Select a Node major | `CI_NODE_VERSION` | a bare major, such as `26` |
| Use the compatible fallback | `CI_NODE_VERSION` | unset or empty selects `24` |
| Restore the target | `CI_NODE_VERSION` | the captured value and visibility, or its captured absence |

## Bumping an image

Update the exact versions and architecture checksums in `image/Dockerfile`
or `image/Dockerfile.e2e` from the upstream release data. For Node, use the
[release index](https://nodejs.org/dist/index.json) and the chosen release's
`SHASUMS256.txt`. For example, the Node 26.13.0 recipe's checked-in evidence is
[`ci/fixtures/node26-release.json`](../ci/fixtures/node26-release.json), from
the [official checksums](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt).

Choose a new image tag and build from the reviewed shared-source SHA on both
architectures before changing selectors. The job and e2e image tags match,
and the e2e build names that job image as its base. For example, tag 4 uses:

```sh
docker build -f runners/image/Dockerfile -t heroiclands/ci-job:4 .
docker build -f runners/image/Dockerfile.e2e \
  --build-arg BASE=heroiclands/ci-job:4 -t heroiclands/ci-e2e:4 .
```

The owner coordinates the host binaries, image selectors and central variable
as one compatible combination. Record the actual rollback inputs before a
switch: host binary paths and versions, image IDs and tags, runner selector
configurations, variable existence/value/visibility and release-gate values.
Node/image updates preserve the Atlas runner binary; a runner-binary update
requires separate approval. Foundry's application container keeps its own
runtime policy.

Pause only the six Foundry release callers for the controlled drain:
`Song-of-Heroic-Lands-FoundryVTT`, `thalorna`, `sohl-kethira-basic`,
`harn-adventures`, `harn-ensemble` and `HarnMaster-3-FoundryVTT`. Record their
gate values and let active releases finish. Other setup-node jobs select their
runtime independently of the host.

Before switching, verify the candidate images and dry-run package-build's
`ubuntu-vm` job using the candidate tag, such as `ci-job:4` (Node 26 and Python 3.13).
Keep the exact-major release guard and required checks intact. Resume the six
release gates with their captured values only when the requested and effective
release majors agree.

Rollback restores the captured complete combination of binaries, images,
selectors, central variable and release gates. Retain the corresponding images
and registrations, secrets and Foundry data. A major change uses reviewed image
rebuilds and the central variable; unrelated action pins and package-engine
requirements follow their own policies.
