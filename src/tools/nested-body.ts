/**
 * The body of a call with nested calls, opened: its program, the calls the
 * program made, and what it returned.
 *
 * Everything here is drawn from the record (see nested-calls.ts), never from
 * the tool's own rendering, so `codemode`, `fabric_exec` and any tool that
 * writes the same record read as the same list:
 *
 * ```
 *  ▸ script · 3 lines                 one row, opens on click
 *  ──────────────────────────
 *  ✓ bash  npm test       2.1s        one row per call, a name and a duration column
 *  ✗ read  src/gone.ts    1ms
 *      ENOENT: no such file           why it failed, under its row
 *  ✓ edit  src/app.ts     4ms
 *    old        │ new                 the diff an edit wrote, when the record kept it
 *  ──────────────────────────
 *  ▸ output · 2 items                 one row, opens on click
 * ```
 *
 * The output is one block on purpose. A program builds what it returns from
 * whatever it computed, so a line of it can be a summary of several calls;
 * nothing ties it back to the call that fed it.
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipToWidth, rawIndexOfVisible, shortenPath, trimTrailingSpaces, visibleText } from "../draw/frame-draw.ts";
import { toolKindIcon } from "../draw/icons.ts";
import type { ThemeLike } from "../theme-access.ts";
import { highlightLines } from "./lang-support.ts";
import type { NestedCall, NestedRun } from "./nested-calls.ts";
import { renderSplitDiff } from "./split-diff.ts";
import { trimDiffContext } from "./diff-context.ts";
import { summarizeArgs, summarizeResult, toolColor } from "./tool-lines.ts";
import { paint } from "../draw/paint.ts";

// ═══════════════════════════════════════════════════════════════════════════
// The two folds
// ═══════════════════════════════════════════════════════════════════════════

/** The two parts of the body that open on their own row. */
export type NestedSection = "script" | "output";

/** Which sections the reader has opened. Closed is the default: a call list. */
export interface NestedSections {
  script: boolean;
  output: boolean;
}

// Per tool box, so a `/reload` or a re-render does not reset what the reader opened.
const sectionState = new WeakMap<object, NestedSections>();

/** The open/closed state of a box's folded sections. */
export function nestedSections(tool: object): NestedSections {
  let state = sectionState.get(tool);
  if (!state) {
    state = { script: false, output: false };
    sectionState.set(tool, state);
  }
  return state;
}

/** Flip one section. Returns its new state. */
export function toggleNestedSection(tool: object, section: NestedSection): boolean {
  const state = nestedSections(tool);
  state[section] = !state[section];
  return state[section];
}

/** A row the reader can click: the fold label of one section. */
export interface NestedToggle {
  /** Index in the composed lines. */
  row: number;
  section: NestedSection;
}

export interface NestedBodyOptions {
  /** Put the kind icon in front of every nested tool's name. */
  icons: boolean;
  /** Cells the rows may occupy. */
  width?: number;
  /** The fold row the pointer is on, so it can read as clickable. */
  hovered?: NestedSection;
}

export interface ComposedNestedBody {
  lines: string[];
  toggles: NestedToggle[];
  /** Rows whose background fill belongs to the content (a diff's tint), so the frame keeps it. */
  fills: number[];
}

/**
 * `▸ script · 13 lines` / `▾ output · 4 items`. The leading cell matches the
 * one every call row starts with, so the fold glyph lines up under a status.
 */
export function foldRow(open: boolean, hovered: boolean, label: string, meta: string, theme: ThemeLike): string {
  // Same three signals as the group's rows: open, hovered, neither.
  const glyph = theme.fg("accent", open ? "▾" : hovered ? "▶" : "▸");
  return ` ${glyph} ${theme.fg("muted", label)}${theme.fg("dim", ` · ${meta}`)}`;
}

/** A dim rule across the body, so the sections read as sections. */
export function ruleRow(theme: ThemeLike, width: number | undefined): string | undefined {
  if (!width || width < 6) return undefined;
  return ` ${theme.fg("borderMuted", "─".repeat(Math.max(1, width - 1)))}`;
}

/** `1 line`, `3 lines`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ═══════════════════════════════════════════════════════════════════════════
// Call rows
// ═══════════════════════════════════════════════════════════════════════════

/** Cells the name column may take before the arguments stop paying. */
const NAME_COLUMN_MAX = 14;
/** Cells between the longest arguments and the duration column. */
const DURATION_GAP = 2;
/** Cells a failure's text hangs in under its row: four past the row's own leading cell. */
const ERROR_INDENT = 5;
/** Cells a call's diff or output hangs in under its row. */
const DETAIL_INDENT = 2;
/** Tools whose result is a report about the call, not something to read. */
const QUIET_RESULT = new Set(["edit", "write"]);

/** The trailing `50ms` / `1.8s` of a call row, if it has one. */
const DURATION_TAIL = /(\d+(?:\.\d+)?(?:ms|s))$/;
/** The SGR escapes a raw string ends with. */
const OPENERS_BEFORE = /(?:\x1b\[[0-9;:]*m)+$/;

/** `50ms` under a second, `1.8s` above: a nested call is often a few milliseconds. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusGlyph(call: NestedCall, theme: ThemeLike): string {
  switch (call.status) {
    case "running":
      return theme.fg("warning", "…");
    case "error":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("muted", "⊘");
    default:
      return theme.fg("success", "✓");
  }
}

/** The arguments as the record kept them, with `$HOME` shortened: a project path eats a row otherwise. */
function argsText(call: NestedCall, budget: number): string {
  const args = call.args;
  if (typeof args === "string") return clipToWidth(args, budget, "…");
  if (!args) return "";
  const path = args.path;
  const shown = typeof path === "string" && shortenPath(path) !== path ? { ...args, path: shortenPath(path) } : args;
  return summarizeArgs(call.name, shown, budget);
}

/** The text of a call row without its padding, and without its duration. */
function argumentsWidth(line: string): number {
  const body = visibleText(line).trimEnd();
  const match = DURATION_TAIL.exec(body);
  return match ? visibleWidth(body.slice(0, match.index)) : visibleWidth(body);
}

/**
 * Put a row's duration in the column the call rows share, `DURATION_GAP` cells
 * past the longest arguments — not against the body's right edge, where on a
 * wide terminal it reads as part of another column.
 */
function alignDuration(line: string, target: number): string {
  const match = DURATION_TAIL.exec(visibleText(line).trimEnd());
  if (!match) return line;
  const pad = target + DURATION_GAP - argumentsWidth(line);
  if (pad <= 0) return line;
  const from = rawIndexOfVisible(line, match.index);
  if (from < 0) return line;
  return trimTrailingSpaces(line.slice(0, from)) + " ".repeat(pad) + trimTrailingSpaces(line.slice(from));
}

/**
 * Make a row fit `width` while keeping its duration: the arguments give way,
 * and two cells of air stay in front of the metrics.
 */
function clipRow(line: string, width: number): string {
  const body = visibleText(line).trimEnd();
  if (visibleWidth(body) <= width) return line;
  const match = DURATION_TAIL.exec(body);
  const at = match ? rawIndexOfVisible(line, match.index) : -1;
  if (at < 0) return clipToWidth(line, width, "…");
  // The duration's colour opens right in front of it: it goes with the
  // duration, or the clip takes it and the duration reads like the arguments.
  const from = at - (OPENERS_BEFORE.exec(line.slice(0, at))?.[0].length ?? 0);
  const tail = trimTrailingSpaces(line.slice(from));
  const room = Math.max(8, width - visibleWidth(visibleText(tail)) - 2);
  return `${clipToWidth(line.slice(0, from).trimEnd(), room, "…")}  ${tail}`;
}

/** One column for the durations: as far right as the longest arguments reach, never past the row. */
function alignCallRows(rows: readonly string[], width: number | undefined): string[] {
  let target = 0;
  let widestDuration = 0;
  for (const row of rows) {
    target = Math.max(target, argumentsWidth(row));
    const match = DURATION_TAIL.exec(visibleText(row).trimEnd());
    if (match) widestDuration = Math.max(widestDuration, visibleWidth(match[1]!));
  }
  if (width) target = Math.min(target, Math.max(8, width - DURATION_GAP - widestDuration));
  return rows.map((row) => {
    const aligned = alignDuration(row, target);
    return width ? clipRow(aligned, width) : aligned;
  });
}

/** ` ✓ 󰆍 bash   pwd  50ms`: status, name on its column, arguments, what it produced, how long. */
function callRow(call: NestedCall, nameWidth: number, theme: ThemeLike, options: NestedBodyOptions): string {
  const icon = options.icons ? `${toolKindIcon(call.name)} ` : "";
  const pad = " ".repeat(Math.max(0, nameWidth - call.name.length));
  // What the arguments may use: the row, minus the name, the kind icon and the metrics.
  const budget = Math.max(8, (options.width ?? 100) - Math.max(nameWidth, call.name.length) - 14);
  const args = argsText(call, budget);
  const note = call.output && call.status !== "error" ? summarizeResult(call.name, { content: [{ type: "text", text: call.output }] }) : "";
  const duration = formatDuration(call.durationMs);
  let row = ` ${statusGlyph(call, theme)} ${paint(theme, toolColor(call.name), `${icon}${call.name}`)}${pad}`;
  if (args) row += ` ${theme.fg("muted", args)}`;
  if (note) row += ` ${theme.fg("muted", note)}${duration ? theme.fg("muted", " ·") : ""}`;
  if (duration) row += ` ${theme.fg("dim", duration)}`;
  return row;
}

/** Lines wrapped to `width` and hung `cells` in, each painted with `token` when given. */
function hang(lines: readonly string[], cells: number, width: number | undefined, theme: ThemeLike, token?: string): string[] {
  const pad = " ".repeat(cells);
  const room = width === undefined ? undefined : Math.max(1, width - cells);
  return lines.flatMap((line) => {
    const painted = token ? theme.fg(token, line || " ") : line;
    const rows = room === undefined ? [painted] : wrapTextWithAnsi(painted, room);
    return (rows.length > 0 ? rows : [""]).map((row) => pad + row);
  });
}

/**
 * The diff an edit wrote: the panes an `edit` box uses, or the unified lines on
 * a body too narrow for them. Kept to `diffLines` rows, the rest counted:
 * opening a call to read its list must not put a four-hundred-line rewrite on
 * screen, and the diff's own header already says how big it was.
 */
function diffRows(call: NestedCall, input: NestedBodyInput): { rows: string[]; fills: number[] } {
  if (!call.diff) return { rows: [], fills: [] };
  const diff = trimDiffContext(call.diff, input.diffContext);
  const maxLines = Math.max(1, input.diffLines);
  const width = input.options.width;
  const path = typeof call.args === "object" ? call.args.path : undefined;
  const split = width === undefined || !input.splitDiff || width - DETAIL_INDENT < input.splitDiffMinWidth
    ? undefined
    : renderSplitDiff({
        diff,
        width: Math.max(1, width - DETAIL_INDENT),
        theme: input.theme,
        ...(typeof path === "string" ? { filePath: path } : {}),
        maxLines,
        hint: false,
      });
  if (split) {
    // The panes pad themselves by a cell, as a box's body does; this block is
    // not inside a box, so that cell comes off and the diff starts where the
    // call's output does.
    return { rows: split.lines.map((line) => " ".repeat(DETAIL_INDENT) + line.slice(1)), fills: [...split.bgRows] };
  }
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines).map((line) =>
    input.theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line || " "),
  );
  const rows = hang(shown, DETAIL_INDENT, width, input.theme);
  if (lines.length > maxLines) rows.push(...hang([`… ${plural(lines.length - maxLines, "more line")}`], DETAIL_INDENT, width, input.theme, "dim"));
  return { rows, fills: [] };
}

/**
 * What a call produced, as many rows as a bash box keeps of its own output,
 * and a count of what was left out: a `read` of a long file is one row here.
 */
function outputRows(output: string, input: NestedBodyInput): string[] {
  const lines = output.replace(/\s+$/, "").split("\n");
  const keep = Math.max(1, input.outputLines);
  const rows = hang(lines.slice(0, keep), DETAIL_INDENT, input.options.width, input.theme, "toolOutput");
  if (lines.length > keep) rows.push(...hang([`… ${plural(lines.length - keep, "more line")}`], DETAIL_INDENT, input.options.width, input.theme, "dim"));
  return rows;
}

/** One row per call, in the order they ran, with what hangs under each. */
function callBlock(calls: readonly NestedCall[], input: NestedBodyInput): { rows: string[]; fills: number[] } {
  const { theme, options } = input;
  const nameWidth = Math.min(NAME_COLUMN_MAX, calls.reduce((max, call) => Math.max(max, call.name.length), 0));
  const built = calls.map((call) => {
    const under: string[] = [];
    const fills: number[] = [];
    if (nestedFailedWithText(call)) under.push(...hang(call.error!.split("\n"), ERROR_INDENT, options.width, theme, "error"));
    const diff = diffRows(call, input);
    for (const row of diff.fills) fills.push(under.length + row);
    under.push(...diff.rows);
    // A call that failed already says why; a report about the call says nothing.
    if (call.output && call.status !== "error" && !QUIET_RESULT.has(call.name)) under.push(...outputRows(call.output, input));
    return { row: callRow(call, nameWidth, theme, options), under, fills };
  });
  // The durations share one column across the call rows only: a diff row has no
  // duration to line up, and its length would push the column off the body.
  const aligned = alignCallRows(built.map((each) => each.row), options.width);
  const rows: string[] = [];
  const fills: number[] = [];
  built.forEach((each, index) => {
    const at = rows.length;
    rows.push(aligned[index]!);
    for (const row of each.fills) fills.push(at + 1 + row);
    rows.push(...each.under);
  });
  return { rows, fills };
}

function nestedFailedWithText(call: NestedCall): boolean {
  return call.status === "error" && !!call.error;
}

/** `Model calls · $0.04`, when the program paid for more than one model call (pi's codemode says the same). */
function costRow(calls: readonly NestedCall[], theme: ThemeLike): string | undefined {
  const priced = calls.filter((call) => call.cost !== undefined);
  if (priced.length < 2) return undefined;
  const total = priced.reduce((sum, call) => sum + call.cost!, 0);
  const cost = `$${total >= 0.01 ? total.toFixed(2) : total.toPrecision(2)}`;
  return ` ${theme.fg("dim", `model calls · ${cost}`)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// The program and its output
// ═══════════════════════════════════════════════════════════════════════════

/** The program: `args.code`, as a string or a list of lines. Empty while it is still arriving. */
function programText(args: unknown): string {
  const code = (args as { code?: unknown } | undefined)?.code;
  const text = Array.isArray(code) ? code.join("\n") : typeof code === "string" ? code : "";
  return text.replace(/\r/g, "").replace(/\s+$/, "");
}

/** codemode opens its result with how the run went; the row above the body says that already. */
const RUN_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n\n?/;
/** codemode marks each of several returned values; the fold row counts them instead. */
const TEXT_ITEM = /^==> text \d+\/\d+ <==$/;

/**
 * The output as items: a program that returned several values separates them
 * with `==> text N/M <==` markers, which become blank rows (the fold row counts
 * them); anything else is one item.
 */
function outputItems(output: string): { lines: string[]; items: number } {
  const lines: string[] = [];
  let items = 0;
  for (const line of output.split("\n")) {
    if (TEXT_ITEM.test(line.trim())) {
      if (lines.length > 0) lines.push("");
      items++;
      continue;
    }
    lines.push(line);
  }
  return { lines, items };
}

export interface NestedBodyInput {
  /** The call's arguments: the program is `args.code`. */
  args: unknown;
  run: NestedRun;
  /** The text the call returned to the model. */
  output: string;
  /** Why the whole program failed, when the tool says so apart from its output. */
  failure?: string;
  /** The call failed: its output takes the error colour. */
  isError: boolean;
  /** Rows a nested diff may take. */
  diffLines: number;
  /** Unchanged lines kept on each side of a change (`diffContext`). */
  diffContext: number;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  /** Rows of a call's own output kept under its row (`bashResultLines`). */
  outputLines: number;
  state: NestedSections;
  theme: ThemeLike;
  options: NestedBodyOptions;
}

/** Whether there is anything to list yet: a program still being written has neither calls nor output. */
export function hasNestedBody(run: NestedRun, output: string): boolean {
  return run.calls.length > 0 || run.omitted > 0 || output.replace(RUN_HEADER, "").trim() !== "";
}

/** The composed body: the program, the calls and the output, the two ends folded to a row each. */
export function composeNestedBody(input: NestedBodyInput): ComposedNestedBody {
  const { run, state, theme, options } = input;
  const program = programText(input.args);
  const script = program ? highlightLines(program, "typescript", theme) : [];
  const calls = callBlock(run.calls, input);
  const cost = costRow(run.calls, theme);
  const { lines: outputLines, items } = outputItems(input.output.replace(RUN_HEADER, "").replace(/\s+$/, ""));
  const output = outputLines.some((line) => line.trim()) ? outputLines : [];
  const rule = ruleRow(theme, options.width);

  const rows: string[] = [];
  const toggles: NestedToggle[] = [];
  if (script.length > 0) {
    toggles.push({ row: rows.length, section: "script" });
    rows.push(foldRow(state.script, options.hovered === "script", "script", plural(script.length, "line"), theme));
    if (state.script) rows.push(...hang(script, 1, options.width, theme));
    // The rule closes a block of calls; with no calls it has nothing to close.
    if (rule !== undefined && calls.rows.length > 0) rows.push(rule);
  }
  const callsAt = rows.length;
  rows.push(...calls.rows);
  if (run.omitted > 0) rows.push(` ${theme.fg("dim", `… ${plural(run.omitted, "more call")}`)}`);
  if (cost) rows.push(cost);
  if (input.failure) {
    const [first, ...rest] = input.failure.split("\n");
    rows.push(...hang([`✗ ${first}`], 1, options.width, theme, "error"), ...hang(rest, 3, options.width, theme, "error"));
  }
  if (output.length > 0) {
    if (rule !== undefined && rows.length > 0) rows.push(rule);
    toggles.push({ row: rows.length, section: "output" });
    const meta = items > 1 ? plural(items, "item") : plural(output.length, "line");
    rows.push(foldRow(state.output, options.hovered === "output", "output", meta, theme));
    if (state.output) rows.push(...hang(output, 1, options.width, theme, input.isError ? "error" : "toolOutput"));
  }
  return { lines: rows, toggles, fills: calls.fills.map((row) => callsAt + row) };
}
