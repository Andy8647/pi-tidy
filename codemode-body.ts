/**
 * The decorations a `codemode` box's body gets from tidy.
 *
 * A script's nested calls are not tool components: pi renders them as plain
 * rows inside the parent's result — status glyph, tool name, the arguments as
 * compact JSON, the duration. tidy does not take the renderer over, so it
 * works on the rendered rows and on `result.details.calls`, which is the same
 * list in the same order:
 *
 * - each nested tool's name takes the kind icon the outer tool rows carry;
 * - the arguments JSON becomes the same one-line summary the outer rows use
 *   (`pwd`, `src/app.ts`) — `args` on the result is `JSON.stringify(args)`
 *   clipped to 200 characters, so a clipped one is read back through the keys
 *   it still shows;
 * - bash's own `Command exited with code N` trailer is dropped from a nested
 *   failure, where the error text above it already says what happened.
 *
 * Everything else, the script and its output, is pi's own rows. A diff for a
 * nested `edit`, or a sub-call that opens on click, needs data the result does
 * not carry: `args` is a clipped string and there is no per-call output.
 *
 * The output is one blob on purpose. A script builds its `text()` items from
 * whatever it computed, so an item can be a filtered, merged, re-encoded
 * summary of several calls; nothing ties an item back to the call that fed it.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { rawIndexOfVisible, trimTrailingSpaces, visibleText } from "./frame-draw.ts";
import { toolKindIcon } from "./icons.ts";
import type { ThemeLike } from "./theme-access.ts";
import { summarizeArgs } from "./tool-lines.ts";

/** pi's nested-call status glyphs, before the tool's name. */
const STATUS_GLYPHS = new Set(["✓", "✗", "⊘", "…"]);

/**
 * bash's trailer inside a nested error, indented by the error block's own
 * four spaces. The top-level bash box keeps pi's version: there it is the only
 * report of the exit code.
 */
const NESTED_BASH_TRAILER = /^ {4}Command (?:exited with code \d+|terminated)\b/;

/**
 * The first path-ish argument visible in a clipped JSON string. `args` is cut
 * to 200 characters, so `JSON.parse` fails on the long ones while the keys that
 * matter are usually still readable.
 */
const PARTIAL_ARG =
  /"(command|file_path|filePath|path|pattern|url|query)":\s*"((?:[^"\\]|\\.)*)"?/;

/** Escape sequences only, so a replaced span's style closers can be kept. */
const ESCAPES_ONLY = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

interface NestedCall {
  name: string;
  /** `JSON.stringify(args)`, clipped by pi. Empty when the call took none. */
  args: string;
}

function nestedCalls(details: unknown): NestedCall[] {
  const calls = (details as { calls?: unknown } | undefined)?.calls;
  if (!Array.isArray(calls)) return [];
  const out: NestedCall[] = [];
  for (const call of calls as Array<{ name?: unknown; args?: unknown }>) {
    if (typeof call?.name !== "string" || !call.name) continue;
    out.push({ name: call.name, args: typeof call.args === "string" ? call.args : "" });
  }
  return out;
}

/**
 * `{"command":"pwd","timeout":10}` → `pwd`. Parsed when the whole string made
 * it through; otherwise read the one key that survived. Empty when neither
 * works, and the row keeps pi's JSON.
 */
function summarizeNestedArgs(name: string, argsText: string): string {
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    const match = PARTIAL_ARG.exec(argsText);
    if (!match) return "";
    // The value can be cut mid-escape, and pi marks the cut with `...`; both
    // leave the fragment unparseable on its own.
    const value = match[2]!.replace(/(?:\\+|\.\.\.)$/, "").replace(/\\+$/, "");
    try {
      args = { [match[1]!]: JSON.parse(`"${value}"`) };
    } catch {
      return "";
    }
  }
  if (!args || typeof args !== "object") return "";
  return summarizeArgs(name, args);
}

/**
 * Replace the row's visible arguments with the summary. The escapes inside the
 * replaced span (the arguments' own colour closers) are carried over, so the
 * rest of the row keeps whatever styling pi gave it.
 */
function replaceArgs(line: string, argsText: string, summary: string): string {
  const plain = visibleText(line);
  const at = plain.indexOf(argsText);
  if (at < 0) return line;
  const from = rawIndexOfVisible(line, at);
  const to = rawIndexOfVisible(line, at + argsText.length);
  if (from < 0) return line;
  const end = to < 0 ? line.length : to;
  const escapes = line.slice(from, end).match(ESCAPES_ONLY)?.join("") ?? "";
  return line.slice(0, from) + summary + escapes + line.slice(end);
}

/**
 * Where a row's own text starts: pi's box pads every row with `outputPad`
 * cells, so the status glyph is not at index 0.
 */
function leadIndex(plain: string): number {
  let i = 0;
  while (i < plain.length && plain[i] === " ") i++;
  return i;
}

/** `✓ bash …` → `✓ 󰆍 bash …`, inserted inside the name's own colour span. */
function addKindIcon(line: string, name: string, lead: number): string {
  const at = rawIndexOfVisible(line, lead + 2);
  if (at < 0) return line;
  return line.slice(0, at) + `${toolKindIcon(name)} ` + line.slice(at);
}

/** Pad the name cell so every row's arguments start on the same column. */
function padName(line: string, name: string, lead: number, width: number): string {
  const pad = width - name.length;
  if (pad <= 0) return line;
  const at = rawIndexOfVisible(line, lead + 2 + name.length);
  if (at < 0) return line;
  return line.slice(0, at) + " ".repeat(pad) + line.slice(at);
}

/** The trailing `50ms` / `1.8s` of a call row, if it has one. */
const DURATION_TAIL = /(\d+(?:\.\d+)?(?:ms|s))$/;

/** The text of a call row without the padding pi gave it, and without its duration. */
function argumentsWidth(line: string): number {
  const body = visibleText(line).replace(/\s+$/, "");
  const match = DURATION_TAIL.exec(body);
  return match ? visibleWidth(body.slice(0, match.index)) : visibleWidth(body);
}

/**
 * Put a row's duration in the column the call rows share, `gap` cells past the
 * longest arguments.
 *
 * Not against the body's right edge: these rows cannot be clicked and never
 * show a hover hint, so on a wide terminal a duration pinned to the far edge
 * reads as part of another column, a screen away from the log it belongs to.
 */
function alignDuration(line: string, target: number, gap: number): string {
  const plain = visibleText(line);
  const match = DURATION_TAIL.exec(plain.replace(/\s+$/, ""));
  if (!match) return line;
  const pad = target + gap - argumentsWidth(line);
  if (pad <= 0) return line;
  const from = rawIndexOfVisible(line, match.index);
  if (from < 0) return line;
  return trimTrailingSpaces(line.slice(0, from)) + " ".repeat(pad) + trimTrailingSpaces(line.slice(from));
}

/** Cells between the longest arguments and the duration column. */
const DURATION_GAP = 2;

/**
 * Decorate the rendered rows. A row is a nested call only if it opens with a
 * status glyph and names one of the script's tools, and it is matched to the
 * first unconsumed call of that name — so two `bash` calls keep their own
 * arguments — which leaves the script, its output and a multi-line error's
 * continuation rows untouched.
 */
function decorateRows(
  lines: readonly string[],
  calls: NestedCall[],
  icons: boolean,
  nameWidth: number,
): string[] {
  const built: string[] = [];
  const callRows = new Set<number>();
  let next = 0;
  for (const line of lines) {
    const plain = visibleText(line);
    const lead = leadIndex(plain);
    if (!STATUS_GLYPHS.has(plain[lead] ?? "") || plain[lead + 1] !== " ") {
      built.push(line);
      continue;
    }
    const name = plain.slice(lead + 2).split(" ")[0] ?? "";
    let index = next;
    while (index < calls.length && calls[index]!.name !== name) index++;
    if (index >= calls.length) {
      built.push(line);
      continue;
    }
    next = index + 1;
    callRows.add(built.length);

    const call = calls[index]!;
    let row = line;
    if (call.args) {
      const summary = summarizeNestedArgs(name, call.args);
      if (summary) row = replaceArgs(row, call.args, summary);
    }
    row = padName(row, name, lead, nameWidth);
    if (icons) row = addKindIcon(row, name, lead);
    built.push(row);
  }

  // One column for the durations: as far right as the longest arguments reach,
  // plus two cells of air.
  let target = 0;
  for (const index of callRows) target = Math.max(target, argumentsWidth(built[index]!));
  return built.map((row, index) => (callRows.has(index) ? alignDuration(row, target, DURATION_GAP) : row));
}

/** Cells the call rows' name column may take before the arguments stop paying. */
const NAME_COLUMN_MAX = 14;

function nameColumn(calls: readonly NestedCall[]): number {
  let width = 0;
  for (const call of calls) width = Math.max(width, call.name.length);
  return Math.min(width, NAME_COLUMN_MAX);
}

/**
 * Drop the trailer bash appends to a failed nested call, along with the blank
 * continuation row its error text carries in front of it. The trailer is only
 * taken when an indented error row precedes it — that is what a nested
 * failure's block looks like; the script's own source is never indented that
 * way right before one.
 */
function dropBashTrailers(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (NESTED_BASH_TRAILER.test(visibleText(line))) {
      let back = out.length - 1;
      while (back >= 0 && visibleText(out[back]!).trim() === "") back--;
      if (back >= 0 && /^\s{4,}\S/.test(visibleText(out[back]!))) {
        while (out.length > 0 && visibleText(out[out.length - 1]!).trim() === "") out.pop();
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

export interface CodemodeBodyOptions {
  /** Put the kind icon in front of every nested tool's name. */
  icons: boolean;
  /** Cells the rows may occupy, for the duration column. */
  width?: number;
  /** The fold row the pointer is on, so it can read as clickable. */
  hovered?: CodemodeSection;
}

/**
 * Decorate a rendered `codemode` body. Without nested-call details (older pi,
 * or a script that called nothing) the rows are pi's, unchanged.
 */
export function decorateCodemodeBody(
  lines: string[],
  details: unknown,
  options: CodemodeBodyOptions,
): string[] {
  const calls = nestedCalls(details);
  const decorated = calls.length > 0 ? decorateRows(lines, calls, options.icons, nameColumn(calls)) : lines;
  return dropBashTrailers(decorated);
}

// ═══════════════════════════════════════════════════════════════════════════
// Folding the body down to its calls
// ═══════════════════════════════════════════════════════════════════════════

/** The two parts of a codemode body that open on their own row. */
export type CodemodeSection = "script" | "output";

/** Which sections the reader has opened. Closed is the default: a call list. */
export interface CodemodeSections {
  script: boolean;
  output: boolean;
}

// Per tool box, so a `/reload` or a re-render does not reset what the reader opened.
const sectionState = new WeakMap<object, CodemodeSections>();

/** The open/closed state of a box's folded sections. */
export function codemodeSections(tool: object): CodemodeSections {
  let state = sectionState.get(tool);
  if (!state) {
    state = { script: false, output: false };
    sectionState.set(tool, state);
  }
  return state;
}

/** Flip one section. Returns its new state. */
export function toggleCodemodeSection(tool: object, section: CodemodeSection): boolean {
  const state = codemodeSections(tool);
  state[section] = !state[section];
  return state[section];
}

/** A row the reader can click: the fold label of one section. */
export interface CodemodeToggle {
  /** Index in the composed lines. */
  row: number;
  section: CodemodeSection;
}

const TIMER_ROW = /^\s*(?:Took|Elapsed)\s+\d/;
const CONTINUATION = /^\s{4,}\S/;
const TEXT_ITEM = /^==> text \d+\/\d+ <==$/;

/** The rows pi drew for one call, plus the indented error text under it. */
interface Regions {
  script: string[];
  calls: string[];
  output: string[];
}

/**
 * Split a decorated body into the script, the call rows and the output.
 *
 * The call rows are the anchors: pi draws one per `details.calls` entry, in
 * order, so matching them in sequence locates both boundaries without knowing
 * anything else about the layout. Without a call row there is nothing to anchor
 * on and the body is left as it is.
 */
function splitRegions(lines: readonly string[], calls: readonly NestedCall[], toolName: string): Regions | undefined {
  if (calls.length === 0) return undefined;
  const plain = lines.map(visibleText);
  let next = 0;
  let first = -1;
  let end = -1;
  for (let i = 0; i < lines.length && next < calls.length; i++) {
    const row = plain[i]!;
    const lead = leadIndex(row);
    if (!STATUS_GLYPHS.has(row[lead] ?? "") || row[lead + 1] !== " ") continue;
    if ((row.slice(lead + 2).split(" ")[0] ?? "") !== calls[next]!.name) continue;
    if (first < 0) first = i;
    next++;
    end = i + 1;
  }
  if (first < 0 || end < 0) return undefined;
  // What hangs under a call: its error text, indented by the renderer.
  while (end < lines.length && (plain[end]!.trim() === "" || CONTINUATION.test(plain[end]!))) end++;
  while (end > first && plain[end - 1]!.trim() === "") end--;

  const head = lines.slice(0, first).filter((line) => visibleText(line).trim() !== "");
  // pi's call renderer titles the block with the tool's name, which the row
  // above the body already says.
  while (head.length > 0 && visibleText(head[0]!).trim() === toolName) head.shift();

  // pi's elapsed row closes the body; the row above the body carries the time.
  const tail = lines.slice(end).filter((line) => visibleText(line).trim() !== "");
  while (tail.length > 0 && TIMER_ROW.test(visibleText(tail[tail.length - 1]!).trim())) tail.pop();

  return { script: head, calls: lines.slice(first, end), output: tail };
}

/**
 * `▸ script · 13 lines` / `▾ output · 4 items`. The leading cell matches the
 * pad pi's own rows carry, so the fold glyph lines up under a call's status.
 */
function foldRow(open: boolean, hovered: boolean, label: string, meta: string, theme: ThemeLike): string {
  // Same three signals as the group's rows: open, hovered, neither.
  const glyph = theme.fg("accent", open ? "▾" : hovered ? "▶" : "▸");
  const rest = `${theme.fg("muted", label)}${theme.fg("dim", ` · ${meta}`)}`;
  return ` ${glyph} ${rest}`;
}

function itemCount(output: readonly string[]): number {
  const items = output.filter((line) => TEXT_ITEM.test(visibleText(line).trim())).length;
  return items > 0 ? items : 1;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ComposedCodemodeBody {
  lines: string[];
  toggles: CodemodeToggle[];
}

/**
 * The body a grouped `codemode` call shows: its call rows, with the script and
 * the output folded to one row each. Opening a section is done by clicking its
 * row; the state lives in `codemodeSections`.
 *
 * `width` is the cells the body's own content may use, for the rules that
 * separate the three sections.
 */
export function composeCodemodeBody(
  lines: string[],
  details: unknown,
  state: CodemodeSections,
  theme: ThemeLike,
  options: CodemodeBodyOptions,
): ComposedCodemodeBody {
  const calls = nestedCalls(details);
  // Split before decorating: the icon is inserted where the tool's name starts,
  // and the name is what tells one call row from the output.
  const regions = splitRegions(lines, calls, "codemode");
  if (!regions) return { lines: decorateCodemodeBody(lines, details, options), toggles: [] };
  const callRows = dropBashTrailers(decorateRows(regions.calls, calls, options.icons, nameColumn(calls)));
  const rule = ruleRow(theme, options.width);

  const out: string[] = [];
  const toggles: CodemodeToggle[] = [];
  if (regions.script.length > 0) {
    toggles.push({ row: out.length, section: "script" });
    out.push(foldRow(state.script, options.hovered === "script", "script", plural(regions.script.length, "line"), theme));
    if (state.script) out.push(...regions.script);
    if (rule) out.push(rule);
  }
  out.push(...callRows);
  if (regions.output.length > 0) {
    if (rule) out.push(rule);
    toggles.push({ row: out.length, section: "output" });
    out.push(foldRow(state.output, options.hovered === "output", "output", plural(itemCount(regions.output), "item"), theme));
    if (state.output) out.push(...separateItems(regions.output));
  }
  // pi's `Took 0.1s` row says what the row above the body already says.
  return { lines: out.length > 0 ? out : lines, toggles };
}

/** A dim rule across the body, so the sections read as sections. */
function ruleRow(theme: ThemeLike, width: number | undefined): string | undefined {
  if (!width || width < 6) return undefined;
  return ` ${theme.fg("borderMuted", "─".repeat(Math.max(1, width - 1)))}`;
}

/**
 * Drop pi's `==> text N/M <==` markers, which the count on the fold row now
 * carries, and use a blank row between the items instead. Everything else in
 * the output, including a `<console_output>` block, is the script's own text.
 */
function separateItems(output: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of output) {
    if (TEXT_ITEM.test(visibleText(line).trim())) {
      if (out.length > 0) out.push("");
      continue;
    }
    out.push(line);
  }
  return out;
}
