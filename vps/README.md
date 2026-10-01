# Running Script Runner jobs on a server

A Script Runner job has a **target**: `local` runs it on this PC, `vps` runs it on a server.
This folder is what makes the second one work.

It is not a service. There is no port, no container, no token and nothing to expose — a systemd
timer wakes once a minute, reads the job list out of the synced vault, and fires whatever is
due. Nothing calls in.

```
Deck writes  →  script-runner.json  →  (Syncthing)  →  server reads it every minute
                                                        ↓
                                        run-log-vps.json  ←  job runs
                                                        ↓
                                                  (Syncthing)
                                                        ↓
                                     Script Runner merges it into its log
```

**Why bother:** a `vps` job runs whether or not your desktop is awake. That is the only thing it
buys, and it is the whole reason the target exists.

## Files

| | |
|---|---|
| `deck-vps-scheduler.sh` | The tick. Reads the job list, decides what is due, launches it. |
| `run-one-job.sh` | Runs one job, captures its output, appends the run record. |
| `deck-scheduler.timer` | `OnCalendar=*:0/1` — the every-minute wake. |
| `deck-scheduler.service` | Oneshot, calls the scheduler. |
| `install.sh` | Puts all four in place and enables the timer. Idempotent. |

Each job is launched with `systemd-run --user --collect` in its own transient unit, so it lives
in a separate cgroup and survives the oneshot scheduler exiting. A long job does not block the
next tick, and the tick does not kill it on the way out.

## Install

Needs `jq`, systemd, and the vault syncing to this machine.

```sh
ssh vps 'mkdir -p ~/deck-scheduler'
scp deck-vps-scheduler.sh run-one-job.sh deck-scheduler.timer deck-scheduler.service \
    install.sh vps:~/deck-scheduler/
ssh vps 'sh ~/deck-scheduler/install.sh --check'   # prints what it would do
ssh vps 'sh ~/deck-scheduler/install.sh'
```

## Paths

Hardcoded in the scripts, so `install.sh` matches them rather than choosing:

```
~/vault/dev/deck-vault/data/scripts/script-runner.json   the job list (synced, read-only here)
~/vault/dev/deck-vault/data/scripts/run-log-vps.json     run records (synced back)
/opt/deck-brain-config/deck-vps-scheduler.sh             the scheduler
/opt/deck-brain-config/run-one-job.sh                    the runner
/opt/deck-brain-config/vps-scheduler-state.json          last-run per job — NOT synced
/opt/deck-brain-config/vps-scheduler.log                 what fired and when
~/.config/systemd/user/deck-scheduler.{timer,service}    the tick
```

The state file stays off the vault deliberately: it is this machine's record of what it has
already fired, and syncing it back would have the desktop and the server overwriting each
other's idea of when a job last ran.

## Checking on it

```sh
ssh vps 'systemctl --user list-timers deck-scheduler.timer --no-pager'
ssh vps 'tail -20 /opt/deck-brain-config/vps-scheduler.log'
```

The log records `FIRE <id>` and `DONE <id> rc=<code>` per run. A job that fires and fails is a
job whose own command failed — the run record in `run-log-vps.json` carries its output, and the
desktop's Script Runner shows it beside the local runs.

## Not related to the VPS plugin

These scripts used to live in `plugins/vps/server/host/`, which was misleading. The VPS plugin
is a dashboard — host stats and container buttons — and it has no part in running jobs. Its
backend never had a route that could start one. The two share a server and nothing else, and
uninstalling the VPS plugin does not stop a single scheduled job.
