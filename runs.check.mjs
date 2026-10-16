// The script runner's pure logic, checked without a browser.
//
//   node runs.check.mjs
//
// What is worth pinning: the merge of the two run logs (local and VPS records live in separate
// files and have to read as one timeline), and the 12-hour clock formatting, whose midnight and
// noon cases are the ones that silently read wrong.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "deck-sr-"));
const out = join(dir, "runs.mjs");
await build({
  entryPoints: [join(import.meta.dirname, "src/runs.ts")],
  outfile: out, format: "esm", bundle: false,
});
const { mergeRuns, lastRunById, fmtTime } = await import(`file://${out}`);
rmSync(dir, { recursive: true, force: true });

// ---- mergeRuns: two files, one timeline ------------------------------------------------------
const rec = (id, finished_at, target = "local") => ({
  id, name: id, target, started_at: finished_at - 1000, finished_at,
  ok: true, exit_code: 0, output: "",
});

const merged = mergeRuns(
  [rec("a", 3000), rec("b", 1000)],
  [rec("c", 2000, "vps"), rec("d", 4000, "vps")],
);
assert.deepEqual(merged.map((r) => r.id), ["d", "a", "c", "b"], "newest first, both sources");
assert.equal(merged.length, 4, "nothing is dropped in the merge");

// Either side being empty is normal — a machine that has never run a VPS job has no vps log.
assert.deepEqual(mergeRuns([rec("a", 1)], []).map((r) => r.id), ["a"]);
assert.deepEqual(mergeRuns([], [rec("v", 1, "vps")]).map((r) => r.id), ["v"]);
assert.deepEqual(mergeRuns([], []), []);

// ---- lastRunById: newest per job -------------------------------------------------------------
const byId = lastRunById(mergeRuns([rec("a", 5000), rec("a", 1000)], []));
assert.equal(byId.a.finished_at, 5000, "the newest record wins, not the last one seen");
// A record with no id belongs to no job and must not create a phantom entry.
assert.deepEqual(Object.keys(lastRunById([rec("", 1)])), []);

// ---- fmtTime: stored 24h, displayed 12h -------------------------------------------------------
assert.equal(fmtTime("18:00"), "6:00 PM");
assert.equal(fmtTime("09:30"), "9:30 AM");
assert.equal(fmtTime("00:15"), "12:15 AM", "midnight is 12 AM, not 0 AM");
assert.equal(fmtTime("12:00"), "12:00 PM", "noon is 12 PM, not 0 PM");
assert.equal(fmtTime("nonsense"), "nonsense", "an unparseable time is shown as-is, not mangled");

console.log("script-runner: all checks passed");
