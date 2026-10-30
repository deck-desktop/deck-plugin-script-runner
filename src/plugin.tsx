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
import { configRead, configWrite, pickScript, runScriptNow, vpsRunsPull } from "../shim/bridge.js";
import { ConfirmDialog, DayPicker, Segmented, Toggle, notify, dismissNotification, type ConfirmState } from "../shim/ui.js";
import { mergeRuns, lastRunById as newestPerJob, runNews, fmtTime, type ScriptJob, type RunRecord } from "./runs";

const relTime = (ms: number): string => {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};

/** A field's caption, the size and weight of Deck's own `Field` label. */
const label = "mb-1 block text-[12px] font-medium text-text-secondary";
/** A text field on the elevated surface, lit in the accent while typing in it. */
const field = "h-8 w-full rounded-lg border border-subtle bg-elev px-2.5 text-[12.5px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-[var(--accent)]";

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

/**
 * A failed run is a notification, whether or not the tab is open.
 *
 * At module scope because the tab unmounts when you look away, and Rust appends local runs to
 * `run-log` regardless. VPS runs arrive only when the tab's pull fetches them, so those are
 * noticed while the tab is open (or on the first pull after it opens). The first read after the
 * plugin loads is the baseline: whatever is already in the logs is not news. Memory only, so a
 * reload or restart takes a fresh baseline rather than writing anything per run.
 */
const SOURCE = "Script Runner";
let reported: Map<string, number> | null = null;

async function checkRuns() {
  const runs = await loadRunLog();
  const baseline = !reported;
  reported ??= new Map();
  const { failed, recovered } = runNews(runs, reported);
  if (baseline) return;
  for (const r of failed) {
    const when = new Date(r.finished_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const last = r.output?.trim().split("\n").at(-1)?.trim().slice(0, 160);
    notify({
      kind: "error", source: SOURCE, key: `run:${r.id}`,
      title: `${r.name || "(unnamed)"} failed${r.target === "vps" ? " on the VPS" : ""}`,
      body: [`${when} · exit ${r.exit_code}`, last].filter(Boolean).join("\n"),
    });
  }
  for (const id of recovered) dismissNotification(SOURCE, `run:${id}`);
}

void checkRuns();
const unlistenRuns = listen<string[]>("config-changed", (e) => {
  if (e.payload.includes("run-log") || e.payload.includes("run-log-vps")) void checkRuns();
}).catch((e) => { console.warn("[script-runner] run-log listener failed", e); return () => {}; });

/** Called by Deck before a reload re-imports this plugin, so the old copy stops listening. */
export function dispose() {
  void unlistenRuns.then((f) => f());
}

export default function ScriptRunner() {
  const [list, setList] = useState<ScriptJob[]>([]);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const lastSynced = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sheet, setSheet] = useState<RunRecord | null>(null); // open side sheet for one run
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // Latest run record per job id (runs are already newest-first from the merge).
  const lastRunById = useMemo(() => newestPerJob(runs), [runs]);
  const loadRuns = () => { void loadRunLog().then(setRuns); };

  const load = () =>
    configRead("script-runner").then((t) => {
      try { const f = t ? JSON.parse(t) : { jobs: [] }; const arr = Array.isArray(f.jobs) ? f.jobs : [];
        lastSynced.current = JSON.stringify(arr); setList(arr); } catch { /* keep */ }
    }).catch((e) => console.warn("[script-runner] jobs load failed", e));

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
    return () => { un?.(); };
    /* eslint-disable-next-line */
  }, []);

  // VPS run records live on the server; fetch them over SSH while this tab is on screen and a job
  // runs there. A minute apart, since each fetch is an ssh round trip. The write lands only when
  // the log changed, and the config-changed listener above reloads the list.
  const hasVps = list.some((j) => j.target === "vps");
  useEffect(() => {
    if (!hasVps) return;
    const pull = () => { if (!document.hidden) vpsRunsPull().catch(() => {}); };
    pull();
    const iv = setInterval(pull, 60_000);
    document.addEventListener("visibilitychange", pull);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", pull); };
  }, [hasVps]);

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
  // A VPS job leaves the server too: the saved list changes, and the installed Deck pushes the
  // VPS subset of it there (vpsjobs::push_if_changed). Run records are a separate log either way.
  const askRemove = (i: number) => {
    const j = list[i];
    setConfirm({
      title: `Remove the script ${j.name || "(unnamed)"}?`,
      body: j.target === "vps"
        ? "Its schedule goes from this list and from the server's copy, so the VPS stops running it; its past runs stay in the run log."
        : "Its schedule goes from this list, so it stops running; its past runs stay in the run log.",
      confirmLabel: "Remove",
      onConfirm: () => remove(i),
    });
  };
  const add = () => { setList((l) => [...l, { ...EMPTY, id: newId() }]); setOpenIdx(list.length); };
  // `pickScript` rather than the bridge's generic `pickFile`: that one takes a single
  // extension, and this dialog offers .ps1/.bat/.cmd/.exe together plus an "All files" fallback.
  const browse = async (i: number) => { const p = await pickScript(); if (p) update(i, { command: p }); };

  const enabledCount = list.filter((j) => j.enabled).length;

  return (
    <div className="relative mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-text-primary">Script Runner</h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">
            {list.length === 0 ? "Run scripts or commands on a schedule."
              : `${enabledCount} of ${list.length} enabled`}
          </p>
        </div>
        <AnimatePresence>
          {savedFlash && (
            <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-center gap-1 text-[11.5px]" style={{ color: "var(--accent)" }}>
              <Check size={13} /> Saved
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12px] leading-relaxed text-text-muted">
            <Clock size={16} className="mt-0.5 shrink-0" />
            <div className="flex flex-col items-start gap-2.5">
              <span>No scripts yet. Add one to run a script or a command every few minutes, or at a time on the days you pick.</span>
              <button onClick={add}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110"
                style={{ background: "var(--accent)" }}>
                <Plus size={14} /> New script
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
        {list.map((j, i) => {
          const open = openIdx === i;
          return (
            <motion.div key={j.id} layout className="overflow-hidden">
              <div className={"group flex h-7 items-center gap-2 rounded-md pl-2 pr-1 transition-colors " + (open ? "bg-white/5" : "hover:bg-white/5")}>
                <button onClick={() => setOpenIdx(open ? null : i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <ChevronDown size={13} className="shrink-0 text-text-muted transition-transform" style={{ transform: open ? "none" : "rotate(-90deg)" }} />
                  <span className="shrink-0 truncate text-[12.5px] text-text-primary">{j.name || "(unnamed)"}</span>
                  {j.target === "vps" && (
                    <span className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] text-text-secondary"
                      style={{ background: "var(--bg-elev)" }}>VPS</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{summary(j)} · {j.command || "no command"}</span>
                </button>
                {j.target !== "vps" && (
                  <button onClick={() => { void runScriptNow(j.command, j.args, j.id, j.name); setTimeout(loadRuns, 1500); }} title="Run now"
                    className="grid size-5 shrink-0 place-items-center rounded text-text-muted opacity-0 transition-colors hover:bg-white/10 hover:text-text-primary group-hover:opacity-100">
                    <Play size={13} />
                  </button>
                )}
                <StatusIcon rec={lastRunById[j.id]} onClick={() => lastRunById[j.id] && setSheet(lastRunById[j.id])} />
                <Toggle on={j.enabled} onChange={(v) => update(i, { enabled: v })} />
              </div>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
                    <div className="pb-4 pl-8 pr-2 pt-2.5">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
                        <label className="block">
                          <span className={label}>Name</span>
                          <input value={j.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Display name" className={field} />
                        </label>
                        <label className="block">
                          <span className={label}>Arguments <span className="font-normal text-text-muted">· optional</span></span>
                          <input value={j.args.join(" ")}
                            onChange={(e) => update(i, { args: e.target.value.split(" ").filter(Boolean) })}
                            placeholder="Space-separated"
                            className={field} />
                        </label>

                        <div className="col-span-2">
                          <span className={label}>Runs on</span>
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
                              Needs a scheduler installed on that server — Deck copies the VPS
                              jobs there over SSH, and it checks them once a minute.{" "}
                              {/* "plugin-settings:<id>" is App's way to open one plugin's
                                  settings, which is where the steps are. */}
                              <button
                                onClick={() => window.dispatchEvent(
                                  new CustomEvent("deck-navigate", { detail: "plugin-settings:script-runner" }))}
                                className="underline decoration-dotted underline-offset-2 transition-colors hover:text-text-primary">
                                Show me the steps
                              </button>
                            </p>
                          )}
                        </div>

                        <label className="col-span-2 block">
                          <span className={label}>Command</span>
                          <div className="flex gap-2">
                            <input value={j.command} onChange={(e) => update(i, { command: e.target.value })}
                              placeholder={j.target === "vps" ? "VPS command or script path (runs in bash)" : "Path to .ps1/.bat/.exe or an inline command"}
                              className={field} />
                            {j.target !== "vps" && (
                              <button onClick={() => browse(i)} title="Browse for a script"
                                className="grid size-8 shrink-0 place-items-center rounded-lg border border-subtle bg-elev text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
                                <FolderOpen size={14} />
                              </button>
                            )}
                          </div>
                        </label>

                        <div className="col-span-2">
                          <span className={label}>Schedule</span>
                          <div className="flex items-center gap-3">
                            <Segmented layoutId={`seg-mode-${j.id}`}
                              value={j.mode} onChange={(m) => update(i, { mode: m as ScriptJob["mode"] })}
                              options={[{ value: "interval", label: "Every N min" }, { value: "atTime", label: "At time" }]} />
                            {j.mode === "interval" ? (
                              <div className="relative w-32">
                                <input value={String(j.intervalMin)} inputMode="numeric"
                                  onChange={(e) => update(i, { intervalMin: Number(e.target.value) || 0 })}
                                  className={field + " pr-10"} />
                                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-text-muted">min</span>
                              </div>
                            ) : (
                              // TimeInput's native picker, at the height of the fields around it.
                              <input type="time" value={j.timeOfDay} onChange={(e) => update(i, { timeOfDay: e.target.value })}
                                onClick={(e) => { try { (e.currentTarget as any).showPicker?.(); } catch { /* not supported */ } }}
                                className={"time-input w-32 cursor-pointer leading-none " + field} />
                            )}
                          </div>
                        </div>

                        {j.mode === "atTime" && (
                          <>
                            <div className="col-span-2">
                              <span className={label}>On days</span>
                              <DayPicker value={j.days} onChange={(d) => update(i, { days: d })} />
                            </div>
                            <label className="block">
                              <span className={label}>Repeat every</span>
                              <div className="relative">
                                <input
                                  value={String(j.everyWeeks ?? 1)} inputMode="numeric"
                                  onChange={(e) => {
                                    const n = Math.max(1, Number(e.target.value) || 1);
                                    update(i, { everyWeeks: n, startDate: n > 1 && !j.startDate ? todayISO() : j.startDate });
                                  }}
                                  className={field + " pr-14"} />
                                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-text-muted">week{(j.everyWeeks ?? 1) > 1 ? "s" : ""}</span>
                              </div>
                            </label>
                            {(j.everyWeeks ?? 1) > 1 && (
                              <label className="block">
                                <span className={label}>Starting</span>
                                <input type="date" value={j.startDate || todayISO()}
                                  onChange={(e) => update(i, { startDate: e.target.value })}
                                  className={"time-input " + field} />
                              </label>
                            )}
                          </>
                        )}
                      </div>

                      <div className="mt-4 flex justify-end">
                        <button onClick={() => askRemove(i)}
                          className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-text-muted transition-colors hover:bg-white/5 hover:text-red-400">
                          <Trash2 size={13} /> Remove script
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

        {list.length > 0 && (
          <button onClick={add}
            className="mt-2 flex h-8 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
            <Plus size={14} /> New script
          </button>
        )}
      </div>

      <RunSheet rec={sheet} onClose={() => setSheet(null)} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

const OK = "rgb(var(--tone-green-400))";
const FAILED = "rgb(var(--tone-red-400))";

// Row status: last-run outcome as a small icon. No record yet → an empty slot, so rows line up.
function StatusIcon({ rec, onClick }: { rec?: RunRecord; onClick: () => void }) {
  if (!rec) return <span className="w-6 shrink-0" title="Never run" />;
  const { color, Icon, label } = rec.ok
    ? { color: OK, Icon: CheckCircle2, label: "Succeeded" }
    : { color: FAILED, Icon: XCircle, label: "Failed" };
  return (
    <button onClick={onClick} title={`${label} · ${relTime(rec.finished_at)} — click for details`}
      className="grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-white/10">
      <Icon size={14} style={{ color }} />
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
  const tone = rec?.ok ? OK : FAILED;
  return (
    <AnimatePresence>
      {rec && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose} className="absolute inset-0 z-40 bg-black/40" />
          {/* Inside the tab rather than over the window: it is about this tab's jobs. */}
          <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 400, damping: 38 }}
            className="absolute right-0 top-0 z-50 flex h-full w-[440px] max-w-[85%] flex-col border-l border-subtle bg-card shadow-2xl">
            <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                {rec.ok ? <CheckCircle2 size={15} className="shrink-0" style={{ color: OK }} />
                        : <XCircle size={15} className="shrink-0" style={{ color: FAILED }} />}
                <span className="truncate text-[13px] font-semibold text-text-primary">{rec.name || "(unnamed)"}</span>
                {rec.target === "vps" && (
                  <span className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] text-text-secondary"
                    style={{ background: "var(--bg-elev)" }}>VPS</span>
                )}
              </div>
              <button onClick={onClose} title="Close"
                className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary"><X size={15} /></button>
            </div>
            <div className="space-y-2 px-5 py-2 text-[12.5px]">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[12px] text-text-muted">Result</span>
                <span className="rounded-full px-1.5 py-px text-[10.5px]"
                  style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
                  {rec.ok ? "Succeeded" : `Failed (exit ${rec.exit_code})`}
                </span>
              </div>
              <Detail label="Ran" value={`${fmtAbs(rec.finished_at)} · ${relTime(rec.finished_at)}`} />
              <Detail label="Duration" value={rec.finished_at && rec.started_at
                ? `${((rec.finished_at - rec.started_at) / 1000).toFixed(1)}s` : "—"} />
            </div>
            <div className="flex items-center gap-1.5 px-5 pb-1.5 pt-3 text-[12px] font-medium text-text-secondary">
              <Clock size={12} className="text-text-muted" /> Output
            </div>
            <pre className="scroll-thin mx-5 mb-4 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-subtle bg-app p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
              {rec.output?.trim() || "(no output captured)"}
            </pre>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[12px] text-text-muted">{label}</span>
      <span className="text-right text-text-primary">{value}</span>
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
          systemd timer that checks the job list every minute. Deck copies the VPS jobs to{" "}
          <span className="font-mono">~/deck/</span> on the server over SSH (host{" "}
          <span className="font-mono">vps</span> in your <span className="font-mono">~/.ssh/config</span>)
          whenever they change.
        </p>
        <pre className="scroll-thin overflow-x-auto rounded p-2 text-[11px] text-text-secondary"
          style={{ background: "var(--bg-card)", fontFamily: "var(--font-mono)" }}>
{`git clone https://github.com/deck-desktop/deck-plugin-script-runner
cd deck-plugin-script-runner/vps
ssh vps 'mkdir -p ~/deck-scheduler'
scp deck-vps-scheduler.sh run-one-job.sh deck-scheduler.timer \
  deck-scheduler.service install.sh vps:~/deck-scheduler/
ssh vps 'sh ~/deck-scheduler/install.sh --check'
ssh vps 'sh ~/deck-scheduler/install.sh'`}
        </pre>
        <p className="mt-2 text-text-muted">
          The line ending in <span className="font-mono">--check</span> is a dry run — it prints
          what it would do and changes nothing, so read that before the last one. Needs{" "}
          <span className="font-mono">jq</span> and systemd on the server, and key-based{" "}
          <span className="font-mono">ssh vps</span> from this PC.
        </p>
        <p className="mt-2 text-text-muted">
          Results come back the same way: the server appends to{" "}
          <span className="font-mono">~/deck/run-log-vps.json</span>, Deck fetches it while this tab
          is open, and the Runs list merges those with the local ones. The plugin's repository has
          the paths and how to check on it, in <span className="font-mono">vps/README.md</span>.
        </p>
      </div>
    </div>
  );
}
