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
provides: Node 24, Typst, Hugo (extended), GraphViz, poppler-utils, unzip, jq
and yq v4. Node, Typst, Hugo and yq are pinned to exact versions with a SHA-256
per architecture, verified during the build. GraphViz, poppler-utils, jq and
unzip come from the Ubuntu 24.04 archive. Each host builds the image itself, so
the local architecture is used; the tag in the runner configs (`ci-job:1`) is
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

## Bumping an image

Edit the versions and checksums at the top of `image/Dockerfile` (or
`image/Dockerfile.e2e`), then increment the image tag in the runner
configuration and install scripts in the infrastructure repository and re-run
the install scripts there. A new tag builds a new image; the previous image
stays on a host until removed with `docker image rm`.
