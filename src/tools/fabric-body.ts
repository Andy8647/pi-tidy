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

import type { ThemeLike } from "../theme-access.ts";
import {
  alignCallRows,
  foldRow,
  plural,
  ruleRow,
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
/** Rows of a call's own output an expanded box draws. */
const OUTPUT_LINES_MAX = 200;

export interface FabricBodyInput {
  /** The call's arguments: the program, and any payloads it refers to. */
  args: unknown;
  /** The execution details: the audits, the omission count, the failure. */
  details: unknown;
  /** The text the program returned to the model. */
  output: string;
  /** Whether the box itself is expanded: diffs and output rows follow it. */
  expanded: boolean;
  /** Rows a nested diff may take while the box is not expanded. */
  diffLines: number;
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

function omittedCount(details: unknown): number {
  const count = fields(fields(details)?.omittedCalls)?.count;
  return typeof count === "number" && count > 0 ? count : 0;
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
function unifiedDiff(diff: string, theme: ThemeLike, maxLines: number | undefined): string[] {
  const lines = diff.split("\n");
  return (maxLines === undefined ? lines : lines.slice(0, maxLines)).map((line) =>
    theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line || " "),
  );
}

/** The diff this audit wrote, in the panes an `edit` box uses. */
function diffRows(call: NestedCall, input: FabricBodyInput): string[] {
  const diff = call.diff;
  if (!diff) return [];
  const maxLines = input.expanded ? undefined : input.diffLines;
  const path = fields(call.args)?.path;
  const width = input.options.width;
  const split = width === undefined
    ? undefined
    : renderSplitDiff({
        diff,
        width: Math.max(1, width - DETAIL_INDENT),
        theme: input.theme,
        ...(typeof path === "string" ? { filePath: path } : {}),
        ...(maxLines === undefined ? {} : { maxLines }),
      });
  // The panes carry their own colours and tints: only the fallback needs one.
  return indent(split?.lines ?? unifiedDiff(diff, input.theme, maxLines), DETAIL_INDENT);
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
function callRows(calls: readonly NestedCall[], input: FabricBodyInput): string[] {
  const { theme, options, expanded } = input;
  const built: Array<{ row: string; under: string[] }> = [];
  for (const call of calls) {
    const [row] = formatToolRows(
      {
        toolName: call.name,
        args: call.args,
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
    if (call.status === "error" && call.error) under.push(...painted(call.error.split("\n"), ERROR_INDENT, theme, "error"));
    under.push(...diffRows(call, input));
    // A call that failed already says why; a report about the call says nothing.
    if (expanded && call.output && call.status !== "error" && !QUIET_RESULT.has(call.name)) {
      under.push(...painted(call.output.split("\n").slice(0, OUTPUT_LINES_MAX), DETAIL_INDENT, theme, "toolOutput"));
    }
    built.push({ row: row!, under });
  }
  // The durations share one column across the call rows only: a diff row has no
  // duration to line up, and its length would push the column off the body.
  const aligned = alignCallRows(built.map((each) => each.row), options.width);
  const rows: string[] = [];
  built.forEach((each, index) => {
    rows.push(aligned[index]!);
    for (const line of each.under) rows.push(line);
  });
  return rows;
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
  const callsList = callRows(calls, input);
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
  return { lines: rows, toggles };
}
