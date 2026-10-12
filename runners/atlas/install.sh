#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs the atlas-light runner under /srv/docker/stacks/gitea-runner/.
# Run on atlas as a user that can use docker. Safe to re-run: registration and
# the image build are skipped when already done.
#
# Requires the registration token in
# /srv/docker/stacks/gitea-runner/env/registration-token (mode 600).
set -euo pipefail

RUNNER_IMAGE="gitea/runner:5.0.0"
IMAGE_TAG="1"
JOB_IMAGE="heroiclands/ci-job:${IMAGE_TAG}"
# atlas hosts Gitea, so it reaches it directly rather than through cerberus.
INSTANCE_URL="http://atlas.pupluppy.internal:3080"
STACK="/srv/docker/stacks/gitea-runner"

here="$(cd "$(dirname "$0")" && pwd)"
repo_runners="$(cd "${here}/.." && pwd)"
token_file="${STACK}/env/registration-token"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "aarch64" ] || die "this script is for atlas (arm64)"
docker info >/dev/null 2>&1 || die "docker is not available to this user"
[ -f "${token_file}" ] || die "registration token file ${token_file} is missing"
[ "$(stat -c '%a' "${token_file}")" = "600" ] || die "${token_file} must be mode 600"
grep -q "heroiclands/ci-job:${IMAGE_TAG}\"" "${here}/config.yaml" \
  || die "config.yaml labels do not reference ${JOB_IMAGE}"

mkdir -p "${STACK}/data"
install -m 0644 "${here}/compose.yml" "${STACK}/compose.yml"
changed=0
cmp -s "${here}/config.yaml" "${STACK}/config.yaml" || changed=1
install -m 0644 "${here}/config.yaml" "${STACK}/config.yaml"

if ! docker image inspect "${JOB_IMAGE}" >/dev/null 2>&1; then
  echo "Building ${JOB_IMAGE}"
  docker build -t "${JOB_IMAGE}" "${repo_runners}/image"
fi

if [ -s "${STACK}/data/.runner" ]; then
  echo "atlas-light is already registered"
else
  echo "Registering atlas-light"
  docker run --rm \
    -v "${STACK}/config.yaml:/config.yaml:ro" \
    -v "${STACK}/data:/data" \
    -v "${token_file}:/run/secrets/registration-token:ro" \
    --workdir /data \
    --entrypoint gitea-runner \
    "${RUNNER_IMAGE}" \
    --config /config.yaml register --no-interactive \
      --instance "${INSTANCE_URL}" --name atlas-light --labels "light:docker://${JOB_IMAGE}" \
      --token-file /run/secrets/registration-token >/dev/null
fi
# The state file holds the runner's credential. The runner container writes it
# as root, so its mode is set from a container too.
docker run --rm -v "${STACK}/data:/data" --entrypoint chmod "${RUNNER_IMAGE}" 600 /data/.runner

(cd "${STACK}" && docker compose up -d)
# The config is read at start, so a changed one needs a restart (after a drain).
[ "${changed}" = 0 ] || (cd "${STACK}" && docker compose restart runner)
echo "Done. atlas-light should show online in Gitea."
