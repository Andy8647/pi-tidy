/**
 * The calls a tool made on its own behalf.
 *
 * A wrapper's calls never reach the model as calls of their own, so the record
 * rides on the parent's result instead, in one of two shapes:
 *
 * - pi's `codemode` writes `details.calls`: `{ name, args, status, durationMs }`,
 *   the arguments as `JSON.stringify` clipped to 200 characters and no result;
 * - pi-fabric's `fabric_exec` writes `details.audits`: `{ ref, tool, args, result,
 *   success, startedAt, endedAt }`, the whole argument object and what the call
 *   returned — which is the only place a nested `edit`'s diff exists.
 *
 * Both are read here as one list. The folded row, the group summary and the
 * opened body all count the same calls, and nothing else in the transcript
 * knows they happened.
 */

/** How a nested call ended, in pi's terms. */
export type NestedStatus = "ok" | "error" | "cancelled" | "running";

export interface NestedCall {
  /** The tool's name, as the wrapper named it. */
  name: string;
  /** The arguments as recorded: an object (fabric), or pi's clipped JSON string. */
  args: unknown;
  status: NestedStatus;
  durationMs?: number;
  error?: string;
  /** The unified diff an `edit` wrote, when the record kept the result. */
  diff?: string;
  /** The text the call produced, when the record kept it. */
  output?: string;
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

/** pi's record: the arguments survive as a clipped JSON string, nothing else does. */
function fromCalls(details: Fields): NestedCall[] {
  const out: NestedCall[] = [];
  for (const entry of details.calls as unknown[]) {
    const call = fields(entry);
    const name = text(call?.name);
    if (!call || !name) continue;
    const status = call.status;
    const durationMs = number(call.durationMs);
    const error = text(call.error);
    out.push({
      name,
      args: typeof call.args === "string" ? call.args : "",
      status: status === "error" ? "error" : status === "cancelled" ? "cancelled" : status === "running" ? "running" : "ok",
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error === undefined ? {} : { error }),
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

/** Where an audit keeps the unified diff of the edit it ran, if it ran one. */
function auditDiff(audit: Fields): string | undefined {
  const result = fields(audit.result);
  const kept = text(fields(result?.details)?.diff) ?? text(fields(fields(audit.preview)?.details)?.diff);
  return kept;
}

/**
 * pi-fabric's record. `success` is absent while a call is still running, and an
 * audit rebuilt from the durable trace (after a reload) keeps its arguments but
 * no result: its rows read the same, only the diff and the output are gone.
 */
function fromAudits(details: Fields): NestedCall[] {
  const out: NestedCall[] = [];
  for (const entry of details.audits as unknown[]) {
    const audit = fields(entry);
    const name = text(audit?.tool);
    if (!audit || !name || isRoutineInternal(audit)) continue;
    const started = number(audit.startedAt);
    const ended = number(audit.endedAt);
    const error = text(audit.error);
    const diff = auditDiff(audit);
    const output = text(fields(audit.result)?.output);
    out.push({
      name,
      args: audit.args,
      status: audit.success === false ? "error" : audit.success === true ? "ok" : "running",
      ...(started === undefined || ended === undefined || ended < started ? {} : { durationMs: ended - started }),
      ...(error === undefined ? {} : { error }),
      ...(diff === undefined ? {} : { diff }),
      ...(output === undefined ? {} : { output }),
    });
  }
  return out;
}

/**
 * The calls a result records, whichever shape it uses. Empty for a tool that
 * records none and for a wrapper whose script called nothing: the callers then
 * keep pi's own rendering rather than inventing rows.
 */
export function nestedCallsOf(details: unknown): NestedCall[] {
  const record = fields(details);
  if (!record) return [];
  if (Array.isArray(record.calls)) return fromCalls(record);
  if (Array.isArray(record.audits)) return fromAudits(record);
  return [];
}
