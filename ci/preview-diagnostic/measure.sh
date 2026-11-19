#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
metrics="$GITHUB_WORKSPACE/diagnostic"
mkdir -p "$metrics"
telemetry() {
    local phase="$1" file
    for file in memory.max memory.peak memory.events memory.current; do
        if [[ -r "/sys/fs/cgroup/$file" ]]; then
            head -c 4096 "/sys/fs/cgroup/$file" > "$metrics/${phase}-${file}.txt"
        else
            printf 'unavailable\n' > "$metrics/${phase}-${file}.txt"
        fi
    done
}
telemetry before
trap 'telemetry after' EXIT
source "$(dirname "$0")/measure-command.sh"

measure install npm ci
measure dependencies npm run build:deps
measure site node_modules/.bin/package-build site build --root internal.heroiclands.org --base-url "$PREVIEW_BASE_URL"
