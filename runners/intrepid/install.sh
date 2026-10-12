#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs Intrepid's two Gitea Actions runners as containers in OrbStack's Linux
# VM. Safe to re-run: every step that is already done is skipped.
#
# The runners run in containers rather than as macOS processes because macOS
# withholds local-network access from an unsigned binary that launchd starts, and
# Gitea is reachable only on the LAN. OrbStack's VM has that access.
#
# Requires OrbStack running (it provides docker) and the registration token in
# ~/.config/gitea-runner/registration-token (mode 600).
set -euo pipefail

RUNNER_IMAGE="gitea/runner:5.0.0"
IMAGE_TAG="1"
JOB_IMAGE="heroiclands/ci-job:${IMAGE_TAG}"
INSTANCE_URL="https://git.pupluppy.org/"
INSTANCES="check heavy"

here="$(cd "$(dirname "$0")" && pwd)"
repo_runners="$(cd "${here}/.." && pwd)"
conf="${HOME}/.config/gitea-runner"
stack="${HOME}/.local/share/heroiclands/gitea-runner"
token_file="${conf}/registration-token"
sock="${HOME}/.orbstack/run/docker.sock"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || die "this script is for macOS on Apple silicon"
[ -S "${sock}" ] || die "OrbStack's docker socket is missing at ${sock}; start OrbStack"
[ -f "${token_file}" ] || die "registration token file ${token_file} is missing"
[ "$(stat -f '%Lp' "${token_file}")" = "600" ] || die "${token_file} must be mode 600"

# A docker configuration of the runner's own. Docker consults the macOS keychain
# for any registry its configuration says nothing about, and the keychain is
# locked to a session without a login window, so an SSH-run build fails there.
# An empty Docker Hub entry makes every pull anonymous and keeps the keychain
# out of it.
export PATH="${HOME}/.orbstack/bin:${PATH}"
export DOCKER_CONFIG="${conf}/docker"
export DOCKER_HOST="unix://${sock}"
mkdir -p "${DOCKER_CONFIG}"
# OrbStack installs buildx and compose as plugins under ~/.docker.
ln -sfn "${HOME}/.docker/cli-plugins" "${DOCKER_CONFIG}/cli-plugins"
[ -f "${DOCKER_CONFIG}/config.json" ] \
  || printf '%s\n' '{"auths":{"https://index.docker.io/v1/":{}}}' > "${DOCKER_CONFIG}/config.json"
docker info >/dev/null 2>&1 || die "docker is not answering; start OrbStack"

mkdir -p "${stack}"
install -m 0644 "${here}/compose.yml" "${stack}/compose.yml"
changed=""
for i in ${INSTANCES}; do
  grep -q "heroiclands/ci-job:${IMAGE_TAG}\"" "${here}/${i}.yaml" \
    || die "${i}.yaml labels do not reference ${JOB_IMAGE}"
  cmp -s "${here}/${i}.yaml" "${stack}/${i}.yaml" || changed="${changed} ${i}"
  install -m 0644 "${here}/${i}.yaml" "${stack}/${i}.yaml"
  mkdir -p "${stack}/data/${i}"
done

# Job image, built for this machine's architecture (arm64).
if ! docker image inspect "${JOB_IMAGE}" >/dev/null 2>&1; then
  say "Building ${JOB_IMAGE}"
  docker buildx build --load -t "${JOB_IMAGE}" "${repo_runners}/image"
fi

for i in ${INSTANCES}; do
  if [ -s "${stack}/data/${i}/.runner" ]; then
    say "intrepid-${i} is already registered"
  else
    say "Registering intrepid-${i}"
    docker run --rm \
      -v "${stack}/${i}.yaml:/config.yaml:ro" \
      -v "${stack}/data/${i}:/data" \
      -v "${token_file}:/run/secrets/registration-token:ro" \
      --workdir /data \
      --entrypoint gitea-runner \
      "${RUNNER_IMAGE}" \
      --config /config.yaml register --no-interactive \
        --instance "${INSTANCE_URL}" --name "intrepid-${i}" \
        --token-file /run/secrets/registration-token >/dev/null
  fi
  # The state file holds the runner's credential.
  chmod 600 "${stack}/data/${i}/.runner"
done

(cd "${stack}" && docker compose up -d)
# A config is read at start, so a changed one needs a restart (after a drain).
for i in ${changed}; do
  (cd "${stack}" && docker compose restart "${i}")
done
say "Done. intrepid-check and intrepid-heavy should show online in Gitea."
