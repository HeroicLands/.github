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
provides: Node 26.13.0, Typst, GraphViz, poppler-utils, unzip, jq and yq v4. Node,
Typst and yq are pinned to exact versions with a SHA-256 per architecture,
verified during the build. GraphViz, poppler-utils, jq and unzip come from the
Ubuntu 24.04 archive. Each host builds the image itself, so
the local architecture is used; the tag in the runner configs (`ci-job:3`) is
the single selector.

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

## Building and selecting tag 3

The job recipe uses the official Node 26.13.0 release, with separate Linux
x64/arm64 SHA-256 values. The checked-in release evidence is
[`ci/fixtures/node26-release.json`](../ci/fixtures/node26-release.json); its
sources are the [Node release index](https://nodejs.org/dist/index.json) and
[release checksums](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt).
The e2e recipe defaults to `heroiclands/ci-job:3`. Both images retain the Ubuntu
base, existing browser/tool pins and Foundry container runtime.

The owner builds tag 3 from a reviewed shared-source SHA on each architecture
before changing any selector. Package-build's `ubuntu-vm` job receives an
isolated tag-3 dry run before the fleet switch. The Atlas runner binary stays
unchanged. No image build, host installation, restart or deployment forms part
of this source change.

## The central Node target

`CI_NODE_VERSION` is the single organization Actions variable, on Gitea and
GitHub where workflows run. Its value is a bare major such as `24` or `26`,
not a patch or a version range. Shared workflows default to the variable and
retain `24` when it is missing or empty. An explicit `node-version` caller
input takes precedence, including an explicit empty input falling back to
the central target. Own setup-node steps use the same variable and fallback.
Public package `engines.node` requirements remain unchanged.

Reusable input defaults use `${{ vars.CI_NODE_VERSION || '24' }}`.
All version consumers use
`${{ inputs.node-version || vars.CI_NODE_VERSION || '24' }}`. The CDN manual
trigger has an empty literal default and applies that expression at consumption:
Gitea's dispatch fallback reads a literal default, so it does not need to
interpret a variable expression there. The Foundry book runner retains its
exact-major check against the same resolved target.

[GitHub's context table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
permits `github`, `inputs` and `vars` in workflow-call input defaults, and
`vars` in step inputs/environment. [Gitea's variable documentation](https://docs.gitea.com/usage/actions/actions-variables/)
defines organization variables in `vars`. The pinned
[runner 5.0.0 expression source](https://gitea.com/gitea/runner/src/tag/v5.0.0/act/runner/expression.go)
provides `Vars` and delegates reusable defaults to actionslib 1.3.0.
[Its default resolver](https://gitea.com/gitea/actionslib/src/tag/v1.3.0/pkg/expreval/workflow_call.go)
permits the same contexts; [its upstream regression](https://gitea.com/gitea/actionslib/src/tag/v1.3.0/pkg/expreval/evaluator_test.go)
exercises a variable-derived default. Local guards enumerate the declarations,
check the supported expression subset and execute the actual book-major shell
guard with matching and mismatching runtimes. They do not claim a deployed
GitHub/Gitea run or a tag-3 runtime smoke.

## Owner variable and deployment inputs

Rosa's organization-variable API access receives HTTP 403. The owner provisions
and switches the variable; no settings write is part of this packet.

| Operation | Name | Value | Scope |
| --- | --- | --- | --- |
| Stage compatible defaults | `CI_NODE_VERSION` | `24` | HeroicLands organization Actions variable on each forge |
| Select the reviewed Node 26 fleet | `CI_NODE_VERSION` | `26` | The same variable |
| Restore the compatible Node 24 fleet | `CI_NODE_VERSION` | `24` | The same variable |

On Gitea use organization Settings → Actions → Variables. On GitHub use
organization Settings → Secrets and variables → Actions → Variables, with
visibility covering all intended caller repositories. Record any existing
value/visibility before changing it. Check for repository or environment
variables with the same name: their precedence can shadow the organization
value. The source packet cannot verify those settings through Rosa's denied
organization API access.

Only the six Foundry release callers pause for the controlled drain: SoHL,
thalorna, sohl-kethira-basic, harn-adventures, harn-ensemble and HarnMaster 3.
Record their release gate values, let active releases finish, build and verify
tag 3, then dry-run package-build's ubuntu-vm job on tag 3. Switch the reviewed
host/image combination and central value together; keep the exact-major guard
and required checks intact. Other setup-node jobs select their runtime
independently of the host and do not require a broad release pause. Resume the
six gates only when the requested and effective release majors agree.

The measured deployed rollback image baseline is tag 1. Preserve actual host
binaries, selector configurations and variable/gate values before deployment;
source tag 2 alone does not describe that deployed baseline. Rollback restores
a compatible complete combination of those values. Never remove old images,
registration records, secrets or Foundry data as part of the Node switch.

A subsequent major uses reviewed image rebuilds and a variable change. Update
exact recipe versions and official architecture checksums, build a new image
tag first and run its smoke before selecting it. No unrelated action-pin or
package-engine migration belongs to that operation.
