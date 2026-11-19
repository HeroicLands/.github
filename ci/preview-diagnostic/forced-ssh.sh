#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
[[ -f /.dockerenv && "$(id -u)" == 0 ]] || { echo 'Fixture requires a root job container' >&2; exit 1; }
fixture=$(mktemp -d /tmp/preview-fixture.XXXXXXXX)
server_pid=
cleanup() {
    status=$?
    if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || :; wait "$server_pid" 2>/dev/null || :; fi
    if (( status != 0 )) && [[ -f "$fixture/sshd.log" ]]; then head -c 8192 "$fixture/sshd.log" >&2; fi
    rm -rf "$fixture"
    exit "$status"
}
trap cleanup EXIT
mkdir -p "$fixture/receiver" /run/sshd
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
printf 'restrict,command="/usr/bin/rrsync -wo -munge %s/receiver" ' "$fixture" > "$fixture/authorized_keys"
cat "$fixture/client.pub" >> "$fixture/authorized_keys"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
cat > "$fixture/sshd_config" <<CONFIG
Port $port
ListenAddress 127.0.0.1
HostKey $fixture/host
PidFile $fixture/sshd.pid
AuthorizedKeysFile $fixture/authorized_keys
StrictModes no
PermitRootLogin yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
AllowUsers root
LogLevel ERROR
CONFIG
/usr/sbin/sshd -t -f "$fixture/sshd_config"
/usr/sbin/sshd -D -f "$fixture/sshd_config" -E "$fixture/sshd.log" &
server_pid=$!
ready=0
for ((i=0; i<100; i++)); do
    kill -0 "$server_pid" || break
    if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then ready=1; break; fi
    sleep 0.05
done
[[ "$ready" == 1 ]] || { echo 'Fixture SSH server did not start' >&2; exit 1; }
read -r keytype keydata _ < "$fixture/host.pub"
printf '[127.0.0.1]:%s %s %s\n' "$port" "$keytype" "$keydata" > "$fixture/known_hosts"
export PREVIEW_FIXTURE_ROOT="$fixture" PREVIEW_FIXTURE_PORT="$port"
timeout 120s node --test ci/preview-diagnostic/forced-ssh.test.mjs
