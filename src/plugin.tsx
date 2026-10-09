// Script Runner — run scripts or commands on a schedule.
//
// Ported from Deck's built-in module of the same name. The UI is unchanged; what moved is
// ownership: this tab now lives outside Deck and talks to it only through the plugin bridge.
//
// What did NOT move, deliberately: the firing itself. Scheduled jobs are fired by Rust's
// scheduler thread, exactly as App Closer and Power Timer are. Deck's own
// `src/core/scheduler.ts` opens with the direction — "window-open = timers run (in-memory). A
// later version can move firing to the Rust side to survive window close" — and that later
// version is what ships today; moving this one back into the webview would undo it.
//
// The harder reason is that Rust is the single WRITER of two fields no one else may invent:
// `lastRun` on a job, and the appended `run-log` record. A second writer in this module would
// be a read-modify-write racing the scheduler's own.
//
// So this plugin owns the job LIST and the presentation; Rust owns the clock. The one rule that
// falls out of that split: a job object read from the file must be written back whole. Rust
// stamps `lastRun` on it when it fires, and dropping that field on save would make the job fire
// again on the next tick.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown, Plus, Trash2, FolderOpen, Play, Check, CheckCircle2, XCircle, Clock, X,
} from "lucide-react";
import { listen } from "../shim/event.js";
import { configRead, configWrite, pickScript, runScriptNow } from "../shim/bridge.js";
import { TextInput, TimeInput, DayPicker, Segmented } from "../shim/ui.js";
import { mergeRuns, lastRunById as newestPerJob, fmtTime, type ScriptJob, type RunRecord } from "./runs";

const relTime = (ms: number): string => {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};

const newId = () => `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const todayISO = () => new Date().toISOString().slice(0, 10);

const EMPTY: ScriptJob = {
  id: "", name: "", command: "", args: [],
  mode: "interval", intervalMin: 30,
  days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], timeOfDay: "09:00",
  everyWeeks: 1, startDate: "",
  enabled: true, lastRun: 0, target: "local",
};

function summary(j: ScriptJob): string {
  if (j.mode === "interval") return `Every ${j.intervalMin} min`;
  const days = j.days.length === 7 ? "Every day"
    : (j.days.length === 5 && ["Monday","Tuesday","Wednesday","Thursday","Friday"].every((d) => j.days.includes(d))) ? "Mon–Fri"
    : j.days.map((d) => d.slice(0, 2)).join(", ");
  const every = (j.everyWeeks ?? 1) > 1 ? `every ${j.everyWeeks} wks · ` : "";
  return `${every}${days} · ${fmtTime(j.timeOfDay)}`;
}

/**
 * Read both run logs and merge them.
 *
 * Rust used to do this behind a `read_run_log` command; it is two config reads and a sort, so it
 * is done here rather than keeping a command alive for it. Read-only, so unlike the job list
 * there is nothing to race with the scheduler's writes.
 */
async function loadRunLog(): Promise<RunRecord[]> {
  const parse = async (name: string): Promise<RunRecord[]> => {
    try {
      const t = await configRead(name);
      const v = t.trim() ? JSON.parse(t) : [];
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  };
  const [local, vps] = await Promise.all([parse("run-log"), parse("run-log-vps")]);
  return mergeRuns(local, vps);
}

export default function ScriptRunner() {
  const [list, setList] = useState<ScriptJob[]>([]);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const lastSynced = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sheet, setSheet] = useState<RunRecord | null>(null); // open side sheet for one run

  // Latest run record per job id (runs are already newest-first from the merge).
  const lastRunById = useMemo(() => newestPerJob(runs), [runs]);
  const loadRuns = () => { void loadRunLog().then(setRuns); };

  const load = () =>
    configRead("script-runner").then((t) => {
      try { const f = t ? JSON.parse(t) : { jobs: [] }; const arr = Array.isArray(f.jobs) ? f.jobs : [];
        lastSynced.current = JSON.stringify(arr); setList(arr); } catch { /* keep */ }
    }).catch(() => {});

  useEffect(() => {
    load();
    loadRuns();
    let un: (() => void) | undefined;
    // The scheduler stamping `lastRun` on a job it fired rewrites script-runner, so reloading here
    // is what keeps this list from saving a stale copy back over it.
    listen<string[]>("config-changed", (e) => {
      if (e.payload.includes("script-runner")) load();
      if (e.payload.includes("run-log") || e.payload.includes("run-log-vps")) loadRuns();
    }).then((u) => (un = u));
    // VPS run records arrive via Syncthing (no local FS event) — poll so they surface.
    const iv = setInterval(loadRuns, 15_000);
    return () => { un?.(); clearInterval(iv); };
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    const cur = JSON.stringify(list);
    if (lastSynced.current === null || cur === lastSynced.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      lastSynced.current = cur;
      void configWrite("script-runner", JSON.stringify({ jobs: list }, null, 2));
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1400);
    }, 500);
  }, [list]);

  const update = (i: number, patch: Partial<ScriptJob>) =>
    setList((l) => l.map((j, idx) => (idx === i ? { ...j, ...patch } : j)));
  const remove = (i: number) => { setList((l) => l.filter((_, idx) => idx !== i)); setOpenIdx(null); };
  const add = () => { setList((l) => [...l, { ...EMPTY, id: newId() }]); setOpenIdx(list.length); };
  // `pickScript` rather than the bridge's generic `pickFile`: that one takes a single
  // extension, and this dialog offers .ps1/.bat/.cmd/.exe together plus an "All files" fallback.
  const browse = async (i: number) => { const p = await pickScript(); if (p) update(i, { command: p }); };

  const enabledCount = list.filter((j) => j.enabled).length;

  return (
    <div className="relative mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden">
      <div className="mb-5 flex shrink-0 items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Script Runner</h1>
          <p className="mt-1 text-sm text-text-muted">
            {list.length === 0 ? "Run scripts or commands on a schedule."
              : `${enabledCount} of ${list.length} enabled`}
          </p>
        </div>
        <AnimatePresence>
          {savedFlash && (
            <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-center gap-1 text-xs" style={{ color: "var(--accent)" }}>
              <Check size={13} /> Saved
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
       <div className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle" style={{ background: "var(--bg-card-glass)" }}>
        {list.map((j, i) => {
          const open = openIdx === i;
          return (
            <motion.div key={j.id} layout className="overflow-hidden transition-colors"
              style={{ background: open ? "color-mix(in srgb, var(--accent) 5%, var(--bg-card))" : "transparent" }}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button onClick={() => setOpenIdx(open ? null : i)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: j.enabled ? "var(--accent)" : "var(--border-strong)" }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-text-primary">{j.name || "(unnamed)"}</span>
                      {j.target === "vps" && (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>VPS</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-text-muted">{summary(j)} · {j.command || "no command"}</div>
                  </div>
                </button>
                <StatusIcon rec={lastRunById[j.id]} onClick={() => lastRunById[j.id] && setSheet(lastRunById[j.id])} />
                {j.target !== "vps" && (
                  <button onClick={() => { void runScriptNow(j.command, j.args, j.id, j.name); setTimeout(loadRuns, 1500); }} title="Run now"
                    className="rounded-md p-1.5 text-text-muted transition hover:bg-elev hover:text-accent">
                    <Play size={15} />
                  </button>
                )}
                <span role="switch" aria-checked={j.enabled} onClick={() => update(i, { enabled: !j.enabled })}
                  className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
                  style={{ background: j.enabled ? "var(--accent)" : "var(--border-strong)" }}>
                  <motion.span layout className="absolute top-0.5 h-4 w-4 rounded-full bg-white" style={{ left: j.enabled ? "18px" : "2px" }} />
                </span>
                <button onClick={() => setOpenIdx(open ? null : i)}>
                  <ChevronDown size={16} className="text-text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
                </button>
              </div>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
                    <div className="border-t border-subtle py-4 pl-[38px] pr-4">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-medium text-text-secondary">Name</span>
                          <TextInput value={j.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Display name" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-medium text-text-secondary">Arguments <span className="text-text-muted">· optional</span></span>
                          <input value={j.args.join(" ")}
                            onChange={(e) => update(i, { args: e.target.value.split(" ").filter(Boolean) })}
                            placeholder="Space-separated"
                            className="h-9 w-full rounded-md border border-strong bg-elev px-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition focus:border-accent" />
                        </label>

                        <div className="col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-text-secondary">Runs on</span>
                          <div className="flex items-center gap-3">
                            <Segmented layoutId={`seg-target-${j.id}`}
                              value={j.target ?? "local"} onChange={(t) => update(i, { target: t as "local" | "vps" })}
                              options={[{ value: "local", label: "This PC" }, { value: "vps", label: "VPS" }]} />
                            <span className="text-[11px] text-text-muted">
                              {j.target === "vps" ? "The always-on VPS, even when this PC is off." : "This PC, while Deck is open."}
                            </span>
                          </div>
                          {/* Said here rather than only in the settings panel, because this is
                              the moment someone learns the server half exists: they pick VPS,
                              and nothing runs until a timer is installed there. The steps
                              themselves are in the panel — this points at it. */}
                          {j.target === "vps" && (
                            <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
                              Needs a scheduler installed on that server — it reads this job list
                              out of the synced vault once a minute.{" "}
                              {/* "settings:<tab>" is App's own way for a control to point at the
                                  settings that govern it, so this lands on the Plugins tab
                                  rather than the top of Settings. */}
                              <button
                                onClick={() => window.dispatchEvent(
                                  new CustomEvent("deck-navigate", { detail: "settings:plugins" }))}
                                className="underline decoration-dotted underline-offset-2 transition-colors hover:text-text-primary">
                                Show me the steps
                              </button>
                            </p>
                          )}
                        </div>

                        <label className="col-span-2 block">
                          <span className="mb-1 block text-[11px] font-medium text-text-secondary">Command</span>
                          <div className="flex gap-2">
                            <TextInput value={j.command} onChange={(e) => update(i, { command: e.target.value })}
                              placeholder={j.target === "vps" ? "VPS command or script path (runs in bash)" : "Path to .ps1/.bat/.exe or an inline command"} />
                            {j.target !== "vps" && (
                              <button onClick={() => browse(i)} title="Browse for a script"
                                className="grid h-9 w-10 shrink-0 place-items-center rounded-md border border-strong bg-elev text-text-secondary transition hover:text-text-primary">
                                <FolderOpen size={16} />
                              </button>
                            )}
                          </div>
                        </label>

                        <div className="col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-text-secondary">Schedule</span>
                          <div className="flex items-center gap-3">
                            <Segmented layoutId={`seg-mode-${j.id}`}
                              value={j.mode} onChange={(m) => update(i, { mode: m as ScriptJob["mode"] })}
                              options={[{ value: "interval", label: "Every N min" }, { value: "atTime", label: "At time" }]} />
                            {j.mode === "interval" ? (
                              <div className="relative w-32">
                                <input value={String(j.intervalMin)} inputMode="numeric"
                                  onChange={(e) => update(i, { intervalMin: Number(e.target.value) || 0 })}
                                  className="h-9 w-full rounded-md border border-strong bg-elev pl-3 pr-12 text-sm text-text-primary outline-none transition focus:border-accent" />
                                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted">min</span>
                              </div>
                            ) : (
                              <TimeInput value={j.timeOfDay} onChange={(v) => update(i, { timeOfDay: v })} className="w-32" />
                            )}
                          </div>
                        </div>

                        {j.mode === "atTime" && (
                          <>
                            <div className="col-span-2">
                              <span className="mb-1.5 block text-[11px] font-medium text-text-secondary">On days</span>
                              <DayPicker value={j.days} onChange={(d) => update(i, { days: d })} />
                            </div>
                            <label className="block">
                              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Repeat every</span>
                              <div className="relative">
                                <input
                                  value={String(j.everyWeeks ?? 1)} inputMode="numeric"
                                  onChange={(e) => {
                                    const n = Math.max(1, Number(e.target.value) || 1);
                                    update(i, { everyWeeks: n, startDate: n > 1 && !j.startDate ? todayISO() : j.startDate });
                                  }}
                                  className="h-9 w-full rounded-md border border-strong bg-elev pl-3 pr-14 text-sm text-text-primary outline-none transition focus:border-accent" />
                                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted">week{(j.everyWeeks ?? 1) > 1 ? "s" : ""}</span>
                              </div>
                            </label>
                            {(j.everyWeeks ?? 1) > 1 && (
                              <label className="block">
                                <span className="mb-1 block text-[11px] font-medium text-text-secondary">Starting</span>
                                <input type="date" value={j.startDate || todayISO()}
                                  onChange={(e) => update(i, { startDate: e.target.value })}
                                  className="time-input h-9 w-full rounded-md border border-strong bg-elev px-3 text-sm text-text-primary outline-none transition focus:border-accent" />
                              </label>
                            )}
                          </>
                        )}
                      </div>

                      <div className="mt-4 flex justify-end">
                        <button onClick={() => remove(i)}
                          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-text-muted transition hover:bg-elev hover:text-danger">
                          <Trash2 size={14} /> Remove script
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
       </div>

        <button onClick={add}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-subtle py-2.5 text-sm text-text-muted transition hover:border-accent hover:text-text-primary">
          <Plus size={16} /> New script
        </button>
      </div>

      <RunSheet rec={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

// Row status: last-run outcome as a small icon. No record yet → muted dot.
function StatusIcon({ rec, onClick }: { rec?: RunRecord; onClick: () => void }) {
  if (!rec) return <span className="w-6" title="Never run" />;
  const { color, Icon, label } = rec.ok
    ? { color: "var(--accent)", Icon: CheckCircle2, label: "Succeeded" }
    : { color: "var(--danger)", Icon: XCircle, label: "Failed" };
  return (
    <button onClick={onClick} title={`${label} · ${relTime(rec.finished_at)} — click for details`}
      className="flex items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-elev">
      <Icon size={15} style={{ color }} />
    </button>
  );
}

// Side sheet: one run's full detail (status, timing, captured output).
function RunSheet({ rec, onClose }: { rec: RunRecord | null; onClose: () => void }) {
  const fmtAbs = (ms: number) => {
    if (!ms) return "—";
    const d = new Date(ms);
    return `${d.toLocaleDateString()} ${fmtTime(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`)}`;
  };
  return (
    <AnimatePresence>
      {rec && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose} className="absolute inset-0 z-40 bg-black/40" />
          <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 400, damping: 38 }}
            className="absolute right-0 top-0 z-50 flex h-full w-[440px] max-w-[85%] flex-col border-l border-subtle bg-panel">
            <div className="flex items-center justify-between border-b border-subtle px-5 py-4">
              <div className="flex items-center gap-2">
                {rec.ok ? <CheckCircle2 size={18} style={{ color: "var(--accent)" }} />
                        : <XCircle size={18} style={{ color: "var(--danger)" }} />}
                <span className="font-semibold text-text-primary">{rec.name || "(unnamed)"}</span>
                {rec.target === "vps" && (
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>VPS</span>
                )}
              </div>
              <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-elev hover:text-text-primary"><X size={18} /></button>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm">
              <Detail label="Result" value={rec.ok ? "Succeeded" : `Failed (exit ${rec.exit_code})`}
                color={rec.ok ? "var(--accent)" : "var(--danger)"} />
              <Detail label="Ran" value={`${fmtAbs(rec.finished_at)} · ${relTime(rec.finished_at)}`} />
              <Detail label="Duration" value={rec.finished_at && rec.started_at
                ? `${((rec.finished_at - rec.started_at) / 1000).toFixed(1)}s` : "—"} />
            </div>
            <div className="flex items-center gap-1.5 px-5 pb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <Clock size={12} /> Output
            </div>
            <pre className="scroll-thin mx-5 mb-5 min-h-0 flex-1 overflow-auto rounded-lg border border-subtle bg-app p-3 text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
              {rec.output?.trim() || "(no output captured)"}
            </pre>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Detail({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-right font-medium" style={{ color: color ?? "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

/**
 * The settings panel, rendered inside this plugin's own row in Settings > Plugins.
 *
 * Nothing to configure — jobs are edited in the tab. What lives here is the one part of Script
 * Runner that is not in Deck at all: a job with target "vps" runs on a server, and that server
 * needs a scheduler installed on it before anything fires. There is no setting for that, only
 * an install, so this is where the steps go.
 */
export function Settings() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-subtle p-3 text-[12px] leading-relaxed text-text-secondary"
        style={{ background: "var(--bg-elev)" }}>
        <div className="mb-1.5 font-semibold text-text-primary">Running jobs on a server</div>
        <p className="mb-2 text-text-muted">
          A job set to <b className="font-medium text-text-secondary">VPS</b> runs on a server
          instead of this PC, so it fires whether or not Deck is open. That needs a scheduler
          installed there once. It is not a service — no port, no container, no token — just a
          systemd timer that reads this job list out of the synced vault every minute.
        </p>
        <pre className="scroll-thin overflow-x-auto rounded p-2 text-[11px] text-text-secondary"
          style={{ background: "var(--bg-card)", fontFamily: "var(--font-mono)" }}>
{`cd <your Deck checkout>/plugins/script-runner/vps
ssh vps 'mkdir -p ~/deck-scheduler'
scp deck-vps-scheduler.sh run-one-job.sh deck-scheduler.timer \
  deck-scheduler.service install.sh vps:~/deck-scheduler/
ssh vps 'sh ~/deck-scheduler/install.sh --check'
ssh vps 'sh ~/deck-scheduler/install.sh'`}
        </pre>
        <p className="mt-2 text-text-muted">
          The line ending in <span className="font-mono">--check</span> is a dry run — it prints
          what it would do and changes nothing, so read that before the last one. Needs{" "}
          <span className="font-mono">jq</span>, systemd, and the vault syncing to that machine.
        </p>
        <p className="mt-2 text-text-muted">
          Results come back the same way they go out: the server appends to{" "}
          <span className="font-mono">run-log-vps.json</span> in the vault, and the Runs list
          merges those with the local ones. <span className="font-mono">plugins/script-runner/vps/README.md</span>{" "}
          has the paths and how to check on it.
        </p>
      </div>
    </div>
  );
}
