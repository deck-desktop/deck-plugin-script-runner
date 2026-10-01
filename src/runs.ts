// Run records, and the shapes the job list is stored in.
//
// Pure logic, kept away from the UI and the bridge so it can be checked without a browser:
// the merge of the two run logs and the "is this job due" reading are the parts worth
// getting right. See runs.check.mjs.

/** One scheduled job. The field names are the stored ones — see the note in plugin.tsx. */
export interface ScriptJob {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** "interval" fires every `intervalMin`; "atTime" fires at `timeOfDay` on `days`. */
  mode: "interval" | "atTime";
  intervalMin: number;
  timeOfDay: string;
  days: string[];
  /** Where the job runs: this PC, or the VPS (whose own scheduler fires it). */
  target: "local" | "vps";
  /** Epoch ms of the last fire. Written by Rust's scheduler — never invent one here. */
  lastRun: number;
  /** Fire only every Nth week, counted from `startDate`. 0/1 means every week. */
  everyWeeks: number;
  startDate: string;
}

/**
 * One finished run, as the scheduler appends it.
 *
 * Snake_case, unlike `ScriptJob` above — these two shapes genuinely differ on the wire, because
 * `RunRecord` is serialized without serde's camelCase rename. The names here are the stored ones
 * and must not be "tidied": the VPS writes this same shape from bash.
 */
export interface RunRecord {
  id: string;
  name: string;
  target: "local" | "vps";
  started_at: number;
  finished_at: number;
  ok: boolean;
  exit_code: number;
  /** Tail of the combined stdout+stderr, truncated by the runner. */
  output: string;
}

/**
 * Merge the local and VPS run logs into one newest-first list.
 *
 * Two separate files rather than one because the VPS cannot write this machine's log: its
 * records arrive over Syncthing as `run-log-vps`. Merging on read is what makes the history
 * look like a single timeline.
 */
export function mergeRuns(local: RunRecord[], vps: RunRecord[]): RunRecord[] {
  return [...local, ...vps].sort((a, b) => b.finished_at - a.finished_at);
}

/** The newest run per job id, for the "last run" column. */
export function lastRunById(runs: RunRecord[]): Record<string, RunRecord> {
  const m: Record<string, RunRecord> = {};
  // `runs` is newest-first, so the first record seen for an id is the newest one.
  for (const r of runs) if (r.id && !m[r.id]) m[r.id] = r;
  return m;
}

/** Format an "HH:mm" (24h storage) string for display. Deck shows 12h everywhere. */
export function fmtTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const ap = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12}:${m[2]} ${ap}`;
}

