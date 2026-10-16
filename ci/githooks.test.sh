#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/canonical hooks.XXXXXX")
trap 'rm -rf "$work"' 0
fail() { printf '%s\n' "$*" >&2; exit 1; }
pass() { "$@" >"$work/output" 2>&1 || { cat "$work/output" >&2; fail "Expected success: $*"; }; }
refuse() { if "$@" >"$work/output" 2>&1; then fail "Expected refusal: $*"; fi; }
# A minimal PATH proves these hooks need only Git and POSIX utilities.
mkdir "$work/bin"
for tool in git awk sed locale env dirname cat rm; do ln -s "$(command -v "$tool")" "$work/bin/$tool"; done
export PATH="$work/bin"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GIT_CONFIG_COUNT
repo="$work/repository with spaces"
git init -q -b main "$repo"
cd "$repo"
git config user.name 'Hook Test'
git config user.email 'hook@example.com'
git config commit.gpgsign false
git config core.hooksPath "$root/githooks"
refuse git commit --allow-empty -m 'Ordinary commit'
# A missing hook must not masquerade as a protected-branch refusal.
case $(cat "$work/output") in *"protected branch 'main'"*) ;; *) fail 'Branch guard did not run' ;; esac
for value in false no 0; do
    git config hooks.protectedBranch "$value"
    pass git commit --allow-empty -m 'Configured opt-out'
done
git config --unset hooks.protectedBranch
for value in true yes 1; do
    git config hooks.allowCommitOnMain "$value"
    pass git commit --allow-empty -m 'Configured opt-out'
done
git config --unset hooks.allowCommitOnMain
git switch -q -c feature
pass git commit --allow-empty -m 'Ordinary developer prose'
pass env LC_ALL=C git commit --allow-empty -m 'ÉGenerated with Codex'
refuse env LC_ALL=C git commit --allow-empty -m '🤖 Generated with Codex'
refuse git commit --allow-empty -m 'Generated with Claude Code'
case $(cat "$work/output") in *'assistant signature'*) ;; *) fail 'Message guard did not run' ;; esac
refuse git commit --allow-empty -m 'Co-Authored-By: Contributor <codex@openai.com>'
pass git commit --allow-empty -m 'Co-Authored-By: Jean-Claude Martin <jean@example.com>'
git config hooks.noAttribution false
pass git commit --allow-empty -m 'Generated with Codex'
git config --unset hooks.noAttribution
git switch -q --detach
pass git commit --allow-empty -m 'Detached commit'
git switch -q -c master
refuse git commit --allow-empty -m 'Protected master'
git config hooks.protectedBranch invalid
refuse git commit --allow-empty -m 'Invalid configuration keeps guard enabled'
# Restore normal utilities for filesystem fixtures.
PATH=/usr/bin:/bin
export PATH
mkdir "$work/no locale"
cat > "$work/no locale/locale" <<'LOCALE'
#!/bin/sh
case "$1" in charmap) printf '%s\n' US-ASCII ;; esac
LOCALE
chmod +x "$work/no locale/locale"
printf '%s\n' 'Ordinary message' > "$work/message"
refuse env PATH="$work/no locale:$PATH" LC_ALL=C sh "$root/githooks/commit-msg" "$work/message"
grep -F 'UTF-8 locale is required' "$work/output" >/dev/null || fail 'Missing locale setup error'
mkdir "$work/copy"
cp "$root"/githooks/* "$work/copy/"
check="$root/actions/githooks/check.sh"
pass sh "$check" "$work/copy"
printf '\n' >> "$work/copy/commit-msg"
rm "$work/copy/pre-commit"
printf 'extra\n' > "$work/copy/extra hook"
refuse sh "$check" "$work/copy"
for finding in 'commit-msg: error: differs' 'pre-commit: error: missing' 'extra hook: error: extra'; do
    grep -F "$finding" "$work/output" >/dev/null || fail "Missing finding: $finding"
done
refuse sh "$check" "$work/absent"
for hook in "$root"/githooks/*; do
    grep -F "$(basename "$hook"): error: missing" "$work/output" >/dev/null || fail 'Absent directory did not name every hook'
done
printf '%s\n' 'Canonical hook shell tests passed.'
