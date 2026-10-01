#!/bin/bash
# deck-vps-scheduler.sh — the VPS-side half of Deck's Script Runner.
# Reads the job list Deck mirrors into the synced vault, and fires the jobs whose
# target is "vps" when their schedule is due. Runs once per invocation (a systemd
# timer calls it every minute). Keeps its own last-run state so it never depends on
# the desktop being awake — this is the whole point of running jobs on the VPS.
#
# Job source (synced from Deck via Syncthing):
#   ~/vault/dev/deck-vault/data/scripts/script-runner.json
# State (VPS-only, not synced back to avoid fighting Deck's copy):
#   /opt/deck-brain-config/vps-scheduler-state.json   {"<id>": <lastRun epoch ms>}
# Log:
#   /opt/deck-brain-config/vps-scheduler.log

set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/bin:/bin"

# Grouped by feature, matching the desktop — see vault_group in src-tauri/src/config.rs.
JOBS="$HOME/vault/dev/deck-vault/data/scripts/script-runner.json"
STATE="/opt/deck-brain-config/vps-scheduler-state.json"
LOG="/opt/deck-brain-config/vps-scheduler.log"
TZ_LOCAL="Asia/Beirut"   # schedules are authored in Hasan's local time

[ -f "$JOBS" ] || exit 0
[ -f "$STATE" ] || echo '{}' > "$STATE"

# All time math in Beirut local time, matching how the schedules were set in Deck.
export TZ="$TZ_LOCAL"
now_ms=$(($(date +%s) * 1000))


today=$(date +%A)          # Monday, Tuesday, …
cur_hm=$(date +%H:%M)      # 08:30
today_epoch_days=$(( $(date +%s) / 86400 ))  # whole days since epoch, Beirut-local midnight-ish

# jq drives the decision: emit "id<TAB>command<TAB>args-json" for each vps job that is due.
# everyWeeks/startDate cadence mirrors Deck's week_matches(): weeks since the anchor, modulo
# everyWeeks == 0, and never before the anchor. everyWeeks<=1 or no startDate => every week.
due=$(JOBS_NOW_MS="$now_ms" TODAY="$today" CUR_HM="$cur_hm" TODAY_DAYS="$today_epoch_days" \
  jq -r --slurpfile st "$STATE" '
    ($st[0] // {}) as $state
    | ($ENV.JOBS_NOW_MS|tonumber) as $now
    | ($ENV.TODAY_DAYS|tonumber) as $todayDays
    | $ENV.TODAY as $today
    | $ENV.CUR_HM as $cur
    | .jobs[]
    | select(.enabled == true and (.target // "local") == "vps" and ((.command // "")|length) > 0)
    | . as $j
    | ($state[$j.id] // 0) as $last
    | (($j.everyWeeks // 1)) as $ew
    | (($j.startDate // "")) as $sd
    | (
        if ($ew <= 1) or ($sd == "") then true
        else
          (($sd + "T00:00:00Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime / 86400 | floor) as $anchorDays
          | ($todayDays - $anchorDays) as $d
          | if $d < 0 then false else (($d / 7 | floor) % $ew) == 0 end
        end
      ) as $weekok
    | (
        if $j.mode == "interval" then
          ($j.intervalMin // 0) > 0 and ($last == 0 or ($now - $last) >= (($j.intervalMin)*60000))
        elif $j.mode == "atTime" then
          ((($j.days // []) | index($today)) != null)
          and (($j.timeOfDay // "") == $cur)
          and (($now - $last) > 60000)
          and $weekok
        else false end
      ) as $isdue
    | select($isdue)
    | [$j.id, ($j.command), ((.args // []) | @json)] | @tsv
  ' "$JOBS" 2>/dev/null || true)

[ -z "$due" ] && exit 0

# Fire each due job in its own detached subshell that captures exit + output and
# writes a run record Deck can read (synced via data/run-log-vps.json).
# Grouped by the desktop into data/scripts/ (src-tauri/src/config.rs). Only created here — the
# appending is run-one-job.sh's, which is what keeps the flat copy current too.
RUNLOG="$HOME/vault/dev/deck-vault/data/scripts/run-log-vps.json"
mkdir -p "$(dirname "$RUNLOG")"
[ -f "$RUNLOG" ] || echo "[]" > "$RUNLOG"
while IFS=$'\t' read -r id command argsjson; do
  [ -z "$id" ] && continue
  # look up the job name for a friendlier label
  name=$(jq -r --arg id "$id" '.jobs[]|select(.id==$id)|.name // ""' "$JOBS" 2>/dev/null | head -1)
  echo "$(date -u +%FT%TZ) FIRE $id :: $command" >> "$LOG"
  # update scheduled-state immediately (so a slow job does not re-fire next tick)
  tmp=$(mktemp); jq --arg id "$id" --argjson now "$now_ms" '.[$id] = $now' "$STATE" > "$tmp" && mv "$tmp" "$STATE"
  # Launch the job as its OWN transient user unit so it lives in a separate cgroup and
  # is NOT killed when this (oneshot) scheduler exits. --collect auto-clears the unit after.
  systemd-run --user --collect --quiet --unit="deckjob-${id}-$(date +%s)"     /opt/deck-brain-config/run-one-job.sh "$id" "$name" "$command"     >> "$LOG" 2>&1 || echo "$(date -u +%FT%TZ) SPAWN-FAIL $id" >> "$LOG"
done <<< "$due"

# trim log
tail -n 3000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" || true
