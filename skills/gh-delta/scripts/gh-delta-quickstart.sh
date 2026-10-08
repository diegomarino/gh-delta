#!/usr/bin/env bash
# Session-owned GitHub polling, compatible with macOS Bash 3.2.
#
# Usage (run from the repository checkout, not from this script's directory):
#   bash /path/to/gh-delta/scripts/gh-delta-quickstart.sh --check [scope]
#   bash /path/to/gh-delta/scripts/gh-delta-quickstart.sh [scope]
# Scope is pr, issue, or pr,issue (default). Polling sleeps 120 seconds AFTER
# each completed tick; it does not promise a fixed wall-clock schedule.
#
# --check prints one readiness JSON report and exits: 0 ready, 1 unavailable,
# 2 invalid arguments. It retains no files and performs no detector tick.
# Monitor mode uses the same preflight, then owns one private /tmp directory.
# Stdout carries template change lines; stderr carries errors and the readiness
# announcement after a successful baseline. No registry/config is written.
# Tick statuses 0/10 continue, 1 retries, and other statuses stop unchanged.
#
# Run in a foreground process whose output the agent can collect. SIGINT and
# SIGTERM stop its active process group (launcher descendants or sleep), reap
# the direct child, and exit 130/143. State is retained for inspection, not
# deleted. Never reuse another instance's root or recreate state every tick.
# See ../references/quickstart.md for preflight policy and lifecycle details.
set -u
# Each asynchronous child gets a process group, including launcher descendants.
set -m
child_pid=''
preflight_file=''
stop() {
  trap '' INT TERM
  # jobs also covers interruption between launching a child and recording $!.
  for pid in ${child_pid:-$(jobs -p)}; do
    kill -TERM -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  if [ -n "$preflight_file" ]; then rm -f -- "$preflight_file"; fi
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM

check=false
if [ "${1:-}" = '--check' ]; then
  check=true
  shift
fi
scope=${1-pr,issue}
if [ "$#" -gt 1 ]; then
  printf 'Usage: gh-delta-quickstart.sh [--check] [pr|issue|pr,issue]\n' >&2
  exit 2
fi
case "$scope" in
  pr | issue | pr,issue) ;;
  *)
    printf 'Scope must be pr, issue, or pr,issue.\n' >&2
    exit 2
    ;;
esac
if ! command -v node >/dev/null 2>&1; then
  printf '{"ready":false,"repo":null,"host":null,"launcher":null,"reason":"Node.js 22 or newer is required."}\n'
  exit 1
fi
# Resolve resources beside the installed skill, preserving the checkout cwd.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 1
rc=0
# Private capture lets preflight share the same cancellable child ownership.
preflight_file=$(mktemp /tmp/gh-delta-preflight.XXXXXXXXXX) || exit 1
node "$script_dir/gh-delta-preflight.mjs" "$scope" >"$preflight_file" &
child_pid=$!
wait "$child_pid" || rc=$?
child_pid=''
preflight=$(cat -- "$preflight_file")
rm -f -- "$preflight_file"
preflight_file=''
if [ "$check" = true ] || [ "$rc" -ne 0 ]; then
  printf '%s\n' "$preflight"
  exit "$rc"
fi
# Read validated JSON as data, not shell code; the launcher is never eval'd.
IFS=$'\t' read -r repo host launcher <<<"$(printf '%s' "$preflight" | node -e '
let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  const report = JSON.parse(data);
  console.log([report.repo, report.host, report.launcher.join(" ")].join("\t"));
});
')"
cli=(gh-delta)
if [ "$launcher" = 'gh delta' ]; then cli=(gh delta); fi
# Atomic reservation supplies both private state and a collision-free live ID.
state_dir=$(mktemp -d /tmp/gh-delta.XXXXXXXXXX) || exit 1
monitor_id=${state_dir##*/}
announced=false
while true; do
  # GH_HOST keeps the resolved Enterprise host stable for gh subprocesses too.
  GH_HOST="$host" "${cli[@]}" \
    --repo "$repo" \
    --monitor-id "$monitor_id" \
    --state-dir "$state_dir" \
    --entities "$scope" \
    --no-registry \
    --format template \
    --template '{entity} #{number}: {context.title} {context.headRefName} [{classes}] {context.url}' &
  child_pid=$!
  rc=0
  wait "$child_pid" || rc=$?
  child_pid=''
  case "$rc" in
    0 | 10)
      if [ "$announced" = false ]; then
        printf 'Monitoring %s (%s) every 120 seconds after each tick; state: %s\n' "$repo" "$scope" "$state_dir" >&2
        announced=true
      fi
      ;;
    1) printf 'gh-delta: tick failed; retrying in 120 seconds.\n' >&2 ;;
    *) exit "$rc" ;;
  esac
  sleep 120 &
  child_pid=$!
  rc=0
  wait "$child_pid" || rc=$?
  child_pid=''
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
done
