/**
 * Nested calls: the tool calls a call made on its own behalf.
 *
 * A tool that runs a program (pi's `codemode`, pi-fabric's `fabric_exec`) calls
 * other tools from inside it. Those calls never reach the model as calls of
 * their own, so the transcript has no component for them: the only trace is a
 * record the tool keeps on its own result. tidy reads that record into one
 * shape, `NestedCall`, and everything that shows nested calls — the folded row,
 * the group and turn summaries, the opened call list — draws from that shape
 * alone. Nothing downstream knows which tool, or which record, it came from.
 *
 * A tool counts as one with nested calls when its result carries a record tidy
 * can read; its name plays no part. The records read, richest first:
 *
 * - `details.audits` (pi-fabric): the whole argument object, the result, the
 *   diff a nested `edit` wrote, start and end times;
 * - `details.calls` (pi's `codemode`, and the shape any other tool can write to
 *   get the same treatment): `{ name, args, status, durationMs?, error? }`, plus
 *   `output`, `diff` and `cost` when the tool has them. `args` may be an object
 *   or a JSON string; codemode writes the string, clipped to 200 characters.
 *
 * pi also keeps a record of its own (`nestedCalls` on the tool result message)
 * for any call made through `ctx.executeTool()`: names, statuses and the whole
 * argument object, no output. It does not make a tool one with nested calls —
 * a tool that launches one helper through `executeTool` (pi-subagents does)
 * is not a program, and its row should not turn into a count — but where a
 * `details.calls` entry carries the same id, its clipped arguments are
 * replaced with pi's whole ones.
 */

import { liveSlot } from "../live.ts";

/** How a nested call ended, or that it has not. */
export type NestedStatus = "running" | "ok" | "error" | "cancelled";

export interface NestedCall {
  /** The tool's name, as the program called it. */
  name: string;
  status: NestedStatus;
  /**
   * The arguments: an object when the record kept one, the raw text when all
   * that survived is a clipped JSON string nothing could be read back from.
   */
  args?: Record<string, unknown> | string;
  durationMs?: number;
  /** Why it failed, when it did. */
  error?: string;
  /** The text the call produced, when the record kept it. */
  output?: string;
  /** The unified diff an `edit` wrote, when the record kept it. */
  diff?: string;
  /** What a model call inside the program cost, in dollars. */
  cost?: number;
}

/** What a tool's record says its program did. */
export interface NestedRun {
  calls: NestedCall[];
  /** Calls the record left out to stay bounded, still worth counting. */
  omitted: number;
}

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function status(value: unknown): NestedStatus {
  return value === "error" || value === "cancelled" || value === "running" ? value : "ok";
}

/**
 * The first path-ish argument visible in a clipped JSON string. codemode cuts
 * `args` at 200 characters, so `JSON.parse` fails on the long ones while the
 * key that matters is usually still readable.
 */
const PARTIAL_ARG = /"(command|file_path|filePath|path|pattern|url|query)":\s*"((?:[^"\\]|\\.)*)"?/;

/**
 * `{"command":"pwd"}` → `{ command: "pwd" }`. Parsed when the whole string made
 * it through, otherwise rebuilt from the one key that survived; the raw text
 * when neither works, so the row still says something.
 */
function readArgs(value: unknown): Record<string, unknown> | string | undefined {
  const record = fields(value);
  if (record) return record;
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = fields(JSON.parse(value));
    if (parsed) return parsed;
  } catch {
    const match = PARTIAL_ARG.exec(value);
    if (match) {
      // The value can be cut mid-escape, and codemode marks the cut with `...`;
      // both leave the fragment unparseable on its own.
      const cut = match[2]!.replace(/(?:\\+|\.\.\.)$/, "").replace(/\\+$/, "");
      try {
        return { [match[1]!]: JSON.parse(`"${cut}"`) };
      } catch {
        // Fall through to the raw text.
      }
    }
  }
  return value;
}

/**
 * The trailer bash appends to a failed call's text. Under a nested row the
 * error above it already says what happened; a top-level bash box keeps pi's
 * version, where it is the only report of the exit code.
 */
const BASH_TRAILER = /\n*Command (?:exited with code \d+|terminated)\b[^\n]*\s*$/;

function errorText(name: string, value: unknown): string | undefined {
  const error = text(value);
  if (!error || name !== "bash") return error;
  return text(error.replace(BASH_TRAILER, "").replace(/\s+$/, "")) ?? error;
}

/** `details.calls`: codemode's record, and the shape other tools can write. */
function fromCalls(list: readonly unknown[], host: HostRecord | undefined): NestedCall[] {
  const out: NestedCall[] = [];
  for (const entry of list) {
    const call = fields(entry);
    const name = text(call?.name);
    if (!call || !name) continue;
    const id = text(call.id);
    // pi's own record of the same call keeps the whole argument object.
    const hosted = id ? host?.get(id) : undefined;
    const args = hosted ?? readArgs(call.args);
    const durationMs = number(call.durationMs);
    const error = errorText(name, call.error);
    const output = text(call.output);
    const diff = text(call.diff);
    const cost = number(call.cost);
    out.push({
      name,
      status: status(call.status),
      ...(args === undefined ? {} : { args }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error === undefined ? {} : { error }),
      ...(output === undefined ? {} : { output }),
      ...(diff === undefined ? {} : { diff }),
      ...(cost === undefined || cost <= 0 ? {} : { cost }),
    });
  }
  return out;
}

/**
 * A load of Fabric's own plumbing: a successful `native.load` is how it brings a
 * provider's tools into scope, and its own card leaves them out. Counted here,
 * `fabric_exec` would read as a call the user never asked for.
 */
function isRoutineInternal(audit: Fields): boolean {
  if (audit.ref !== "native.load" || audit.error) return false;
  if (fields(audit.result)?.isError === true) return false;
  return audit.success === true;
}

/**
 * `details.audits`: pi-fabric's record. `success` is absent while a call is
 * still running. An audit rebuilt from fabric's durable trace keeps its
 * arguments but no result: its row reads the same, without a diff or output.
 */
function fromAudits(list: readonly unknown[]): NestedCall[] {
  const out: NestedCall[] = [];
  for (const entry of list) {
    const audit = fields(entry);
    const name = text(audit?.tool);
    if (!audit || !name || isRoutineInternal(audit)) continue;
    const started = number(audit.startedAt);
    const ended = number(audit.endedAt);
    const args = fields(audit.args);
    const error = errorText(name, audit.error);
    const result = fields(audit.result);
    const diff = text(fields(result?.details)?.diff) ?? text(fields(fields(audit.preview)?.details)?.diff);
    const output = text(result?.output);
    out.push({
      name,
      status: audit.success === false ? "error" : audit.success === true ? "ok" : "running",
      ...(args === undefined ? {} : { args }),
      ...(started === undefined || ended === undefined || ended < started ? {} : { durationMs: ended - started }),
      ...(error === undefined ? {} : { error }),
      ...(diff === undefined ? {} : { diff }),
      ...(output === undefined ? {} : { output }),
    });
  }
  return out;
}

/**
 * Calls fabric dropped from a progress update to stay bounded, minus its own
 * plumbing among them: its card subtracts the same ones, and a count that
 * disagreed with the rows would read as a bug.
 */
function omittedCount(details: Fields): number {
  const omitted = fields(details.omittedCalls);
  const count = number(omitted?.count) ?? 0;
  const internal = number(omitted?.internal) ?? 0;
  return Math.max(0, count - internal);
}

/**
 * The nested calls a result records, or undefined when it records none: the
 * tool is then an ordinary one, and keeps its own rendering.
 *
 * `toolCallId` finds pi's own record of the same calls (see the module note);
 * without it the clipped arguments stay as they are.
 */
export function nestedRunOf(details: unknown, toolCallId?: string): NestedRun | undefined {
  const record = fields(details);
  if (!record) return undefined;
  if (Array.isArray(record.audits)) return { calls: fromAudits(record.audits), omitted: omittedCount(record) };
  if (Array.isArray(record.calls)) return { calls: fromCalls(record.calls, hostRecord(toolCallId)), omitted: 0 };
  return undefined;
}

/** The calls alone; empty for a result that records none. */
export function nestedCallsOf(details: unknown, toolCallId?: string): NestedCall[] {
  return nestedRunOf(details, toolCallId)?.calls ?? [];
}

/**
 * The ids a result gives the calls its call made, from the tool's own
 * `details.calls` and from pi's `nestedCalls`. Something launched by one of them
 * names that id as its origin, not the call that ran the program (a sub-agent's
 * notice does, see delegate-notices.ts).
 */
export function nestedCallIds(message: unknown): string[] {
  const result = fields(message);
  const ids = new Set<string>();
  for (const list of [fields(result?.details)?.calls, fields(result?.nestedCalls)?.calls]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const id = text(fields(entry)?.id);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Whether a nested call ended badly: failed, or stopped before it finished. */
export function nestedCallFailed(call: NestedCall): boolean {
  return call.status === "error" || call.status === "cancelled";
}

// ═══════════════════════════════════════════════════════════════════════════
// pi's own record
// ═══════════════════════════════════════════════════════════════════════════

/** pi's `nestedCalls` for one tool call: arguments by nested call id. */
type HostRecord = ReadonlyMap<string, Record<string, unknown>>;

/** Every tool result's `nestedCalls` seen this session, by the tool call's id. */
const hostRecords = liveSlot("nested-call-host-records", new Map<string, HostRecord>());

/**
 * pi's record for one tool call, if it has arrived. Its identity changes when it
 * does, so a cache over a call's list can key on it: the record lands on
 * `message_start` of the result, after the box was first drawn from the result.
 */
export function hostRecord(toolCallId: string | undefined): HostRecord | undefined {
  return toolCallId ? hostRecords.get().get(toolCallId) : undefined;
}

/**
 * Keep pi's record of a tool result's nested calls. pi attaches it to the
 * message on `message_start`; a restored session carries it on the stored
 * message. Only the arguments are kept: everything else the tool's own record
 * says as well.
 */
export function noteHostRecord(message: unknown): void {
  const result = fields(message);
  if (result?.role !== "toolResult") return;
  const id = text(result.toolCallId);
  const calls = fields(result.nestedCalls)?.calls;
  if (!id || !Array.isArray(calls)) return;
  const args = new Map<string, Record<string, unknown>>();
  for (const entry of calls) {
    const call = fields(entry);
    const callId = text(call?.id);
    const callArgs = fields(call?.arguments);
    if (callId && callArgs) args.set(callId, callArgs);
  }
  if (args.size > 0) hostRecords.get().set(id, args);
}

/** Forget every record: a new session, or another branch of this one. */
export function resetHostRecords(entries: readonly unknown[] = []): void {
  hostRecords.set(new Map());
  for (const entry of entries) {
    const record = fields(entry);
    if (record?.type === "message") noteHostRecord(record.message);
  }
}
