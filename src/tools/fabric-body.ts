/**
 * The body a `fabric_exec` box shows: the program, the calls it made and what
 * it returned, as tidy rows.
 *
 * pi-fabric draws these rows itself, but a box inside a group has to read as a
 * call list: one row per call, the program and the output folded to one row
 * each. Nothing is parsed back out of fabric's rendering — its record carries
 * the whole argument object and the result — so the rows are built from that,
 * and a nested `edit` keeps the diff it wrote under its own row.
 */

import { shortenPath } from "../draw/frame-draw.ts";
import type { ThemeLike } from "../theme-access.ts";
import {
  alignCallRows,
  foldRow,
  plural,
  ruleRow,
  type CodemodeBodyFill,
  type CodemodeBodyOptions,
  type CodemodeSections,
  type CodemodeToggle,
  type ComposedCodemodeBody,
} from "./codemode-body.ts";
import { nestedCallsOf, type NestedCall } from "./nested-calls.ts";
import { renderSplitDiff } from "./split-diff.ts";
import { formatToolRows } from "./tool-lines.ts";

/** Tools whose result is a report about the call, not something to read. */
const QUIET_RESULT = new Set(["edit", "write"]);

/** Cells a nested diff or output hangs in from its call's row. */
const DETAIL_INDENT = 2;
/** Cells a failed call's text hangs in: the width of pi's own error block. */
const ERROR_INDENT = 4;

export interface FabricBodyInput {
  /** The call's arguments: the program, and any payloads it refers to. */
  args: unknown;
  /** The execution details: the audits, the omission count, the failure. */
  details: unknown;
  /** The text the program returned to the model. */
  output: string;
  /**
   * Rows a nested diff may take. Opening a call to read its list must not put a
   * four-hundred-line rewrite on screen, and the diff's own header row already
   * says how big it was: a window is the same one an edit box shows collapsed.
   */
  diffLines: number;
  /** Rows of a call's own output to keep under its row, the way a bash box keeps `bashResultLines` of its own. */
  outputLines: number;
  /** Which of the two folds the reader opened. */
  state: CodemodeSections;
  theme: ThemeLike;
  options: CodemodeBodyOptions;
}

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** The program the model wrote. Empty while the call's arguments are still arriving. */
function programLines(args: unknown): string[] {
  const code = fields(args)?.code;
  const text = Array.isArray(code) ? code.join("\n") : typeof code === "string" ? code : "";
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.trim() ? trimmed.split("\n") : [];
}

/**
 * Calls a progress update left out to stay bounded, minus the internal plumbing
 * among them: fabric's own card subtracts the same ones, and a count that
 * disagreed with the rows above it would read as a bug.
 */
function omittedCount(details: unknown): number {
  const omitted = fields(fields(details)?.omittedCalls);
  const count = typeof omitted?.count === "number" ? omitted.count : 0;
  const internal = typeof omitted?.internal === "number" ? omitted.internal : 0;
  return Math.max(0, count - internal);
}

/** One row per line, hanging `cells` in from the row above it. */
function indent(lines: readonly string[], cells: number): string[] {
  const pad = " ".repeat(cells);
  return lines.map((line) => pad + line);
}

/** The same, painted: text took no colour of its own. */
function painted(lines: readonly string[], cells: number, theme: ThemeLike, token: string): string[] {
  return indent(lines.map((line) => theme.fg(token, line || " ")), cells);
}

/**
 * pi's unified diff, coloured the way an edit box colours it: what a nested
 * edit gets on a box too narrow for the side-by-side panes.
 */
function unifiedDiff(diff: string, theme: ThemeLike, maxLines: number): string[] {
  return diff.split("\n").slice(0, maxLines).map((line) =>
    theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line || " "),
  );
}

/** The diff this audit wrote, in the panes an `edit` box uses, and the rows that carry a fill. */
function diffRows(call: NestedCall, input: FabricBodyInput): { rows: string[]; fills: number[] } {
  const diff = call.diff;
  if (!diff) return { rows: [], fills: [] };
  const maxLines = Math.max(1, input.diffLines);
  const path = fields(call.args)?.path;
  const width = input.options.width;
  const split = width === undefined
    ? undefined
    : renderSplitDiff({
        diff,
        width: Math.max(1, width - DETAIL_INDENT),
        theme: input.theme,
        ...(typeof path === "string" ? { filePath: path } : {}),
        maxLines,
        hint: false,
      });
  // The panes carry their own colours and tints: only the fallback needs one.
  // The panes pad themselves by a cell, as a box's body does; this block is not
  // inside a box, so that cell comes off and the diff starts where the call's
  // own output does.
  const raw = split?.lines ?? unifiedDiff(diff, input.theme, maxLines);
  const lines = split ? raw.map((line) => line.slice(1)) : raw;
  return { rows: lines, fills: split?.bgRows ?? [] };
}

/** A call's arguments as a record: every paper trail here records an object. */
type CallArgs = Record<string, unknown>;

/** The call's arguments with `$HOME` shortened: a project path eats a row otherwise. */
function rowArgs(args: unknown): CallArgs {
  const record = fields(args) ?? {};
  const path = record.path;
  if (typeof path !== "string") return record;
  const short = shortenPath(path);
  return short === path ? record : { ...record, path: short };
}

/**
 * What a call produced, as many rows as a bash box keeps of its own output, and
 * a count of what the window left out: a `read` of a long file is one row here,
 * not the file.
 */
function outputRows(output: string, input: FabricBodyInput): string[] {
  // The trailing newline a tool's output ends with is not a line: counted, the
  // row would promise one more than the note beside it does.
  const lines = output.replace(/\s+$/, "").split("\n");
  const keep = Math.max(1, input.outputLines);
  const rows = painted(lines.slice(0, keep), DETAIL_INDENT, input.theme, "toolOutput");
  if (lines.length > keep) rows.push(...painted([`… ${plural(lines.length - keep, "more line")}`], DETAIL_INDENT, input.theme, "dim"));
  return rows;
}

/**
 * One row per call, in the order the calls were made.
 *
 * The row is the one a group draws for a top-level call, built from the audit
 * instead of a ToolExecutionComponent: `summarizeArgs` reads the audit's own
 * argument object, so `bash` shows its command and `read` its path. What hangs
 * under it — a failure's text, an edit's diff — is drawn only when there is
 * something there.
 */
function callRows(calls: readonly NestedCall[], input: FabricBodyInput): { rows: string[]; fills: number[] } {
  const { theme, options } = input;
  const built: Array<{ row: string; under: string[]; fills: number[] }> = [];
  for (const call of calls) {
    const [row] = formatToolRows(
      {
        toolName: call.name,
        args: rowArgs(call.args),
        isPartial: call.status === "running",
        result: {
          isError: call.status === "error",
          ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
          content: call.output === undefined ? [] : [{ type: "text" as const, text: call.output }],
        },
      },
      theme,
      { icons: options.icons, width: options.width },
    );
    const under: string[] = [];
    const fills: number[] = [];
    if (call.status === "error" && call.error) under.push(...painted(call.error.split("\n"), ERROR_INDENT, theme, "error"));
    // What hangs under a call sits on the same column its output does: two cells
    // in, the way an edit box hangs its diff under its own call row.
    const diff = diffRows(call, input);
    for (const row of diff.fills) fills.push(under.length + row);
    under.push(...indent(diff.rows, DETAIL_INDENT));
    // A call that failed already says why; a report about the call says nothing.
    if (call.output && call.status !== "error" && !QUIET_RESULT.has(call.name)) {
      under.push(...outputRows(call.output, input));
    }
    built.push({ row: row!, under, fills });
  }
  // The durations share one column across the call rows only: a diff row has no
  // duration to line up, and its length would push the column off the body.
  const aligned = alignCallRows(built.map((each) => each.row), options.width);
  const rows: string[] = [];
  const fills: number[] = [];
  built.forEach((each, index) => {
    const at = rows.length;
    rows.push(aligned[index]!);
    for (const row of each.fills) fills.push(at + 1 + row);
    for (const line of each.under) rows.push(line);
  });
  return { rows, fills };
}

/**
 * The composed body: the program, the calls, and the output, each with its own
 * fold row. The caller drops it when there is nothing to draw and keeps pi's
 * own body instead.
 */
export function composeFabricBody(input: FabricBodyInput): ComposedCodemodeBody {
  const { details, state, theme, options } = input;
  const script = programLines(input.args);
  const calls = nestedCallsOf(details);
  const callsBlock = callRows(calls, input);
  const callsList = callsBlock.rows;
  const omitted = omittedCount(details);
  const failure = fields(details)?.error;
  const output = input.output.replace(/\s+$/, "");
  const outputLines = output ? output.split("\n") : [];
  const rule = ruleRow(theme, options.width);

  const rows: string[] = [];
  const toggles: CodemodeToggle[] = [];
  if (script.length > 0) {
    toggles.push({ row: rows.length, section: "script" });
    rows.push(foldRow(state.script, options.hovered === "script", "script", plural(script.length, "line"), theme));
    if (state.script) rows.push(...painted(script, 0, theme, "toolOutput"));
    // The rule closes a block of calls; with no calls it has nothing to close.
    if (rule !== undefined && callsList.length > 0) rows.push(rule);
  }
  const callsAt = rows.length;
  rows.push(...callsList);
  if (omitted > 0) rows.push(` ${theme.fg("dim", `… ${plural(omitted, "more call")}`)}`);
  if (typeof failure === "string" && failure) {
    const lines = failure.split("\n");
    rows.push(` ${theme.fg("error", `✗ ${lines[0]}`)}`);
    rows.push(...painted(lines.slice(1), 3, theme, "error"));
  }
  if (outputLines.length > 0) {
    if (rule !== undefined && (callsList.length > 0 || script.length > 0)) rows.push(rule);
    toggles.push({ row: rows.length, section: "output" });
    rows.push(foldRow(state.output, options.hovered === "output", "output", plural(outputLines.length, "line"), theme));
    if (state.output) rows.push(...painted(outputLines, 0, theme, "toolOutput"));
  }
  const fills: CodemodeBodyFill[] = callsBlock.fills.map((row) => ({ row: callsAt + row }));
  return { lines: rows, toggles, ...(fills.length > 0 ? { fills } : {}) };
}
