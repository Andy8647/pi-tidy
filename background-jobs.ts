/**
 * Background jobs: work a tool call started that outlives the call — a dev
 * server, a test watcher. The call itself finishes in milliseconds, so to pi
 * (and to the grouping) it is done; the job's real state lives in whichever
 * extension runs it.
 *
 * pi has no notion of these, so each such extension gets a small provider
 * here. A provider says which tool results start a job, which messages report
 * on one, and where live updates come from. pi-processes is the first. If a
 * provider's protocol stops matching (renamed fields, different events) it
 * simply finds no jobs, and rows render the way they did before.
 *
 * State is derived, not persisted: a job is seeded from its start call's
 * result, corrected by the extension's live answer, and — when a session is
 * reloaded — rebuilt from the notification messages the extension persisted.
 */

import { liveSlot } from "./live.ts";

export type JobStatus = "running" | "done" | "failed" | "killed" | "gone";

export interface JobState {
  id: string;
  name: string;
  status: JobStatus;
  /** Epoch ms. */
  startTime?: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string;
  /** The latest thing worth surfacing, e.g. `READY matched`. */
  note?: string;
}

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ToolSnapshot {
  toolName: string;
  args?: unknown;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
}

export interface MessageSnapshot {
  customType?: unknown;
  details?: unknown;
}

export interface JobProvider {
  /** The job a finished call started, as of its result. */
  fromToolResult(tool: ToolSnapshot): JobState | undefined;
  /** Ask the extension for the job's live state; `null` = it doesn't know it. */
  lookup(events: EventBusLike, id: string): Partial<JobState> | null | undefined;
  /** A message reporting on a job: which one, and what it says. */
  fromMessage(message: MessageSnapshot): { id: string; patch: Partial<JobState> } | undefined;
  /** Live updates. Returns the unsubscribe. */
  subscribe(events: EventBusLike, update: (id: string, patch: Partial<JobState>) => void): () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// pi-processes (@aliou/pi-processes)
// ─────────────────────────────────────────────────────────────────────────────

interface ProcessInfoLike {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  exitCode?: unknown;
  success?: unknown;
  endReason?: unknown;
  signal?: { name?: unknown } | null;
  errorMessage?: unknown;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** pi-processes' `ProcessInfo` → our state. */
function fromProcessInfo(info: ProcessInfoLike): Partial<JobState> {
  const live = info.status === "running" || info.status === "terminating" || info.status === "terminate_timeout";
  const status: JobStatus = live
    ? "running"
    : info.status === "killed" || info.endReason === "signal"
      ? "killed"
      : info.success === true
        ? "done"
        : "failed";
  const patch: Partial<JobState> = { status, startTime: num(info.startTime) };
  if (!live) {
    patch.endTime = num(info.endTime);
    patch.exitCode = num(info.exitCode) ?? null;
    patch.signal = str(info.signal?.name);
    if (status === "failed" && info.endReason !== "exit") patch.note = str(info.errorMessage) ?? str(info.endReason);
  }
  return patch;
}

const PROCESS_NOTIFICATION = "ad-process:notification";

/** A notification payload (live event or persisted message details) → a patch. */
function fromProcessNotification(details: unknown): { id: string; patch: Partial<JobState> } | undefined {
  const d = details as {
    kind?: unknown;
    processId?: unknown;
    timestamp?: unknown;
    exitCode?: unknown;
    signal?: { name?: unknown } | null;
    logMatch?: { pattern?: unknown };
  };
  const id = str(d?.processId);
  if (!id) return undefined;
  const endTime = num(d.timestamp);
  switch (d.kind) {
    case "success":
      return { id, patch: { status: "done", endTime, exitCode: num(d.exitCode) ?? 0 } };
    case "failure":
    case "crash":
      return { id, patch: { status: "failed", endTime, exitCode: num(d.exitCode) ?? null } };
    case "killed":
      return { id, patch: { status: "killed", endTime, signal: str(d.signal?.name) } };
    case "log_match": {
      const pattern = str(d.logMatch?.pattern);
      return pattern ? { id, patch: { note: `${pattern} matched` } } : undefined;
    }
    default:
      return undefined;
  }
}

export const piProcessesProvider: JobProvider = {
  fromToolResult(tool) {
    if (tool.toolName !== "process" || tool.isPartial || tool.result?.isError) return undefined;
    if ((tool.args as { action?: unknown } | undefined)?.action !== "start") return undefined;
    const process = (tool.result?.details as { process?: ProcessInfoLike } | undefined)?.process;
    const id = str(process?.id);
    if (!process || !id) return undefined;
    return { id, name: str(process.name) ?? id, status: "running", ...fromProcessInfo(process) };
  },
  lookup(events, id) {
    let reply: ProcessInfoLike | null | undefined;
    events.emit("processes:request:get", {
      id,
      reply: (info: ProcessInfoLike | null | undefined) => {
        reply = info ?? null;
      },
    });
    if (reply === undefined) return undefined; // nobody answered: pi-processes isn't loaded
    return reply ? fromProcessInfo(reply) : null;
  },
  fromMessage(message) {
    return message.customType === PROCESS_NOTIFICATION ? fromProcessNotification(message.details) : undefined;
  },
  subscribe(events, update) {
    const off = [
      events.on("processes:ended", (info) => {
        const id = str((info as ProcessInfoLike)?.id);
        if (id) update(id, fromProcessInfo(info as ProcessInfoLike));
      }),
      events.on("processes:notification", (payload) => {
        const hit = fromProcessNotification(payload);
        if (hit) update(hit.id, hit.patch);
      }),
    ];
    return () => {
      for (const dispose of off) dispose();
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global so a `/reload` shares it: the patches installed by the first load
 * read it, the reloaded module's event subscription writes it.
 */
interface Store {
  providers: JobProvider[];
  jobs: Map<string, JobState>;
  /** Jobs whose start row has rendered — their notifications are redundant. */
  rows: Set<string>;
  events?: EventBusLike;
  ui?: { requestRender?(): void };
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  options: { enabled: boolean; hideNotifications: boolean };
}

const store = liveSlot<Store | undefined>("background-jobs", undefined);

function jobsStore(): Store {
  let s = store.get();
  if (!s) {
    s = {
      providers: [piProcessesProvider],
      jobs: new Map(),
      rows: new Set(),
      options: { enabled: true, hideNotifications: true },
    };
    store.set(s);
  }
  return s;
}

export function setJobOptions(options: { enabled: boolean; hideNotifications: boolean }): void {
  jobsStore().options = options;
}

export function jobsEnabled(): boolean {
  return jobsStore().options.enabled;
}

/** Ended states never go back to running; "gone" yields to a real answer. */
function apply(s: Store, id: string, patch: Partial<JobState>): boolean {
  const job = s.jobs.get(id);
  if (!job) return false;
  if (patch.status === "running" && job.status !== "running") patch = { ...patch, status: job.status };
  if (job.status !== "running" && job.status !== "gone" && patch.status && patch.status !== job.status) {
    patch = { ...patch, status: job.status };
  }
  let changed = false;
  for (const [key, value] of Object.entries(patch) as Array<[keyof JobState, unknown]>) {
    if (value === undefined || job[key] === value) continue;
    (job as unknown as Record<string, unknown>)[key] = value;
    changed = true;
  }
  return changed;
}

function repaint(s: Store): void {
  s.ui?.requestRender?.();
}

/** Subscribe to every provider's live updates (replacing an earlier load's). */
export function connectJobs(events: EventBusLike | undefined): void {
  const s = jobsStore();
  s.unsubscribe?.();
  s.unsubscribe = undefined;
  s.events = events;
  if (!events) return;
  const disposers = s.providers.map((provider) =>
    provider.subscribe(events, (id, patch) => {
      if (apply(s, id, patch)) repaint(s);
    }),
  );
  s.unsubscribe = () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * The job this tool call started, if any. Registers its row: from now on the
 * job's notification messages are redundant with it.
 */
export function jobForTool(tool: ToolSnapshot & { ui?: { requestRender?(): void } }): JobState | undefined {
  const s = jobsStore();
  if (!s.options.enabled) return undefined;
  for (const provider of s.providers) {
    const seed = provider.fromToolResult(tool);
    if (!seed) continue;
    if (tool.ui) s.ui = tool.ui;
    s.rows.add(seed.id);
    let job = s.jobs.get(seed.id);
    if (!job) {
      job = seed;
      s.jobs.set(seed.id, job);
      // The result is a snapshot from the moment it started. Ask for the
      // truth once; a job its extension doesn't know (a reloaded session
      // from an earlier pi) is gone, not running forever.
      const live = s.events ? provider.lookup(s.events, seed.id) : undefined;
      if (live === null) job.status = "gone";
      else if (live) apply(s, seed.id, live);
    }
    ensureTicker(s);
    return job;
  }
  return undefined;
}

/**
 * A message rendered: fold what it reports into its job. Returns true when it
 * should be hidden — its job has a row showing the same thing.
 */
export function noteJobMessage(message: MessageSnapshot | undefined): boolean {
  const s = jobsStore();
  if (!s.options.enabled || !message) return false;
  for (const provider of s.providers) {
    const hit = provider.fromMessage(message);
    if (!hit) continue;
    // On a reload the row rendered first, with the start snapshot: one more
    // frame lets it show what this message says.
    if (apply(s, hit.id, hit.patch)) repaint(s);
    return s.options.hideNotifications && s.rows.has(hit.id);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock
// ─────────────────────────────────────────────────────────────────────────────

/** A spinner frame per second for the first minutes, then a still dot. */
const SPINNER = ["◐", "◓", "◑", "◒"];
export const ANIMATE_MS = 5 * 60_000;

export function spinnerFrame(job: JobState, now = Date.now()): string {
  const age = job.startTime !== undefined ? now - job.startTime : 0;
  return age < ANIMATE_MS ? SPINNER[Math.floor(now / 1000) % SPINNER.length] : "●";
}

/**
 * One repaint per second while a young job runs, one per minute once every
 * running job is past the animation window (a dev server can run for hours —
 * the whole transcript re-renders on each tick). Stops when nothing runs.
 */
function ensureTicker(s: Store): void {
  if (s.timer) return;
  const running = [...s.jobs.values()].filter((job) => job.status === "running" && s.rows.has(job.id));
  if (running.length === 0) return;
  const now = Date.now();
  const young = running.some((job) => job.startTime === undefined || now - job.startTime < ANIMATE_MS);
  s.timer = setTimeout(
    () => {
      s.timer = undefined;
      repaint(s);
      ensureTicker(s);
    },
    young ? 1000 : 60_000,
  );
  s.timer.unref?.();
}

/** Test seam. */
export function resetJobs(providers: JobProvider[] = [piProcessesProvider]): void {
  const s = jobsStore();
  if (s.timer) clearTimeout(s.timer);
  s.unsubscribe?.();
  store.set({
    providers,
    jobs: new Map(),
    rows: new Set(),
    options: { enabled: true, hideNotifications: true },
  });
}
