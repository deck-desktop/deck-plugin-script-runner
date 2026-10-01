#!/bin/sh
# Install Deck's server-side script scheduler. Idempotent: re-running it repairs an install
# rather than starting over, and it never touches the job list or the run log.
#
# This is what makes a Script Runner job with target "vps" actually run. There is no service and
# no port: a systemd timer wakes every minute, reads the job list out of the synced vault, and
# fires whatever is due. Nothing calls in, so nothing has to be exposed.
#
# Run it ON THE SERVER, after copying this directory there:
#
#   ssh vps 'mkdir -p ~/deck-scheduler'
#   scp deck-vps-scheduler.sh run-one-job.sh deck-scheduler.timer deck-scheduler.service \
#       install.sh vps:~/deck-scheduler/
#   ssh vps 'sh ~/deck-scheduler/install.sh --check'   # prints what it would do
#   ssh vps 'sh ~/deck-scheduler/install.sh'
set -e

CHECK=""
for a in "$@"; do
    case "$a" in
        --check) CHECK=1 ;;
        *) echo "usage: sh install.sh [--check]" >&2; exit 2 ;;
    esac
done

SRC=$(cd "$(dirname "$0")" && pwd)
# Hardcoded in both scripts, so this is not a choice — changing it means changing them too.
BRAIN="/opt/deck-brain-config"
UNITS="$HOME/.config/systemd/user"
JOBS="$HOME/vault/dev/deck-vault/data/scripts/script-runner.json"

say()  { printf '%s\n' "  $*"; }
step() { printf '\n== %s\n' "$*"; }
run()  { if [ -n "$CHECK" ]; then say "would: $*"; else eval "$*"; fi; }

step "Prerequisites"
MISSING=""
command -v jq >/dev/null 2>&1 || MISSING="$MISSING jq"
command -v systemctl >/dev/null 2>&1 || MISSING="$MISSING systemd"
if [ -n "$MISSING" ]; then
    say "missing:$MISSING"
    say "jq is what decides which jobs are due; install it first."
    exit 1
fi
# The job list arrives by whatever syncs the vault — Syncthing in Deck's own setup. Its absence
# is not fatal (the scheduler exits quietly until it appears) but it is almost always the reason
# nothing runs, so it is worth saying now rather than after a week of silence.
if [ -f "$JOBS" ]; then
    say "job list: $JOBS"
else
    say "NOTE: no job list at $JOBS yet."
    say "      It arrives when the vault syncs here. Until then the timer runs and does nothing."
fi
# User units die at logout without lingering, which is the failure where a job is due and
# silently never runs.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    say "user lingering is off — scheduled jobs would die at logout."
    run "sudo loginctl enable-linger '$USER'"
fi
say "ok"

step "Scripts ($BRAIN)"
run "sudo mkdir -p '$BRAIN'"
run "sudo chown '$USER' '$BRAIN'"
run "cp '$SRC/deck-vps-scheduler.sh' '$SRC/run-one-job.sh' '$BRAIN/'"
run "chmod +x '$BRAIN/deck-vps-scheduler.sh' '$BRAIN/run-one-job.sh'"
say "ok"

step "Timer ($UNITS)"
run "mkdir -p '$UNITS'"
run "cp '$SRC/deck-scheduler.timer' '$SRC/deck-scheduler.service' '$UNITS/'"
run "systemctl --user daemon-reload"
run "systemctl --user enable --now deck-scheduler.timer"
say "ok"

if [ -n "$CHECK" ]; then
    printf '\n--check: nothing was changed.\n'
    exit 0
fi

step "Status"
systemctl --user list-timers deck-scheduler.timer --no-pager || true

cat <<EOF

────────────────────────────────────────────────────────────
 The scheduler is running. It wakes every minute.

 In Deck, a Script Runner job with target "vps" now runs HERE
 rather than on the desktop — which means it runs whether or
 not the desktop is awake. That is the whole point of it.

 Results are written to run-log-vps.json in the vault, and the
 desktop's Script Runner merges them into its own log.

 Log:    $BRAIN/vps-scheduler.log
 State:  $BRAIN/vps-scheduler-state.json
────────────────────────────────────────────────────────────
EOF
