#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
measure() {
    local name="$1" status=0
    shift
    /usr/bin/time -o "$metrics/${name}.txt" -f 'elapsed_seconds=%e\nmaximum_rss_kib=%M' "$@" || status=$?
    printf 'shell_exit_status=%s\n' "$status" >> "$metrics/${name}.txt"
    return "$status"
}
