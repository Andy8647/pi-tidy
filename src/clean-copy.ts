/**
 * Takes tidy's chrome out of a transcript selection before it reaches the
 * clipboard.
 *
 * pi copies rendered rows, so a selection in a frame brings the frame along:
 * `│ hello     │`. Both of pi's copies (select-to-copy and the copy key) read
 * `getActiveSelectionText`, so wrapping that one method covers them. The native
 * selection a terminal does itself (shift or option and drag) never comes here.
 *
 * Only tidy's exact shapes are recognised:
 *
 * - A rounded frame: a pair of equal-width edges in one column, every row between
 *   them wrapped in verticals. A corner may be a `├` where it meets a rail, and the
 *   frame may hang on rails (`│ ╭──╮`). All of that comes off, with the one-cell
 *   inset when every row has it. The label on the top edge is the exception when it
 *   names a file: the path a tool box puts there is what the selection was for, so it
 *   stays while the corner, the padding rules, the title's icons and its copy chip
 *   come off.
 * - A rail (`tidy.style: "rail"`): the same box without its sides. A labelled top
 *   rule pairs with the next plain one of its width in its column, and the blank cell
 *   where each side was comes off with the inset; a reply on an open run has the run's
 *   `│` in that cell, and its bottom rule ends the line with `╰`. A rail with no label
 *   (`!` commands, `icons: false`) keeps its rules: two bare rules are also what a
 *   model's own `---` looks like.
 *
 * Anything else is content and stays byte-identical: a table's square corners, a
 * blockquote's gutter, a rule the assistant wrote, a bash box. Telling frames from
 * text by their shape is what this is, so a bare rounded box a model drew in an
 * unframed message reads as a frame.
 */

import { sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { liveSlot, tidyEnabled } from "./live.ts";
import { USER_RAIL_GLYPH } from "./messages/user-message.ts";
import { CHIP_LABELS, COPY_CHIP, COPIED_CHIP, isOpenRule, isRuleOnly } from "./turns/code-blocks.ts";

/** `null` drops the row. `leftTrim` is the columns taken off its left edge. */
export type CleanedRow = { text: string; leftTrim: number } | null;

/**
 * The copy chip tidy puts in front of a quote's border, which is drawing: a selection
 * keeps the gutter it was drawn beside, not the button next to it.
 */
const QUOTE_CHIP_RE = new RegExp(`^(?:${COPY_CHIP}|${COPIED_CHIP}) ?│`);

/** A rail's top rule, with what it is set into it; `├` where an open run's line meets it. */
const LABELED_RULE_RE = /^[─├]─*(?: [^─]+ ─+)+$/;
/** A rail's bottom rule; `╰` where an open run's line ends in it. */
const RAIL_CLOSE_RE = /^╰?─+$/;
/** The rails and indent a frame hangs on. */
const HANG_RE = /^[│ ]*/;
/** `├` is a corner where a rail meets it; a table's `├─┼─┤` never ends in a round one. */
const FRAME_OPEN_RE = /^[╭├]─*(?: [^─]+ ─+)*╮$/;
const FRAME_CLOSE_RE = /^[╰├]─*╯$/;
/** The corner (a rule, on a rail) and the rules that pad the label out to the box's width. */
const EDGE_LEAD_RE = /^[╭├─][─ ]*/;
/** The closing fill and corner of a labelled edge. */
const EDGE_TAIL_RE = /[─ ]*╮?$/;
/** The glyphs a box puts in front of its title: kind icon, file icon. */
const EDGE_ICONS_RE = /^(?:[\uE000-\uF8FF\u{F0000}-\u{FFFFF}]+\s*)+/u;

/**
 * A frame's top edge is not always chrome: the label it carries may be what the reader
 * selected. A tool box puts the file's path there, and dragging along that border used
 * to copy nothing at all. A reply's label says who answered and when, which is drawing,
 * so it keeps coming off. Shape is all this has to go on: a label that ends in a word
 * naming something on disk (a `/` inside it, or a leading `~`) is content.
 */
const EDGE_PATH_RE = /(^|\s)(~[^\s]*|[^\s]*\/[^\s]*)$/;

function namesPath(label: string): boolean {
  return EDGE_PATH_RE.test(label.trim());
}

/**
 * The label a frame's top edge carries, and where it starts. The corner, the rules
 * padding the row, the icons in front of a title and the copy chip after its path are
 * drawing; the label itself stays byte-identical.
 */
function edgeLabel(edge: string): { text: string; offset: number } | undefined {
  const lead = EDGE_LEAD_RE.exec(edge)![0];
  const rest = edge.slice(lead.length);
  const icons = EDGE_ICONS_RE.exec(rest)?.[0] ?? "";
  let text = rest.slice(icons.length).replace(EDGE_TAIL_RE, "");
  for (const chip of CHIP_LABELS) {
    if (!text.endsWith(` ${chip}`)) continue;
    text = text.slice(0, -chip.length - 1);
    break;
  }
  if (!namesPath(text)) return undefined;
  return { text, offset: visibleWidth(lead) + visibleWidth(icons) };
}

/**
 * Classify the whole buffer, then clean the rows in `[startRow, endRow]`. A drag that
 * starts inside a box never contains the box's edges, so what a row is cannot depend
 * on the selection. `changed` is false when no selected row carried any chrome.
 */
export function cleanTranscriptRows(
  lines: readonly string[],
  startRow: number,
  endRow: number,
): { rows: CleanedRow[]; changed: boolean } {
  const plain = lines.map((line) => stripTerminalSequences(line));
  const dropped = new Set<number>();
  const frameRows = new Map<number, { left: number; inset: number }>();
  /** A top edge that carries a label: the label is content, the rest of the row is not. */
  const labelRows = new Map<number, CleanedRow>();
  /** A rail's rows: the columns in front of the text, up to and with its inset. */
  const railRows = new Map<number, number>();

  // Rounded frames. Edges pair by width and column; a frame inside another pairs first.
  const open: Array<{ row: number; width: number; left: number }> = [];
  for (let row = 0; row < plain.length; row++) {
    const raw = plain[row]!;
    const left = HANG_RE.exec(raw)![0].length;
    const edge = raw.slice(left).trimEnd();
    if (FRAME_OPEN_RE.test(edge)) {
      open.push({ row, width: visibleWidth(edge), left });
    } else if (FRAME_CLOSE_RE.test(edge)) {
      const top = open[open.length - 1];
      if (!top || top.width !== visibleWidth(edge) || top.left !== left) continue;
      open.pop();
      dropped.add(row);
      const label = edgeLabel(plain[top.row]!.slice(top.left).trimEnd());
      if (label) labelRows.set(top.row, { text: label.text, leftTrim: top.left + label.offset });
      else dropped.add(top.row);
      const body = plain.slice(top.row + 1, row).map((text) => text.slice(left));
      const inset = body.every((text) => text.startsWith(`${USER_RAIL_GLYPH} `)) ? 1 : 0;
      for (let inner = top.row + 1; inner < row; inner++) frameRows.set(inner, { left, inset });
    }
  }

  // A code block's rules are chrome, above and below. Only the opening one can say
  // what it is (the chip carries it), so its closing rule is the next row that is
  // nothing but rule glyphs. A model's own `---` rule stays where it is. This runs
  // before the passes below so their pairing never mistakes a rule for a message edge.
  for (let row = 0; row < plain.length; row++) {
    if (!isOpenRule(plain[row]!)) continue;
    dropped.add(row);
    for (let below = row + 1; below < plain.length; below++) {
      if (!isRuleOnly(plain[below]!)) continue;
      dropped.add(below);
      break;
    }
  }

  // Rails. They run after the code blocks', whose rules would otherwise read as a
  // labelled top and its bottom; whatever those passes took is not looked at again.
  const tops: Array<{ row: number; width: number; left: number }> = [];
  for (let row = 0; row < plain.length; row++) {
    if (dropped.has(row) || frameRows.has(row) || labelRows.has(row)) continue;
    const raw = plain[row]!;
    const left = HANG_RE.exec(raw)![0].length;
    const edge = raw.slice(left).trimEnd();
    if (LABELED_RULE_RE.test(edge)) {
      tops.push({ row, width: visibleWidth(edge), left });
      continue;
    }
    if (!RAIL_CLOSE_RE.test(edge)) continue;
    const width = visibleWidth(edge);
    let index = tops.length - 1;
    while (index >= 0 && (tops[index]!.width !== width || tops[index]!.left !== left)) index--;
    if (index < 0) continue;
    const top = tops[index]!;
    tops.length = index;
    dropped.add(row);
    const label = edgeLabel(plain[top.row]!.slice(top.left).trimEnd());
    if (label) labelRows.set(top.row, { text: label.text, leftTrim: top.left + label.offset });
    else dropped.add(top.row);
    // The side's cell, then the inset every row of the box has after it.
    const body = Array.from({ length: row - top.row - 1 }, (_, index) => top.row + 1 + index).filter((inner) => !dropped.has(inner));
    const inset = body.every((inner) => /^(?: |$)/.test(plain[inner]!.slice(left + 1).trimEnd())) ? 1 : 0;
    for (const inner of body) railRows.set(inner, left + 1 + inset);
  }

  const rows: CleanedRow[] = [];
  /** A quote's chip off the row's front, with its cells counted into the trim. */
  const withoutChip = (entry: CleanedRow): CleanedRow => {
    if (!entry) return entry;
    const match = QUOTE_CHIP_RE.exec(entry.text);
    if (!match) return entry;
    // The border the chip stands in front of stays: it is the quote's gutter.
    const chip = match[0].slice(0, -1);
    return { text: entry.text.slice(chip.length), leftTrim: entry.leftTrim + visibleWidth(chip) };
  };
  let changed = false;
  for (let row = startRow; row <= endRow; row++) {
    if (dropped.has(row)) {
      rows.push(null);
      changed = true;
      continue;
    }
    const label = labelRows.get(row);
    if (label) {
      rows.push(label);
      changed = true;
      continue;
    }
    const text = plain[row] ?? "";
    const frame = frameRows.get(row);
    const framed = frame ? text.slice(frame.left).trimEnd() : "";
    if (frame && framed.length >= 2 && framed.startsWith(USER_RAIL_GLYPH) && framed.endsWith(USER_RAIL_GLYPH)) {
      rows.push(withoutChip({ text: framed.slice(1 + frame.inset, -1), leftTrim: frame.left + 1 + frame.inset }));
      changed = true;
      continue;
    }
    const cut = railRows.get(row);
    if (cut !== undefined) {
      rows.push(withoutChip({ text: text.slice(cut), leftTrim: cut }));
      changed = true;
      continue;
    }
    const plainRow = withoutChip({ text, leftTrim: 0 })!;
    if (plainRow.text !== text) changed = true;
    rows.push(plainRow);
  }

  return { rows, changed };
}

interface Point {
  row: number;
  col: number;
  boundary?: boolean;
  scrollView?: unknown;
}
interface Bounds {
  start: Point;
  end: Point;
}
interface LayoutBox {
  scrollView?: unknown;
  scrollContentLines?: readonly string[];
  children?: readonly LayoutBox[];
}
interface SelectionHost {
  currentLayout?: { root?: LayoutBox };
  getSelectionBounds(): Bounds | undefined;
  getSelectionColumns(line: string, row: number, bounds: Bounds): { start: number; end: number };
  hasOverlay(): boolean;
}

/** pi-tui keeps `getScrollViewBox` out of its entry point. */
function scrollLines(box: LayoutBox | undefined, scrollView: unknown): readonly string[] | undefined {
  if (!box) return undefined;
  if (box.scrollView === scrollView) return box.scrollContentLines;
  for (const child of box.children ?? []) {
    const found = scrollLines(child, scrollView);
    if (found) return found;
  }
  return undefined;
}

/**
 * The selection without its chrome, or undefined when pi's text is already right: no
 * chrome selected, or the selection is outside the transcript's scroll view (the
 * editor, a dialog). A selection of nothing but chrome is "": there is a selection,
 * and pi's copy key must not fall back to copying the last reply.
 */
function cleanSelection(host: SelectionHost): string | undefined {
  const bounds = host.getSelectionBounds();
  const scrollView = bounds?.start.scrollView;
  if (!bounds || !scrollView || host.hasOverlay()) return undefined;
  const lines = scrollLines(host.currentLayout?.root, scrollView);
  if (!lines) return undefined;
  const { rows, changed } = cleanTranscriptRows(lines, bounds.start.row, bounds.end.row);
  if (!changed) return undefined;

  // The drag's columns are screen columns; the rows just got shorter on the left.
  const adjusted: Bounds = { start: bounds.start, end: bounds.end };
  const out: string[] = [];
  rows.forEach((entry, index) => {
    if (entry === null) return;
    const row = bounds.start.row + index;
    if (row === bounds.start.row) adjusted.start = { ...bounds.start, col: Math.max(0, bounds.start.col - entry.leftTrim) };
    if (row === bounds.end.row) adjusted.end = { ...bounds.end, col: Math.max(0, bounds.end.col - entry.leftTrim) };
    const { start, end } = host.getSelectionColumns(entry.text, row, adjusted);
    out.push(sliceByColumn(entry.text, start, Math.max(0, end - start), true).trimEnd());
  });
  return out.join("\n");
}

export const cleanCopy = liveSlot("clean-copy", true);

const CLEAN_COPY_HOOK = Symbol.for("pi-tidy:clean-copy");

/** Wrap pi's selection text once. False when this pi has no such method to wrap. */
export function installCleanCopy(): boolean {
  const proto = (TuiAltScreen as unknown as { prototype?: Record<PropertyKey, any> })?.prototype;
  if (!proto) return false;
  if (proto[CLEAN_COPY_HOOK]) return true;
  const original = proto.getActiveSelectionText;
  if (typeof original !== "function") return false;
  proto.getActiveSelectionText = function (this: SelectionHost): string | undefined {
    const verbatim: string | undefined = original.call(this);
    if (verbatim === undefined || !cleanCopy.get() || !tidyEnabled.get()) return verbatim;
    try {
      return cleanSelection(this) ?? verbatim;
    } catch {
      // This reads pi's private layout. Whatever it trips on, a copy with its
      // chrome beats no copy at all.
      return verbatim;
    }
  };
  proto[CLEAN_COPY_HOOK] = true;
  return true;
}
