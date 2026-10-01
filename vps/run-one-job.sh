#!/bin/bash
# run-one-job.sh — run ONE Deck vps job, capture exit+output, append a run record.
# Launched by the scheduler via `systemd-run --user` so it lives in its OWN cgroup and
# survives the scheduler exiting (the whole reason briefings were being killed mid-run).
# Args: <id> <name> <command>
export PATH="/usr/local/sbin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Beirut"
id="$1"; name="$2"; command="$3"
LOG=/opt/deck-brain-config/vps-scheduler.log
# Grouped by the desktop into data/scripts/ — see vault_group in src-tauri/src/config.rs.
RUNLOG="$HOME/vault/dev/deck-vault/data/scripts/run-log-vps.json"
mkdir -p "$(dirname "$RUNLOG")"
[ -f "$RUNLOG" ] || echo "[]" > "$RUNLOG"

started=$(($(date +%s) * 1000))
out=$(bash -lc "$command" 2>&1 < /dev/null); rc=$?
finished=$(($(date +%s) * 1000))
tail_out=$(printf "%s" "$out" | tail -c 4000)
rec=$(jq -n --arg id "$id" --arg name "$name" --arg out "$tail_out" \
  --argjson s "$started" --argjson f "$finished" --argjson rc "$rc" \
  '{id:$id,name:$name,target:"vps",started_at:$s,finished_at:$f,ok:($rc==0),exit_code:$rc,output:$out}')
lock="$RUNLOG.lock"; exec 9>"$lock"; flock 9
t=$(mktemp); jq --argjson r "$rec" '[$r] + . | .[0:200]' "$RUNLOG" > "$t" 2>/dev/null && mv "$t" "$RUNLOG"
echo "$(date -u +%FT%TZ) DONE $id rc=$rc" >> "$LOG"

# A completion push used to go out here, to the backend's /notify route. That route and the
# phone app it fed are gone; the run is recorded in run-log-vps.json above, which the desktop's
# Script Runner merges into its own log.
