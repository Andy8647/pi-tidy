/**
 * Side-by-side (old | new) body for the `edit` tool's diff.
 *
 * pi renders an edit preview as a unified diff string (`+12 text`, `- 7 text`,
 * `  3 text`) and colours each line with toolDiffAdded / toolDiffRemoved /
 * toolDiffContext. Two panes read better for block replacements, so this module
 * parses that string and re-renders it: line numbers on both sides, a coloured
 * bar on changed rows, a tinted row background, and word-level emphasis on
 * paired lines. Same information pi already has — no file access, no internals.
 *
 * The tint is derived from the theme (diff colour mixed into the tool box
 * background), so it follows whatever theme pi is running.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../theme-access.ts";
import { highlightLines, resolveLanguageFromPath } from "./lang-support.ts";

/** Blank cells on each side of the panes (pi's Box uses the same padding). */
const PAD = 1;
const SEPARATOR = " │ ";
/** Narrower panes than this and the caller should keep pi's unified diff. */
const MIN_CONTENT_WIDTH = 20;
const TAB = "    ";

export interface SplitDiffInput {
  /** pi's unified diff string (`details.diff`) */
  diff: string;
  /** Total width available, padding included */
  width: number;
  theme: ThemeLike;
  /** Used only to pick a highlighter language. */
  filePath?: string;
  /**
   * Rows of diff body to draw (`diffLines` while collapsed). Undefined draws
   * all of them. The window is anchored at the first changed row — cutting at
   * the top of a diff on a large file would hide the change itself.
   */
  maxLines?: number;
  /**
   * Whether the diff carries line numbers the way pi serialises an edit
   * (`+12 text`). A `diff` block a model wrote has none (`+const a = 2;`): the
   * whole rest of the row is the line, indentation included.
   */
  numbered?: boolean;
  /**
   * Whether the footer may say how to see the rest (default true). A nested
   * diff has no expansion of its own: the tree it hangs in does not open it.
   */
  hint?: boolean;
}

export interface SplitDiffOutput {
  lines: string[];
  /** Rows that carry their own background fill — the frame must not strip it. */
  bgRows: number[];
}

interface Cell {
  num: number | null;
  text: string;
  changed: boolean;
}

interface Row {
  kind: "row" | "skip";
  left?: Cell;
  right?: Cell;
}

/** One row as it is actually drawn: one line per pane row, or several when wrapped. */
interface RenderedRow {
  lines: string[];
  changed: boolean;
}

interface ParsedLine {
  prefix: "+" | "-" | " ";
  num: number | null;
  text: string;
  skip: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Palette {
  addedFg: string;
  removedFg: string;
  contextFg: string;
  addedBar: string;
  removedBar: string;
  addedBg: string | undefined;
  removedBg: string | undefined;
  addedEmphasis: string | undefined;
  removedEmphasis: string | undefined;
  separator: string;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** `+12 text` / `- 7 text` / `  3 text`, plus pi's `      ...` skip marker. */
const LINE_RE = /^([+\- ])(\s*)(\d*)(?:\s(.*))?$/;
/** A fenced diff's own headers: reading them as `+`/`-` lines invents changes. */
const UNNUMBERED_HEADER_RE = /^(?:diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename (?:from|to) |@@|\\)/;
const UNNUMBERED_FILE_RE = /^(?:---|\+\+\+) /;

function parseLine(raw: string, numbered = true): ParsedLine | null {
  if (!numbered) {
    // No numbers to strip: whatever follows the marker is the line, spaces and all.
    const prefix = raw[0];
    if (prefix !== "+" && prefix !== "-" && prefix !== " ") return null;
    return { prefix, num: null, text: raw.slice(1), skip: false };
  }
  const match = LINE_RE.exec(raw);
  if (!match) return null;
  const prefix = match[1] as ParsedLine["prefix"];
  const digits = match[3] ?? "";
  const text = match[4] ?? "";
  const num = digits ? Number.parseInt(digits, 10) : null;
  return { prefix, num, text, skip: num === null && text.trim() === "..." };
}

/**
 * Group into rows. pi emits each change as a run of `-` lines followed by a run
 * of `+` lines, so a run pairs by index: the i-th removed line sits next to the
 * i-th added one, and a longer side leaves the other cell blank.
 *
 * Context lines only carry the old number; the new one is the old plus the
 * running addition/deletion delta.
 */
function buildRows(parsed: readonly ParsedLine[]): Row[] {
  const rows: Row[] = [];
  let delta = 0;
  let i = 0;
  while (i < parsed.length) {
    const line = parsed[i]!;
    if (line.skip) {
      rows.push({ kind: "skip" });
      i++;
      continue;
    }
    if (line.prefix === " ") {
      const next = line.num === null ? null : line.num + delta;
      rows.push({
        kind: "row",
        left: { num: line.num, text: line.text, changed: false },
        right: { num: next, text: line.text, changed: false },
      });
      i++;
      continue;
    }
    const removed: ParsedLine[] = [];
    while (i < parsed.length && parsed[i]!.prefix === "-") removed.push(parsed[i++]!);
    const added: ParsedLine[] = [];
    while (i < parsed.length && parsed[i]!.prefix === "+") added.push(parsed[i++]!);
    if (removed.length === 0 && added.length === 0) {
      i++; // unreachable in practice; never spin on a line we cannot classify
      continue;
    }
    delta += added.length - removed.length;
    const pairs = Math.max(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const left = removed[k];
      const right = added[k];
      rows.push({
        kind: "row",
        ...(left ? { left: { num: left.num, text: left.text, changed: true } } : {}),
        ...(right ? { right: { num: right.num, text: right.text, changed: true } } : {}),
      });
    }
  }
  return rows;
}

// ── colour ──────────────────────────────────────────────────────────────────

/** The SGR prefix a theme slot expands to, e.g. `\x1b[38;2;166;227;161m`. */
function sgr(theme: ThemeLike, slot: string, kind: "fg" | "bg" = "fg"): string | undefined {
  try {
    const ansi = kind === "bg" ? theme.bg?.(slot, "x") : theme.fg(slot, "x");
    if (!ansi) return undefined;
    const end = ansi.indexOf("m");
    return end > 0 ? ansi.slice(0, end + 1) : undefined;
  } catch {
    return undefined;
  }
}

const XTERM_16: Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 49, b: 49 },
  { r: 13, g: 188, b: 121 },
  { r: 229, g: 229, b: 16 },
  { r: 36, g: 114, b: 200 },
  { r: 188, g: 63, b: 188 },
  { r: 17, g: 168, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 102, g: 102, b: 102 },
  { r: 241, g: 76, b: 76 },
  { r: 35, g: 209, b: 139 },
  { r: 245, g: 245, b: 67 },
  { r: 59, g: 142, b: 234 },
  { r: 214, g: 112, b: 214 },
  { r: 41, g: 184, b: 219 },
  { r: 255, g: 255, b: 255 },
];

function xterm256(index: number): Rgb {
  if (index < 16) return XTERM_16[index] ?? XTERM_16[0]!;
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const value = index - 16;
    return {
      r: steps[Math.floor(value / 36)]!,
      g: steps[Math.floor((value % 36) / 6)]!,
      b: steps[value % 6]!,
    };
  }
  const grey = 8 + (index - 232) * 10;
  return { r: grey, g: grey, b: grey };
}

/** Read a colour out of an SGR sequence (truecolour, 256, or the basic 16). */
function sgrRgb(sequence: string | undefined): Rgb | null {
  if (!sequence) return null;
  const params = sequence.slice(2, -1).split(";").map((part) => Number.parseInt(part, 10));
  const at = params.indexOf(38) >= 0 ? params.indexOf(38) : params.indexOf(48);
  if (at >= 0) {
    if (params[at + 1] === 2) {
      const [r, g, b] = [params[at + 2], params[at + 3], params[at + 4]];
      if (r === undefined || g === undefined || b === undefined) return null;
      return { r, g, b };
    }
    if (params[at + 1] === 5 && params[at + 2] !== undefined) return xterm256(params[at + 2]!);
    return null;
  }
  const code = params[0];
  if (code === undefined || !Number.isFinite(code)) return null;
  if (code >= 30 && code <= 37) return XTERM_16[code - 30] ?? null;
  if (code >= 90 && code <= 97) return XTERM_16[code - 90 + 8] ?? null;
  return null;
}

/**
 * Light themes need a translucent-style tint that preserves the box's light
 * background. Dark themes keep the original dimmed base so the diff hue stays
 * distinct without washing out the syntax colours. Older hosts without an
 * appearance property keep that same dark-theme behaviour.
 */
function tintBackground(base: Rgb, color: Rgb, hue: number, appearance: ThemeLike["appearance"]): Rgb {
  const baseWeight = appearance === "light" ? 1 - hue : 0.35;
  return {
    r: Math.round(color.r * hue + base.r * baseWeight),
    g: Math.round(color.g * hue + base.g * baseWeight),
    b: Math.round(color.b * hue + base.b * baseWeight),
  };
}

function bgAnsi(color: Rgb): string {
  return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

/**
 * Paint a row: the fill goes first and is re-armed after every SGR reset inside
 * the text (syntax highlighting emits its own `\x1b[0m`, which would otherwise
 * punch a hole in the tint).
 */
function paint(text: string, fill: string): string {
  let out = fill;
  let index = 0;
  const RESET = /\x1b\[0?m/g;
  for (const match of text.matchAll(RESET)) {
    const start = match.index ?? 0;
    out += text.slice(index, start) + match[0] + fill;
    index = start + match[0].length;
  }
  return `${out}${text.slice(index)}\x1b[49m`;
}

function buildPalette(theme: ThemeLike): Palette {
  const addedFg = sgr(theme, "toolDiffAdded");
  const removedFg = sgr(theme, "toolDiffRemoved");
  const contextFg = sgr(theme, "toolDiffContext");
  // The row tint has no theme slot: use 16% of the diff hue for the row,
  // 32% for the word, with the base weight chosen for the theme's appearance.
  const base = sgrRgb(sgr(theme, "toolSuccessBg", "bg")) ?? sgrRgb(sgr(theme, "toolPendingBg", "bg"));
  const added = sgrRgb(addedFg);
  const removed = sgrRgb(removedFg);
  const tint = (color: Rgb | null, hue: number): string | undefined =>
    base && color ? bgAnsi(tintBackground(base, color, hue, theme.appearance)) : undefined;
  return {
    addedFg: addedFg ?? "",
    removedFg: removedFg ?? "",
    contextFg: contextFg ?? "",
    addedBar: sgr(theme, "toolDiffAdded") ?? "",
    removedBar: sgr(theme, "toolDiffRemoved") ?? "",
    addedBg: tint(added, 0.16),
    removedBg: tint(removed, 0.16),
    addedEmphasis: tint(added, 0.32),
    removedEmphasis: tint(removed, 0.32),
    separator: contextFg ?? "",
  };
}

// ── text ────────────────────────────────────────────────────────────────────

/** Drop control characters (a diff of a file containing ESC must not reach the terminal). */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\t/g, TAB);
}

function highlighter(filePath: string | undefined, theme: ThemeLike): (line: string) => string {
  let language: string | undefined;
  try {
    language = resolveLanguageFromPath(filePath);
  } catch {
    language = undefined;
  }
  const cache = new Map<string, string>();
  return (line) => {
    const cached = cache.get(line);
    if (cached !== undefined) return cached;
    let out = line;
    if (language && line.trim()) {
      try {
        out = highlightLines(line, language, theme)[0] ?? line;
      } catch {
        out = line;
      }
    }
    cache.set(line, out);
    return out;
  };
}

/** Longest common prefix and suffix, in code units. */
function commonEdges(left: string, right: string): { prefix: number; suffix: number } {
  const max = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < max && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * Wrap the changed middle of `rendered` (already coloured) in the emphasis
 * fill. Boundaries are visible-character indices, so escape sequences inside
 * the highlighted text do not shift them.
 */
function emphasize(rendered: string, start: number, end: number, fill: string, restore: string | undefined): string {
  if (end <= start) return rendered;
  const back = restore ?? "\x1b[49m";
  let out = "";
  let visible = 0;
  let inside = false;
  let index = 0;
  while (index < rendered.length) {
    const char = rendered[index]!;
    if (char === "\x1b") {
      const stop = rendered.indexOf("m", index);
      if (stop !== -1) {
        out += rendered.slice(index, stop + 1);
        index = stop + 1;
        continue;
      }
    }
    if (!inside && visible === start) {
      out += fill;
      inside = true;
    }
    if (inside && visible === end) {
      out += back;
      inside = false;
    }
    out += char;
    visible++;
    index++;
  }
  return inside ? out + back : out;
}

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible === width) return text;
  if (visible > width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - visible);
}

// ── rendering ───────────────────────────────────────────────────────────────

interface Layout {
  /** Bar column, then a space, the number, a space, then the code. */
  numWidth: number;
  pane: number;
  content: number;
}

function layout(width: number, rows: readonly Row[]): Layout | null {
  let maxNumber = 0;
  for (const row of rows) {
    for (const cell of [row.left, row.right]) {
      if (cell?.num !== null && cell?.num !== undefined) maxNumber = Math.max(maxNumber, cell.num);
    }
  }
  // "old" / "new" sit over the number column, so it is at least three wide.
  const numWidth = Math.max(1, String(maxNumber).length);
  const available = width - PAD * 2 - SEPARATOR.length;
  if (available < (numWidth + 2) * 2 + MIN_CONTENT_WIDTH * 2) return null;
  const pane = Math.floor(available / 2);
  const content = pane - numWidth - 2;
  if (content < MIN_CONTENT_WIDTH) return null;
  return { numWidth, pane, content };
}

function numberFg(changed: boolean, kind: "add" | "remove" | "context", palette: Palette): string {
  if (!changed) return palette.contextFg;
  return kind === "add" ? palette.addedFg : palette.removedFg;
}

function renderCell(
  cell: Cell | undefined,
  kind: "add" | "remove" | "context",
  lay: Layout,
  palette: Palette,
  highlight: (line: string) => string,
  emphasis: { start: number; end: number } | undefined,
): string {
  if (!cell) {
    // The other pane has nothing on this row: keep the cell blank so the two
    // columns stay aligned, and leave it untinted like an empty diff line.
    return " ".repeat(lay.pane);
  }
  const changed = cell.changed;
  const fg = numberFg(changed, kind, palette);
  const fill = kind === "add" ? palette.addedBg : kind === "remove" ? palette.removedBg : undefined;
  const emphFill = kind === "add" ? palette.addedEmphasis : palette.removedEmphasis;
  const bar = changed ? (kind === "add" ? palette.addedBar : palette.removedBar) : palette.contextFg;

  const raw = sanitize(cell.text);
  let body = highlight(raw);
  if (changed && emphasis && emphFill) {
    body = emphasize(body, emphasis.start, emphasis.end, emphFill, fill);
  }
  body = pad(truncateToWidth(body, lay.content, ""), lay.content);

  const num = cell.num === null ? "" : String(cell.num);
  const label = num.padEnd(lay.numWidth);
  // Bar first, then the number: the marker sits in its own column, so the
  // digits line up down the pane and the bar reads as a margin.
  const line = `${bar}${changed ? "▌" : " "}${fg}${label}\x1b[39m ${body}`;
  return pad(fill ? paint(line, fill) : line, lay.pane);
}

/**
 * The line under the call row: `↳ diff +3 -1 [+++----]`.
 *
 * The bar is proportional (lazygit's summary line), not a histogram — one
 * glance says how lopsided the edit is. Both halves keep at least one cell
 * when both sides are non-zero, so "mostly additions" still shows the red.
 */
function renderSummary(add: number, remove: number, width: number, palette: Palette): string {
  const prefix = `${palette.contextFg}↳ diff\x1b[39m ${palette.addedFg}+${add}\x1b[39m ${palette.removedFg}-${remove}\x1b[39m`;
  const room = width - PAD * 2 - visibleWidth(`↳ diff +${add} -${remove} []`);
  if (add + remove === 0 || room < 2) return pad(`${" ".repeat(PAD)}${prefix}${" ".repeat(PAD)}`, width);
  // One cell per changed line (capped), but never so short the ratio is a guess.
  const bar = Math.min(room, 32, Math.max(8, add + remove));
  let added = Math.round((bar * add) / (add + remove));
  if (add > 0 && remove > 0) added = Math.min(bar - 1, Math.max(1, added));
  if (add === 0) added = 0;
  if (remove === 0) added = bar;
  const removed = bar - added;
  const graph = `${palette.contextFg}[${palette.addedFg}${'+'.repeat(added)}${palette.removedFg}${'-'.repeat(removed)}${palette.contextFg}]`;
  return pad(`${' '.repeat(PAD)}${prefix} ${graph}\x1b[39m${' '.repeat(PAD)}`, width);
}

/**
 * Render the diff as two panes. Returns null when the width cannot hold a
 * readable split — the caller then keeps pi's unified diff.
 *
 * Not memoised: pi re-renders every box on every frame, so the cache has to
 * hold one entry per box, and it lives on the box (`splitEditBody` in
 * tool-frame.ts). A single module-level slot here was evicted by the next edit
 * box in the transcript, every frame, and never hit.
 */
export function renderSplitDiff(input: SplitDiffInput): SplitDiffOutput | null {
  const { diff, width, theme, filePath } = input;
  const numbered = input.numbered ?? true;
  const parsed: ParsedLine[] = [];
  let content = 0;
  for (const raw of diff.split("\n")) {
    if (!numbered) {
      if (UNNUMBERED_HEADER_RE.test(raw)) continue;
      // `--- a/x` / `+++ b/x` only ever open a diff, so they can only be headers
      // before the first line of content. Later on they are a removal and an add.
      if (content === 0 && UNNUMBERED_FILE_RE.test(raw)) continue;
    }
    const line = parseLine(raw, numbered);
    if (line) {
      parsed.push(line);
      if (!line.skip) content++;
    } else if (raw.trim()) {
      parsed.push({ prefix: " ", num: null, text: raw, skip: false });
      content++;
    }
  }
  if (parsed.length === 0) return null;
  const rows = buildRows(parsed);
  const lay = layout(width, rows);
  if (!lay) return null;

  const palette = buildPalette(theme);
  const highlight = highlighter(filePath, theme);
  const lines: string[] = [];
  const bgRows: number[] = [];

  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.left?.changed) removed++;
    if (row.right?.changed) added++;
  }
  lines.push(renderSummary(added, removed, width, palette));

  const label = (text: string) => `${palette.contextFg}${text}\x1b[39m`;
  const separator = `${palette.separator}${SEPARATOR}\x1b[39m`;
  // No "old │ new" header. Left is old and right is new, so it labelled
  // nothing; its labels are three cells wide where the number column is
  // often two, which put the rule one cell off every row below it.
  // A pair the panes cannot show in full leaves the columns rather than losing
  // the change at the cut. Decided per pair: pi writes one `-` block followed by
  // one `+` block for every adjacent change, so keying this on the block would
  // drag a short edit out of the panes just because its neighbour is long.
  const rendered: RenderedRow[] = rows.map((row) => {
    if (row.kind === "skip") {
      return { lines: [pad(`${' '.repeat(PAD)}${label("…")}`, width)], changed: false };
    }
    return overflowsPane(row, lay.content)
      ? renderWideRow(row, width, lay.numWidth, palette, highlight)
      : renderPaneRow(row, width, lay, palette, highlight, separator);
  });
  const window = clipRendered(rendered, input.maxLines);
  if (window.above > 0) {
    lines.push(pad(`${" ".repeat(PAD)}${label(`… ${window.above} line${window.above === 1 ? "" : "s"} above`)}`, width));
  }

  for (const row of window.rows) {
    for (const line of row.lines) {
      if (row.changed) bgRows.push(lines.length);
      lines.push(line);
    }
  }

  if (window.below > 0) {
    const total = rows.length;
    const more = `${window.below} more line${window.below === 1 ? "" : "s"}`;
    if (input.hint === false) {
      // A diff nothing can open says so by closing here: a keybinding that
      // does nothing is worse than no keybinding at all.
      lines.push(pad(`${" ".repeat(PAD)}${label(`… (${more}, ${total} total)`)}`, width));
    } else {
      const hint = keyHint("app.tools.expand", "to expand");
      lines.push(
        pad(
          `${" ".repeat(PAD)}${label(`… (${more}, ${total} total,`)} ${hint}${label(")")}`,
          width,
        ),
      );
    }
  }

  return { lines, bgRows };
}

/**
 * Whether a changed side of this pair is wider than a pane can draw. An
 * unchanged row has no change to lose, so the panes may cut it like any other
 * line; only a change needs the whole box to stay readable.
 */
function overflowsPane(row: Row, content: number): boolean {
  for (const cell of [row.left, row.right]) {
    if (cell?.changed && visibleWidth(sanitize(cell.text)) > content) return true;
  }
  return false;
}

/** A row drawn inside the two panes: one physical line, both sides aligned. */
function renderPaneRow(
  row: Row,
  width: number,
  lay: Layout,
  palette: Palette,
  highlight: (line: string) => string,
  separator: string,
): RenderedRow {
  const spans = row.left && row.right ? commonEdges(row.left.text, row.right.text) : undefined;
  const leftEmphasis =
    row.left && row.right && row.left.changed
      ? {
          start: spans!.prefix,
          end: row.left.text.length - spans!.suffix,
        }
      : undefined;
  const rightEmphasis =
    row.left && row.right && row.right.changed
      ? {
          start: spans!.prefix,
          end: row.right.text.length - spans!.suffix,
        }
      : undefined;

  const left = renderCell(
    row.left,
    row.left?.changed ? "remove" : "context",
    lay,
    palette,
    highlight,
    leftEmphasis,
  );
  const right = renderCell(
    row.right,
    row.right?.changed ? "add" : "context",
    lay,
    palette,
    highlight,
    rightEmphasis,
  );
  return {
    lines: [pad(`${" ".repeat(PAD)}${left}${separator}${right}${" ".repeat(PAD)}`, width)],
    changed: Boolean(row.left?.changed || row.right?.changed),
  };
}

/**
 * One side of a broken-out row: the whole line, wrapped onto as many rows as
 * the box needs. The bar and the number sit on the first row only; the
 * continuation rows keep the tint, so the block still reads as one line.
 */
function wrapWide(
  cell: Cell,
  kind: "add" | "remove",
  content: number,
  numWidth: number,
  palette: Palette,
  highlight: (line: string) => string,
  emphasis: { start: number; end: number } | undefined,
): string[] {
  const fill = kind === "add" ? palette.addedBg : palette.removedBg;
  const emphFill = kind === "add" ? palette.addedEmphasis : palette.removedEmphasis;
  const fg = kind === "add" ? palette.addedFg : palette.removedFg;
  const bar = kind === "add" ? palette.addedBar : palette.removedBar;

  let body = highlight(sanitize(cell.text));
  if (emphasis && emphFill) body = emphasize(body, emphasis.start, emphasis.end, emphFill, fill);
  const gutter = numWidth + 2;
  const num = cell.num === null ? "" : String(cell.num);
  const head = `${bar}▌${fg}${num.padEnd(numWidth)}\x1b[39m `;
  return wrapTextWithAnsi(body, content).map((text, index) => {
    const line = `${index === 0 ? head : " ".repeat(gutter)}${pad(truncateToWidth(text, content, ""), content)}`;
    return fill ? paint(line, fill) : line;
  });
}

/**
 * A row whose change does not fit either pane, drawn across the whole box: the
 * old line on top, the new one below, each wrapped. Trading the side-by-side
 * comparison for this run beats showing two identical-looking halves and
 * leaving the reader to guess what changed.
 */
function renderWideRow(
  row: Row,
  width: number,
  numWidth: number,
  palette: Palette,
  highlight: (line: string) => string,
): RenderedRow {
  const content = width - PAD * 2 - (numWidth + 2);
  const spans = row.left && row.right ? commonEdges(row.left.text, row.right.text) : undefined;
  const lines: string[] = [];
  for (const [cell, kind] of [
    [row.left, "remove"],
    [row.right, "add"],
  ] as const) {
    if (!cell) continue;
    const emphasis =
      cell.changed && spans ? { start: spans.prefix, end: cell.text.length - spans.suffix } : undefined;
    for (const line of wrapWide(cell, kind, content, numWidth, palette, highlight, emphasis)) {
      lines.push(pad(`${" ".repeat(PAD)}${line}`, width));
    }
  }
  return { lines, changed: true };
}

/**
 * The slice of rendered rows to draw. A wrapped row costs the rows it actually
 * occupies, so three long lines cannot claim a budget of three and then paint
 * nine. Without a budget that is all of them; with one, the window is anchored
 * at the first changed row with a third of the budget above it, and only ever
 * cuts between rows.
 */
function clipRendered(
  rows: readonly RenderedRow[],
  maxLines: number | undefined,
): { rows: readonly RenderedRow[]; above: number; below: number } {
  const heights = rows.map((row) => row.lines.length);
  const total = heights.reduce((sum, height) => sum + height, 0);
  const budget = maxLines === undefined ? total : Math.max(0, Math.floor(maxLines));
  if (budget >= total) return { rows, above: 0, below: 0 };
  if (budget === 0) return { rows: [], above: 0, below: rows.length };

  let seen = 0;
  for (const row of rows) {
    if (row.changed) break;
    seen += row.lines.length;
  }
  const lead = Math.min(Math.floor(budget / 3), budget);
  const start = Math.max(0, Math.min(seen - lead, total - budget));

  let first = 0;
  seen = 0;
  for (let index = 0; index < rows.length; index++) {
    if (seen + heights[index]! > start) {
      first = index;
      break;
    }
    seen += heights[index]!;
  }
  let last = first;
  let used = 0;
  while (last < rows.length && used < budget) {
    used += heights[last]!;
    last++;
  }
  return { rows: rows.slice(first, last), above: first, below: rows.length - last };
}
