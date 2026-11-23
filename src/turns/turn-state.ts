import type { HeaderStyle } from "../draw/frame-draw.ts";
import { liveSlot } from "../live.ts";
import { nestedBreakdown, type BreakdownEntry } from "../tools/tool-groups.ts";
import { nestedCallFailed, nestedCallsOf } from "../tools/nested-calls.ts";

export type CollapseTurns = "off" | "afterRun" | "live";
export type FinalReplyStyle = "frame" | "rail" | "off";
export type TurnOutcome = "running" | "completed" | "interrupted" | "error" | "incomplete" | "unknown";
export interface LlmStepMetrics {
  ttftMs?: number;
  durationMs?: number;
  outputTokens?: number;
  stopReason?: string;
}
export interface TurnLlmMetrics {
  ttftMs?: number;
  tps?: number;
}
export interface TurnMessage {
  role: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  durationMs?: number;
  usage?: { output?: number };
  content?: any;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: any;
}
export interface Turn {
  messages: Map<string, TurnMessage>;
  tools: Map<string, { name: string; args: unknown; failed?: boolean; nestedFailed?: number; nested?: BreakdownEntry[] }>;
  llmMetrics?: Map<string, LlmStepMetrics>;
  root?: string;
  firstAssistant?: string;
  latestText?: string;
  lastAssistant?: string;
  final?: string;
  startedAt?: number;
  endedAt?: number;
  outcome: TurnOutcome;
  toolMs?: number;
  open?: boolean;
  /** Bumped on every mutation, so a per-frame summary can tell it went stale. */
  version?: number;
}
export interface SavedTurn {
  keys: string[];
  startedAt: number;
  endedAt: number;
  outcome: TurnOutcome;
  toolMs?: number;
}
export const TURN_ENTRY = "pi-tidy:turn";

export function messageKey(message: TurnMessage | undefined): string | undefined {
  if (!message) return undefined;
  // Called per message per frame by the turn lookup; the key is a string build
  // over fields that never change for a given message object.
  const cached = messageKeys.get(message);
  if (cached !== undefined) return cached;
  const key = message.role === "toolResult"
    ? `tool:${message.toolCallId}`
    : typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? `${message.role}:${message.timestamp}:${message.provider ?? ""}:${message.model ?? ""}`
      : undefined;
  if (key !== undefined) messageKeys.set(message, key);
  return key;
}
const messageKeys = new WeakMap<object, string>();
export function hasText(message: TurnMessage | undefined): boolean {
  return Array.isArray(message?.content) && message.content.some((block: any) => block.type === "text" && block.text?.trim());
}
export function unionMs(intervals: readonly (readonly [number, number])[]): number {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
function newTurn(startedAt?: number): Turn {
  return { messages: new Map(), tools: new Map(), startedAt, outcome: "running" };
}
function add(turn: Turn, key: string, message: TurnMessage): void {
  turn.version = (turn.version ?? 0) + 1;
  turn.messages.set(key, message);
  if (message.role === "user" && !turn.root) turn.root = key;
  if (message.role === "assistant") {
    if (!turn.firstAssistant) turn.firstAssistant = key;
    turn.lastAssistant = key;
    if (hasText(message)) turn.latestText = key;
    for (const block of message.content ?? []) if (block.type === "toolCall") {
      const previous = turn.tools.get(block.id);
      turn.tools.set(block.id, {
        name: block.name,
        args: block.arguments,
        failed: previous?.failed,
        nestedFailed: previous?.nestedFailed,
        nested: previous?.nested,
      });
    }
  } else if (message.role === "toolResult" && message.toolCallId) {
    const previous = turn.tools.get(message.toolCallId);
    // A program's own calls hang on the call that ran them (see nested-calls.ts):
    // what they were, and how many of them failed inside a run that may well
    // have caught the failure and gone on.
    const calls = nestedCallsOf(message.details, message.toolCallId);
    const nested = nestedBreakdown(message.details, message.toolCallId);
    turn.tools.set(message.toolCallId, {
      name: message.toolName ?? previous?.name ?? "tool",
      args: previous?.args,
      failed: message.isError,
      nestedFailed: calls.filter(nestedCallFailed).length,
      nested: nested.length > 0 ? nested : previous?.nested,
    });
  }
}
function finishText(turn: Turn): void {
  turn.version = (turn.version ?? 0) + 1;
  const last = turn.lastAssistant && turn.messages.get(turn.lastAssistant);
  if (turn.outcome === "unknown" && last) {
    if (last.stopReason === "error") turn.outcome = "error";
    else if (last.stopReason === "aborted") turn.outcome = "interrupted";
    else if (last.stopReason === "length") turn.outcome = "incomplete";
  }
  turn.final = last && hasText(last) && !last.content.some((block: any) => block.type === "toolCall") ? turn.lastAssistant : undefined;
}

/** Session-scoped state; messages and tools bind once, not by render order. */
export class TurnStore {
  byMessage = new Map<string, Turn>();
  byTool = new Map<string, Turn>();
  current?: Turn;
  private toolStarts = new Map<string, number>();
  private toolIntervals: [number, number][] = [];
  pendingLlmAt?: number;
  private pendingRequestAt?: number;
  private pendingFirstTokenAt?: number;
  private pendingStepKey?: string;
  settlementOutcome?: "completed" | "aborted" | "error";

  begin(now = Date.now()): void {
    if (this.current) return; // retries and automatic continuation stay in this run; a user message splits it (see note)
    this.current = newTurn(now);
    this.pendingLlmAt = undefined;
    this.pendingRequestAt = undefined;
    this.pendingFirstTokenAt = undefined;
    this.pendingStepKey = undefined;
    this.settlementOutcome = undefined;
    this.toolStarts.clear();
    this.toolIntervals = [];
  }
  /**
   * Record one message. A user message that arrives after this run answered
   * something is a new instruction: typed while the agent worked (steering) or
   * queued for when it would stop (a follow-up). The answer above it is finished
   * and belongs to its own segment, so the turn is settled here and a new one
   * begins. Returns the segment this message closed.
   */
  note(message: TurnMessage, ended = false): SavedTurn | undefined {
    const key = messageKey(message);
    if (!key || !this.current) return undefined;
    // A first answer is what makes a segment, and what a fold can hide. Before
    // one exists (the run's own prompt, or a steer that beat the first response,
    // or this message's own `message_end`) the message is part of the segment.
    let closed: SavedTurn | undefined;
    if (message.role === "user" && this.current.firstAssistant !== undefined) {
      // End the segment where the message was typed, not where it was delivered:
      // the two then meet, and neither one claims the other's time.
      const saved = this.settle(false, message.timestamp ?? Date.now());
      if (saved) { this.begin(saved.endedAt); closed = saved; }
    }
    const turn = this.current;
    if (message.role === "user" && !turn.root && message.timestamp !== undefined) {
      turn.startedAt = Math.min(turn.startedAt!, message.timestamp);
    }
    add(turn, key, message);
    this.byMessage.set(key, turn);
    if (message.role === "toolResult" && message.toolCallId) this.byTool.set(message.toolCallId, turn);
    if (message.role === "assistant") for (const block of message.content ?? []) {
      if (block.type === "toolCall") this.byTool.set(block.id, turn);
    }
    if (message.role === "assistant") {
      this.pendingLlmAt = !ended && message.durationMs === undefined ? message.timestamp : undefined;
      if (!ended) {
        if (this.pendingStepKey !== key) {
          this.pendingStepKey = key;
          this.pendingFirstTokenAt = undefined;
          if (this.pendingRequestAt === undefined) this.pendingRequestAt = message.timestamp;
        }
      } else {
        const isTrackedStep = this.pendingStepKey === key || this.pendingStepKey === undefined;
        const firstTokenAt = isTrackedStep ? this.pendingFirstTokenAt : undefined;
        const requestAt = this.pendingRequestAt ?? message.timestamp;
        const ttftMs = firstTokenAt !== undefined && requestAt !== undefined && Number.isFinite(requestAt)
          ? Math.max(0, firstTokenAt - requestAt)
          : undefined;
        const durationMs = typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs > 0
          ? message.durationMs
          : undefined;
        const outputTokens = typeof message.usage?.output === "number" && Number.isFinite(message.usage.output) && message.usage.output > 0
          ? message.usage.output
          : undefined;
        if (ttftMs !== undefined || durationMs !== undefined || outputTokens !== undefined) {
          turn.llmMetrics ??= new Map();
          turn.llmMetrics.set(key, { ttftMs, durationMs, outputTokens, stopReason: message.stopReason });
        }
        this.pendingRequestAt = undefined;
        this.pendingFirstTokenAt = undefined;
        this.pendingStepKey = undefined;
      }
    }
    return closed;
  }
  requestStart(now = Date.now()): void {
    if (this.current && this.toolStarts.size === 0) {
      this.pendingLlmAt = now;
      this.pendingRequestAt = now;
      this.pendingFirstTokenAt = undefined;
      this.pendingStepKey = undefined;
    }
  }
  noteStreamUpdate(message: TurnMessage, event?: { type?: string; delta?: string; content?: string }, now = Date.now()): void {
    if (!this.current || this.toolStarts.size > 0 || message.role !== "assistant") return;
    const key = messageKey(message);
    if (!key || this.pendingStepKey !== key || this.pendingFirstTokenAt !== undefined) return;
    const type = event?.type;
    const hasToken =
      ((type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") && (event?.delta?.length ?? 0) > 0) ||
      ((type === "text_end" || type === "thinking_end") && (event?.content?.length ?? 0) > 0) ||
      type === "toolcall_end";
    if (hasToken) this.pendingFirstTokenAt = now;
  }
  /** Whole-turn metrics: mean TTFT, and output tok/s over the requests' full durations. */
  llmMetrics(turn: Turn): TurnLlmMetrics {
    let ttftSum = 0;
    let ttftCount = 0;
    let outputSum = 0;
    let durationSum = 0;
    for (const step of turn.llmMetrics?.values() ?? []) {
      if (step.stopReason === "error") continue;
      if (typeof step.ttftMs === "number" && Number.isFinite(step.ttftMs) && step.ttftMs >= 0) {
        ttftSum += step.ttftMs;
        ttftCount++;
      }
      // Pair the numerator and the denominator: a step that spent time without
      // producing tokens (or vice versa) must not drag the rate down or up.
      if (
        typeof step.outputTokens === "number" && Number.isFinite(step.outputTokens) && step.outputTokens > 0 &&
        typeof step.durationMs === "number" && Number.isFinite(step.durationMs) && step.durationMs > 0
      ) {
        outputSum += step.outputTokens;
        durationSum += step.durationMs;
      }
    }
    const ttftMs = ttftCount > 0 ? ttftSum / ttftCount : undefined;
    const tps = outputSum > 0 && durationSum > 0 ? outputSum / (durationSum / 1000) : undefined;
    return { ttftMs, tps };
  }
  toolStart(id: string, parent: string | undefined, now = Date.now()): void {
    if (this.current && !parent) this.toolStarts.set(id, now);
  }
  toolEnd(id: string, parent: string | undefined, now = Date.now()): void {
    const start = this.toolStarts.get(id);
    if (this.current && !parent && start !== undefined) {
      this.toolIntervals.push([start, now]);
      this.toolStarts.delete(id);
      this.current.toolMs = unionMs(this.toolIntervals);
    }
  }
  toolTime(turn: Turn, now = Date.now()): number | undefined {
    if (turn !== this.current) return turn.tools.size === 0 ? 0 : turn.toolMs;
    return unionMs([...this.toolIntervals, ...[...this.toolStarts.values()].map((start): [number, number] => [start, now])]);
  }
  llmTime(turn: Turn, now = Date.now()): number | undefined {
    const messages = [...turn.messages.values()].filter((message) => message.role === "assistant");
    const intervals: [number, number][] = [];
    for (const message of messages) {
      if (typeof message.durationMs !== "number" || !Number.isFinite(message.durationMs) || message.durationMs < 0) {
        if (turn !== this.current || message.timestamp !== this.pendingLlmAt) return undefined;
      } else if (message.timestamp !== undefined) intervals.push([message.timestamp, message.timestamp + message.durationMs]);
    }
    if (turn === this.current && this.pendingLlmAt !== undefined) intervals.push([this.pendingLlmAt, now]);
    return intervals.length ? unionMs(intervals) : undefined;
  }
  settle(aborted: boolean, now = Date.now()): SavedTurn | undefined {
    const turn = this.current;
    if (!turn) return undefined;
    turn.version = (turn.version ?? 0) + 1;
    const reason = turn.lastAssistant && turn.messages.get(turn.lastAssistant)?.stopReason;
    turn.outcome = aborted || this.settlementOutcome === "aborted" || reason === "aborted" ? "interrupted"
      : this.settlementOutcome === "error" || reason === "error" ? "error" : reason === "length" ? "incomplete" : "completed";
    turn.endedAt = now;
    turn.toolMs = this.toolTime(turn, now);
    finishText(turn);
    this.current = undefined;
    this.pendingLlmAt = undefined;
    this.pendingRequestAt = undefined;
    this.pendingFirstTokenAt = undefined;
    this.pendingStepKey = undefined;
    return { keys: [...turn.messages.keys()], startedAt: turn.startedAt!, endedAt: now, outcome: turn.outcome, toolMs: turn.toolMs };
  }
  restore(entries: readonly any[]): void {
    this.byMessage.clear();
    this.byTool.clear();
    this.current = undefined;
    this.pendingLlmAt = undefined;
    let legacy: Turn | undefined;
    for (const entry of entries) {
      if (entry.type === "message") {
        const message = entry.message as TurnMessage;
        const key = messageKey(message);
        if (!key) continue;
        if (!legacy || message.role === "user") legacy = newTurn();
        legacy.outcome = "unknown";
        add(legacy, key, message);
        finishText(legacy);
        this.byMessage.set(key, legacy);
        for (const id of legacy.tools.keys()) this.byTool.set(id, legacy);
      } else if (entry.type === "custom" && entry.customType === TURN_ENTRY) {
        const saved = entry.data as SavedTurn;
        if (!Array.isArray(saved?.keys) || !saved.keys.every((key) => typeof key === "string") ||
          !Number.isFinite(saved.startedAt) || !Number.isFinite(saved.endedAt) || saved.endedAt < saved.startedAt ||
          !["completed", "interrupted", "error", "incomplete", "unknown"].includes(saved.outcome)) continue;
        // An entry an older version wrote covers the whole run, steering and
        // follow-ups included. The messages are all here, so rebuild the runs a
        // live session makes now: a user message after the first answer opens
        // one, at the moment it was typed. Only one run's tool time was saved,
        // and it cannot be handed to the runs that time was split between.
        const segments: Turn[] = [newTurn(saved.startedAt)];
        for (const key of saved.keys) {
          const message = this.byMessage.get(key)?.messages.get(key);
          if (!message) continue;
          const last = segments[segments.length - 1]!;
          if (message.role === "user" && last.firstAssistant !== undefined) {
            last.endedAt = message.timestamp ?? last.endedAt;
            segments.push(newTurn(message.timestamp));
          }
          const turn = segments[segments.length - 1]!;
          add(turn, key, message);
          this.byMessage.set(key, turn);
        }
        for (const turn of segments) turn.outcome = "unknown";
        Object.assign(segments[segments.length - 1]!, { endedAt: saved.endedAt, outcome: saved.outcome,
          toolMs: segments.length === 1 && typeof saved.toolMs === "number" && Number.isFinite(saved.toolMs) && saved.toolMs >= 0
            ? saved.toolMs : undefined });
        for (const turn of segments) {
          finishText(turn);
          for (const id of turn.tools.keys()) this.byTool.set(id, turn);
        }
        legacy = undefined;
      }
    }
  }
}

export const turnStore = liveSlot("turn-store", new TurnStore());
export const turnOptions = liveSlot("turn-presentation-options", {
  collapseTurns: "off" as CollapseTurns,
  frameFinalReply: false,
  /** Down the left edge of a reply's code blocks: the language, then a `copy` chip. */
  codeBlocks: true,
  /** Side-by-side panes for a `diff` code block, as for an edit. */
  splitDiff: true,
  splitDiffMinWidth: 72,
  /** How a drawn final reply looks; `frameFinalReply` says whether it is drawn. */
  replyStyle: "frame" as Exclude<FinalReplyStyle, "off">,
  icons: true,
  assistantColor: "border",
  timeFormat: "auto",
  headerStyle: "inline" as HeaderStyle,
  replyMetrics: false,
});
export function turnFor(message: TurnMessage | undefined): Turn | undefined {
  const key = messageKey(message);
  return key ? turnStore.get().byMessage.get(key) : undefined;
}
export function folded(turn: Turn): boolean {
  const mode = turnOptions.get().collapseTurns;
  return mode !== "off" && (turn.open !== undefined ? !turn.open : mode === "live" || turn.outcome !== "running");
}
export function expandTurnForTool(id: string | undefined, open: boolean): void {
  if (!id || turnOptions.get().collapseTurns === "off") return;
  const turn = turnStore.get().byTool.get(id);
  if (turn) turn.open = open;
}
/** The call belongs to a turn that is open, so it hangs on that turn's rail. */
export function railTurnTool(id: string | undefined): boolean {
  if (!id || turnOptions.get().collapseTurns === "off") return false;
  const turn = turnStore.get().byTool.get(id);
  return !!turn && !folded(turn);
}
export function hideTurnTool(id: string | undefined): boolean {
  if (!id || turnOptions.get().collapseTurns === "off") return false;
  const turn = turnStore.get().byTool.get(id);
  return !!turn && folded(turn);
}
