# Runner hosts

Jobs are routed by label. A workflow asks for the lightest label that fits, and
the host serving that label runs the job.

| Label                                | Host     | Runner instance   | Capacity |
| ------------------------------------ | -------- | ----------------- | -------- |
| `ubuntu-latest`, `x86`, `linux`, `ubuntu-vm` | excelsior | `gitea-runner` (systemd) | 8 |
| `light`                              | atlas    | `atlas-light`     | 2        |
| `light`, `lint`                      | Intrepid | `intrepid-check`  | 2        |
| `book`, `e2e`                        | Intrepid | `intrepid-heavy`  | 1        |

```yaml
jobs:
  attribution:
    runs-on: light
```

Builds, compiles, deploys and releases stay on excelsior. `light` jobs finish in
seconds and need almost no memory: attribution scans, changeset review, label
and TODO checks. `lint` is the content, prose and registry checks, which take
minutes and gigabytes. `book` is PDF and Typst book generation. `e2e` is a full
Foundry end-to-end run.

atlas also hosts Gitea, so a job there competes with every push and page view.
It takes only `light`, two at a time, and every job container carries a memory,
CPU and process cap so the forge cannot be starved. Intrepid has no such
constraint and takes the work that needs real CPU and memory.

## Why Intrepid runs two instances

A Gitea runner has one capacity shared by all its labels. `light` and `lint`
suit two concurrent jobs; `book` and `e2e` each use most of the machine and must
not overlap. Two instances express both: `intrepid-check` (`light`, `lint`,
capacity 2) and `intrepid-heavy` (`book`, `e2e`, capacity 1, so a book never
runs beside an e2e run). `light` is served by both Intrepid and atlas; Gitea
hands a job to whichever idle runner asks first.

Jobs on Intrepid and atlas always run in containers (the job image), never on
the host, so the workflows' GNU `sed`, `date` and paths behave as on excelsior.

## Layout

| Path | Contents |
| ---- | -------- |
| `image/Dockerfile` | The job image, built for `linux/amd64` and `linux/arm64` |
| `image/Dockerfile.e2e` | The e2e image, built on the job image |
| `intrepid/` | `compose.yml`, runner configs and `install.sh` for Intrepid |
| `atlas/` | `compose.yml`, runner config and `install.sh` for atlas |

### The job image

`heroiclands/ci-job:<tag>` is `catthehacker/ubuntu:act-24.04` (pinned by index
digest, published for amd64 and arm64) plus the tool set excelsior's host
provides: Node 24, Typst, Hugo (extended), GraphViz, poppler-utils, unzip, jq
and yq v4. Node, Typst, Hugo and yq are pinned to exact versions with a SHA-256
per architecture, verified during the build. GraphViz, poppler-utils, jq and
unzip come from the Ubuntu 24.04 archive. Each host builds the image itself, so
the local architecture is used; the tag in the runner configs (`ci-job:1`) is
the single selector.

### The e2e image

`heroiclands/ci-e2e:<tag>` is the job image of the same tag plus what Cypress
needs headless: Xvfb, GTK, NSS, ALSA and the other libraries Electron and
Chromium link against, and fonts. A suite run with `--browser chromium` finds a
Chromium on `PATH`: Ubuntu 24.04 ships Chromium only as a snap, which does not
run in a container, so the image carries the Chrome for Testing build
Playwright publishes for linux-arm64 and linux-x64, pinned by version and
SHA-256. `chromium --version` answers `Chromium <version>`, which is how Cypress
recognises it. Only the `e2e` label uses this image, so `light`, `lint` and
`book` jobs do not carry its weight.

## End-to-end runs on Intrepid

`intrepid-heavy` runs `.gitea/workflows/e2e-full.yml`, which each package calls
with its package id. A job there drives a Foundry container through OrbStack's
docker:

- **The docker socket.** The runner mounts it into every job (through its
  per-job proxy, which removes whatever the job created when the job ends).
- **Host networking.** package-build and Cypress reach Foundry at
  `localhost:<port>`, the port the Foundry container publishes on the VM, so
  jobs share the VM's network (`container.network: host`).
- **Paths that mean the same on both sides.** package-build mounts the Foundry
  data root and download cache into Foundry with `docker run -v <path>`, which
  the daemon resolves in OrbStack's VM. The VM sees macOS paths under
  `/Users` at the same path, so the e2e directory is mounted into the job at
  its own macOS path too, and a path the job names is the path the daemon
  mounts.
- **Ownership.** OrbStack's file sharing presents every file as owned by the
  user that reads it and accepts `chown` without changing anything, so the
  `uid:gid` package-build hands the Foundry tree to does not matter here.

| Path on Intrepid | Mounted as | Holds |
| ---------------- | ---------- | ----- |
| `~/.local/share/heroiclands/e2e/` | `HL_E2E_ROOT` | `data/` (the Foundry data root every package shares, with its licence), `cache/` (Foundry releases), `cypress/` (Cypress binaries), `npm/` |
| `~/.config/heroiclands-e2e/` (mode 700) | `HL_E2E_SECRETS`, read-only | `<package>.env.local` per package (mode 600) |

The workflow copies `<package>.env.local` into the checkout as `.env.local` and
sets `FOUNDRYVTT_TEST_DATA`, `FOUNDRYVTT_CACHE` and `CYPRESS_CACHE_FOLDER` from
`HL_E2E_ROOT` in the job's environment, which package-build and Cypress prefer
to the file. So a package's `.env.local` is copied as it is, whatever host paths
it names.

The mounts belong to the runner instance, so a `book` job sees them as well; the
`e2e` and `book` labels are for this organization's own workflows only.

### The Foundry licence on Intrepid

Foundry binds a licence's signature to the installation, and the felddy image
applies a key without signing it. A fresh data root therefore starts with an
unsigned licence (`license.json` holding only the key) and no world ever
activates: the container logs `Software license requires signature.` and
package-build gives up after its wait. Sign it once, by hand:

1. On Intrepid, in a checkout of any package that runs e2e, after `npm ci` and
   with its `.env.local` in place, and with OrbStack's `docker` and Homebrew's
   `node` on `PATH`:

   ```bash
   e2e="$HOME/.local/share/heroiclands/e2e"
   FOUNDRYVTT_TEST_DATA="$e2e/data" FOUNDRYVTT_CACHE="$e2e/cache" \
     npx package-build container test start
   ```

   No world is named, so Foundry starts at its licence page.
2. From excelsior, `ssh -L 30003:localhost:30003 intrepid` and open
   `http://localhost:30003`. Accept the licence agreement.
3. `package-build container test rm`.

The signature lives in `data/Config/license.json` and survives every later run,
because the container keeps the hostname `heroiclands-foundry-test`.

### Calling it

Gitea evaluates `on.schedule` cron in UTC, whatever the server's time zone. A
caller names its own triggers:

```yaml
on:
  schedule:
    - cron: "30 8 * * *" # 01:30 Pacific daylight time
  workflow_dispatch:
  pull_request:
    types: [labeled]

jobs:
  e2e:
    if: github.event_name != 'pull_request' || github.event.label.name == 'e2e'
    uses: HeroicLands/.github/.gitea/workflows/e2e-full.yml@main
    with:
      package: sohl
      build-script: build:tested-stage
```

## Installing a host

The registration token is an organization-level runner token. Create it in
Gitea under the HeroicLands organization, Settings, Actions, Runners, Create new
runner. Treat it as a secret: it is read from a file and never passed on a
command line or printed.

### Intrepid

1. Install OrbStack and start it. Set its memory limit to 12 to 14 GB (OrbStack
   Settings, System, or `orb config set memory_mib 13312`).
2. Write the token and restrict it:

   ```bash
   mkdir -p ~/.config/gitea-runner
   umask 077
   printf '%s\n' '<token>' > ~/.config/gitea-runner/registration-token
   ```

3. From a checkout of this repository: `runners/intrepid/install.sh`.
4. For each package with an e2e suite, copy its `.env.local` from a machine
   that runs that suite, without printing it:

   ```bash
   scp <repo>/.env.local intrepid:.config/heroiclands-e2e/<package>.env.local
   ssh intrepid 'chmod 600 ~/.config/heroiclands-e2e/*.env.local'
   ```

   Then sign the Foundry licence once (see
   [The Foundry licence on Intrepid](#the-foundry-licence-on-intrepid)).

The script copies `compose.yml` and both configs into
`~/.local/share/heroiclands/gitea-runner/`, builds `heroiclands/ci-job:<tag>`
and `heroiclands/ci-e2e:<tag>` with OrbStack's docker, creates the e2e
directories, registers `intrepid-check` and `intrepid-heavy` once
with the official `gitea/runner` image (the token is read from the mounted
file), and runs `docker compose up -d`. Each instance keeps its state and cache
in `data/<instance>/` beside the stack.

Both runners are containers in OrbStack's Linux VM rather than macOS processes.
Gitea is reachable only on the LAN, and macOS withholds local-network access
from an unsigned binary started by launchd; OrbStack's VM has that access. The
runners use host networking, so each cache server listens on the VM's address,
which job containers reach through their bridge gateway. OrbStack starts at
login and brings the containers back with it, so the account stays logged in
(or the machine auto-logs in) and OrbStack is set to start at login.

The script points docker at a configuration of its own
(`~/.config/gitea-runner/docker/`) with an empty Docker Hub entry, so pulls are
anonymous and never ask the macOS keychain, which is locked to an SSH session.

### atlas

1. Write the token to the stack's `env/` directory:

   ```bash
   sudo install -d /srv/docker/stacks/gitea-runner/env
   sudo sh -c 'umask 077; printf "%s\n" "<token>" > /srv/docker/stacks/gitea-runner/env/registration-token'
   ```

2. From a checkout of this repository: `runners/atlas/install.sh`, as a user
   that can use docker.

The script copies `compose.yml` and `config.yaml` into
`/srv/docker/stacks/gitea-runner/`, builds the job image natively for arm64,
registers `atlas-light` once with the official `gitea/runner` image (the token
is read from the mounted file), and runs `docker compose up -d`. The runner
container is capped at 512 MB and half a core; each job container is capped at
1 GB, 0.75 core and 512 processes, so two concurrent jobs stay within 2 GB and
1.5 cores.

## Operating

- **Online check.** Each instance appears in the organization's runner list
  with exactly its labels. A throwaway workflow with `runs-on: light` and
  another with `runs-on: lint` confirm routing.
- **Bump the runner.** Change the `image:` tag in both `compose.yml` files and
  `RUNNER_IMAGE` in both install scripts, then re-run the scripts; each runner
  restarts on the new image after a drain.
- **Bump the job image.** Edit the versions and checksums at the top of
  `image/Dockerfile` (or `image/Dockerfile.e2e`), increment the tag in the
  `labels` of all three configs and in `IMAGE_TAG` of both install scripts, and
  re-run the scripts. Each script
  refuses to run when its config and tag disagree. A new tag builds a new image;
  the previous image stays until removed with `docker image rm`.
- **Change a label or capacity.** Edit the config in this directory and re-run
  the install script: it copies the config and restarts the instance. Labels are
  re-registered by deleting the runner in Gitea and its state file
  (`.runner`) before re-running.
- **Drain and stop.** A stop signal makes the runner take no new jobs and wait
  up to `shutdown_timeout` (10 minutes on Intrepid, 5 on atlas) for running ones.
  Intrepid:
  `docker compose -f ~/.local/share/heroiclands/gitea-runner/compose.yml stop check`
  (or `heavy`; `stop_grace_period` is 11 minutes). atlas:
  `docker compose -f /srv/docker/stacks/gitea-runner/compose.yml stop`
  (`stop_grace_period` is 6 minutes). `start` brings an instance back.
- **Logs.** `docker logs intrepid-check`, `docker logs intrepid-heavy` and
  `docker logs atlas-light`.
