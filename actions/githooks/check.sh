#!/bin/sh
# Copyright (c) 2024-2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

# This script belongs to the action checkout, independent of the consumer tree.
canonical=$(CDPATH= cd -- "$(dirname -- "$0")/../../githooks" && pwd)
consumer=${1:-.githooks}
status=0
for source in "$canonical"/* "$canonical"/.[!.]* "$canonical"/..?*; do
    [ -e "$source" ] || continue
    name=${source##*/}
    target=$consumer/$name
    if [ ! -f "$target" ] || [ -L "$target" ]; then
        printf '%s: error: missing canonical hook\n' "$target" >&2
        status=1
    elif ! cmp -s "$source" "$target"; then
        printf '%s: error: differs from canonical hook\n' "$target" >&2
        status=1
    fi
done
for target in "$consumer"/* "$consumer"/.[!.]* "$consumer"/..?*; do
    [ -e "$target" ] || [ -L "$target" ] || continue
    name=${target##*/}
    if [ ! -f "$canonical/$name" ]; then
        printf '%s: error: extra hook\n' "$target" >&2
        status=1
    fi
done
exit "$status"
