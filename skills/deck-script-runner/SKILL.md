---
name: deck-script-runner
description: >
  Run a script or command on Hasan's PC on a repeating schedule (every N minutes, or at set times
  on chosen days) through the Script Runner plugin's Deck MCP tools. TRIGGER when asked to run
  something every N minutes, every day at a time, or to manage such a recurring job.
---

# Deck Script Runner

`deck_add_script` / `deck_set_script_enabled` / `deck_remove_script`, from the Script Runner
plugin: the tools exist only while it is installed. File-backed: Deck's Rust scheduler picks the
change up live, but Deck **must be running** when a job is due. `deck_list` shows every job.

```
deck_add_script  name: "Backup", command: "D:\scripts\backup.ps1", intervalMinutes: 120
deck_add_script  name: "Briefing", command: "claude", args: ["-p","/morning-briefing"],
                 atTime: "07:30", days: ["Monday",...,"Friday"]
```

- `intervalMinutes` **or** `atTime`, not both. Interval jobs ignore `days`; timed jobs default
  to Mon–Fri, so pass `days` explicitly for weekend jobs.
- `command` takes a `.ps1` / `.bat` / `.exe` path or an inline command; `args` is a list.
- Disable without deleting via `deck_set_script_enabled`: better than removing a job Hasan may
  want back.
- Times are 24-hour `HH:mm`, local. Days are full English names (`"Monday"`).
- The tools write to the **installed** Deck's config, not a dev build (`Deck-Dev`).
- Long-running scripts fired by the VPS-side scheduler need `systemd-run`; that is a different
  path from these local jobs and is not managed by these tools.
