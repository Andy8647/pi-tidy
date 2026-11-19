/**
 * Background sub-agent notices, hung back on the call that launched them.
 *
 * billion-context's `acp_delegate` launches a run in the background and, when
 * it ends, sends `billion-context:delegate-notification`. By then the turn that
 * launched it may be long folded, and a newer prompt may sit in between: in
 * place, the notice reads as something that happened now, with nothing tying it
 * to the work it reports on. Each run in `details.runs` names the tool call
 * that launched it (`originToolCallId`), so the notice is drawn under that call
 * instead, as a row like a background job's, and the turn's summary counts it.
 *
 * Presentation only. The message stays where it is in the session and in the
 * model's context; only where it is drawn moves:
 *
 * - The launching call draws it, and marks it drawn for this frame. pi renders
 *   the transcript top to bottom, and the call always comes before its notice,
 *   so by the time the notice's own component renders it knows whether to draw
 *   nothing. A call that is not drawn at all — compacted away, on another
 *   branch, or folding is off — claims nothing, and the notice stays in place.
 * - A notice whose runs were launched in different turns, or by a call tidy
 *   never saw, stays in place too.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "../draw/frame-draw.ts";
import { TOOL_ICONS } from "../draw/icons.ts";
import { liveSlot } from "../live.ts";
import { DELEGATE_NOTICE, noticeBodyText, noticeLabel, type NoticeLabel } from "../messages/extension-notice.ts";
import type { ThemeLike } from "../theme-access.ts";
import { turnOptions, turnStore, type Turn } from "./turn-state.ts";

/** One run a notice reports on. */
interface DelegateRun {
  runId: string;
  status: string;
  /** The tool call that launched it, when billion-context knew. */
  origin?: string;
}

export interface DelegateNotice {
  /** Stable across a reload: the message's time and the runs it reports. */
  key: string;
  timestamp: number;
  message: { customType?: unknown; content?: unknown; details?: unknown };
  runs: DelegateRun[];
}

interface Registry {
  byKey: Map<string, DelegateNotice>;
  /** Bumped whenever a notice is added: the summaries and anchors key on it. */
  revision: number;
}

const registry = liveSlot<Registry>("delegate-notices", { byKey: new Map(), revision: 0 });
/** Notices a launching call drew this frame, so their own components draw nothing. */
const claimed = liveSlot("delegate-notices-claimed", new Set<string>());
/** Which notices the reader opened, by key: a reload builds new message objects. */
const opened = liveSlot("delegate-notices-open", new Map<string, boolean>());

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The notice a custom message is, or undefined when it is not one Tidy can place. */
function readNotice(message: unknown): DelegateNotice | undefined {
  const record = fields(message);
  if (record?.customType !== DELEGATE_NOTICE) return undefined;
  const details = fields(record.details);
  if (details?.version !== 1 || !Array.isArray(details.runs)) return undefined;
  const runs: DelegateRun[] = [];
  for (const entry of details.runs) {
    const run = fields(entry);
    const runId = text(run?.runId);
    const status = text(run?.status);
    if (!runId || !status) return undefined;
    const origin = text(run?.originToolCallId);
    runs.push({ runId, status, ...(origin ? { origin } : {}) });
  }
  if (runs.length === 0) return undefined;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : 0;
  return { key: `${timestamp}:${runs.map((run) => run.runId).join(",")}`, timestamp, message: record, runs };
}

/** Index a notice: from the session on load, from pi's events, and from its own render. */
export function noteDelegateNotice(message: unknown): DelegateNotice | undefined {
  const notice = readNotice(message);
  if (!notice) return undefined;
  const state = registry.get();
  if (!state.byKey.has(notice.key)) {
    state.byKey.set(notice.key, notice);
    state.revision++;
  }
  return state.byKey.get(notice.key);
}

/** Start over from a branch's entries: a new session, a reload, or another branch. */
export function resetDelegateNotices(entries: readonly unknown[] = []): void {
  registry.set({ byKey: new Map(), revision: 0 });
  claimed.set(new Set());
  for (const entry of entries) {
    const record = fields(entry);
    // A stored custom message is an entry of its own, its fields on the entry.
    if (record?.type === "custom_message") {
      noteDelegateNotice({ ...record, timestamp: typeof record.timestamp === "string" ? Date.parse(record.timestamp) : record.timestamp });
    }
  }
}

/** Every change to the notices, as one number. */
export function delegateRevision(): number {
  return registry.get().revision;
}

const anchors = liveSlot<{ revision: number; store: object; on: boolean; byCall: Map<string, DelegateNotice[]> } | undefined>(
  "delegate-notice-anchors",
  undefined,
);

/**
 * Which call each notice hangs under. All of a notice's runs have to have been
 * launched in one turn; it then hangs under the last of their calls, which is
 * where that turn's work on them ended. Anything else stays where it arrived.
 */
function anchorMap(): Map<string, DelegateNotice[]> {
  const state = registry.get();
  const store = turnStore.get();
  const on = turnOptions.get().collapseTurns !== "off";
  const cached = anchors.get();
  if (cached && cached.revision === state.revision && cached.store === store && cached.on === on) return cached.byCall;
  const byCall = new Map<string, DelegateNotice[]>();
  if (on) {
    for (const notice of [...state.byKey.values()].sort((a, b) => a.timestamp - b.timestamp)) {
      const origins = notice.runs.map((run) => run.origin);
      if (origins.some((origin) => origin === undefined)) continue;
      const turns = new Set(origins.map((origin) => store.byTool.get(origin!)));
      const [turn] = turns;
      if (turns.size !== 1 || !turn) continue;
      const ids = [...turn.tools.keys()];
      const last = origins.reduce((best, origin) => (ids.indexOf(origin!) > ids.indexOf(best!) ? origin : best), origins[0]);
      const list = byCall.get(last!) ?? [];
      list.push(notice);
      byCall.set(last!, list);
    }
  }
  // A notice that only just arrived may belong to a call already indexed: the
  // store keeps the same object, so the revision is what says it moved.
  anchors.set({ revision: state.revision, store, on, byCall });
  return byCall;
}

/**
 * The notices hung under this call, marked as drawn for this frame. Called on
 * every render of the call, drawn or folded away: a folded turn still owns them.
 */
export function claimNotices(toolCallId: string | undefined): DelegateNotice[] {
  if (!toolCallId) return [];
  const list = anchorMap().get(toolCallId) ?? [];
  for (const notice of list) claimed.get().add(notice.key);
  return list;
}

/**
 * Whether a notice's own component should draw nothing this frame, because its
 * call already drew it. One claim answers one render: a call that stops being
 * drawn stops claiming, and the notice is back in place on the next frame.
 */
export function takeClaim(message: unknown): boolean {
  const notice = noteDelegateNotice(message);
  if (!notice) return false;
  return claimed.get().delete(notice.key);
}

// ═══════════════════════════════════════════════════════════════════════════
// The turn's count
// ═══════════════════════════════════════════════════════════════════════════

export interface DelegateCounts {
  completed: number;
  failed: number;
  /** Cancelled, or any status the summary has no word of its own for. */
  other: number;
}

/**
 * How the runs this turn launched ended, one count per run however many notices
 * reported it: the latest notice of a run says how it ended.
 */
export function delegateCounts(turn: Turn): DelegateCounts {
  const latest = new Map<string, string>();
  for (const notice of [...registry.get().byKey.values()].sort((a, b) => a.timestamp - b.timestamp)) {
    for (const run of notice.runs) if (run.origin && turn.tools.has(run.origin)) latest.set(run.runId, run.status);
  }
  const counts = { completed: 0, failed: 0, other: 0 };
  for (const status of latest.values()) {
    if (status === "completed") counts.completed++;
    else if (status === "failed") counts.failed++;
    else counts.other++;
  }
  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// The rows under the call
// ═══════════════════════════════════════════════════════════════════════════

export interface NoticeRows {
  rows: string[];
  /** Each notice's rows, so a click finds the notice it landed on. */
  spans: Array<{ from: number; to: number; key: string }>;
}

function glyph(label: NoticeLabel, theme: ThemeLike): string {
  if (label.tone === "error") return theme.fg("error", "✗");
  if (label.tone === "warning") return theme.fg("warning", "⊘");
  if (label.tone === "success") return theme.fg("success", "✓");
  return theme.fg("muted", "·");
}

/**
 * The notices as rows under their call: `▸ ✓ 󰡉 researcher completed`, and a
 * click opens the text billion-context sent, in full. `onlyFailures` is a
 * folded group: like a job's row, a failure keeps its row under the header, and
 * the rest wait for the group to open.
 */
export function noticeRows(
  notices: readonly DelegateNotice[],
  theme: ThemeLike,
  options: { width: number; pad: string; icons: boolean; onlyFailures: boolean },
): NoticeRows {
  const rows: string[] = [];
  const spans: NoticeRows["spans"] = [];
  const room = Math.max(8, options.width - visibleWidth(options.pad) - 4);
  for (const notice of notices) {
    const label = noticeLabel(notice.message) ?? {};
    if (options.onlyFailures && label.tone !== "error") continue;
    const open = opened.get().get(notice.key) === true;
    const from = rows.length;
    const icon = options.icons ? `${theme.fg(label.tone ?? "muted", TOOL_ICONS.subagent!)} ` : "";
    const words = [label.name ?? "", label.status ? theme.fg(label.tone ?? "muted", label.status) : ""].filter(Boolean).join(" ");
    const head = `${theme.fg("accent", open ? "▾" : "▸")} ${glyph(label, theme)} ${icon}${words || theme.fg("muted", "sub-agent")}`;
    rows.push(clipToWidth(`${options.pad}${head}`, options.width, "…"));
    if (open) {
      const body = noticeBodyText(notice.message, label).trim();
      const lines = new Markdown(body, 0, 0, getMarkdownTheme(), { color: (line: string) => theme.fg("customMessageText", line) }).render(room);
      for (const line of lines) rows.push(clipToWidth(`${options.pad}    ${line}`, options.width, "…"));
    }
    spans.push({ from, to: rows.length - 1, key: notice.key });
  }
  return { rows, spans };
}

/** Open or shut one notice's text. */
export function toggleNotice(key: string): void {
  const state = opened.get();
  state.set(key, !(state.get(key) === true));
}
