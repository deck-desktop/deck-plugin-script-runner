// The agent-facing tools for this plugin's data.
//
// These moved out of the MCP server (`mcp/src/scripts.ts`) for the same reason the tab moved out
// of Deck: this plugin owns the shape of `script-runner.json`, so the tools that write it belong
// beside the code that reads it. One place to change when the format changes.
//
// The one rule, and it is the same one the tab follows: a job read from the file is written back
// WHOLE. Rust's scheduler stamps `lastRun` on a job when it fires, so dropping that field on
// save would make the job fire again on the next tick.
//
// Nothing is imported at run time. The MCP server passes its own zod and store helpers in — see
// mcp/src/plugin-api.ts for why. The type import below is erased at build time.
import type { DeckMcp, McpServer, ScriptFile, ScriptJob, Weekday } from "../shim/mcp.js";

export function register(server: McpServer, deck: DeckMcp) {
  const { z, ok, weekday, readJson, writeJson, newId, ALL_DAYS } = deck;

  server.tool(
    "deck_add_script",
    "Schedule a script or command to run on a repeating schedule — either every N " +
      "minutes (interval) or at a time on chosen days (atTime). Command can be a path " +
      "to a .ps1/.bat/.exe or an inline command.",
    {
      name: z.string(),
      command: z.string().describe("path to .ps1/.bat/.exe, or an inline command"),
      args: z.array(z.string()).default([]),
      intervalMinutes: z.number().int().positive().optional(),
      atTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
      days: z.array(weekday).default(ALL_DAYS.slice(0, 5) as Weekday[]),
      enabled: z.boolean().default(true),
    },
    async ({ name, command, args, intervalMinutes, atTime, days, enabled }) => {
      const f = readJson<ScriptFile>("script-runner", { jobs: [] });
      let job: ScriptJob;
      if (intervalMinutes != null) {
        job = { id: newId(), name, command, args, mode: "interval", intervalMin: intervalMinutes, days: [], timeOfDay: "09:00", enabled, lastRun: 0 };
      } else if (atTime) {
        job = { id: newId(), name, command, args, mode: "atTime", intervalMin: 0, days: days as string[], timeOfDay: atTime, enabled, lastRun: 0 };
      } else {
        return ok("Error: provide intervalMinutes or atTime.");
      }
      f.jobs.push(job);
      writeJson("script-runner", f);
      return ok(`Added script '${name}' (id ${job.id}).`);
    },
  );

  server.tool(
    "deck_set_script_enabled",
    "Enable or disable a scheduled script by name.",
    { name: z.string(), enabled: z.boolean() },
    async ({ name, enabled }) => {
      const f = readJson<ScriptFile>("script-runner", { jobs: [] });
      const j = f.jobs.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!j) return ok(`No script named '${name}'.`);
      j.enabled = enabled;
      writeJson("script-runner", f);
      return ok(`${enabled ? "Enabled" : "Disabled"} '${name}'.`);
    },
  );

  server.tool(
    "deck_remove_script",
    "Remove a scheduled script by name.",
    { name: z.string() },
    async ({ name }) => {
      const f = readJson<ScriptFile>("script-runner", { jobs: [] });
      const next = f.jobs.filter((j) => j.name.toLowerCase() !== name.toLowerCase());
      const changed = next.length !== f.jobs.length;
      writeJson("script-runner", { jobs: next });
      return ok(changed ? `Removed '${name}'.` : `No script named '${name}'.`);
    },
  );
}
