# Script Runner

Runs scripts on a schedule, on this machine or on your VPS, and keeps what each run printed.

Rust's scheduler does the firing; this owns the job list, the run log and the interface. The run
log is merged rather than replaced, so a run that is still going does not lose the output of the
one before it.

## The VPS half

`vps/` holds a systemd timer and an install script for running the same jobs on a server. There
is no service - a timer and a script are enough - and the plugin shows the deploy steps rather
than running them, because deploying writes to someone's machine.

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the tab: jobs and their run history |
| `Settings` | defaults and the VPS target |
| `mcp` | adding, removing and enabling scripts, for an agent |

## Checks

```sh
node plugins/script-runner/runs.check.mjs
```

## Build

```sh
node plugins/script-runner/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js`, `mcp.js` into `%APPDATA%\Deck\plugins\script-runner\` (`Deck-Dev` for a
debug build) and restart Deck.
