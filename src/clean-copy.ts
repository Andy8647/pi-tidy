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
 *   inset when every row has it.
 * - A `rail` user message: two equal `─` rules, the top one possibly labelled, whose
 *   every row between them carries the rail.
 *
 * Anything else is content and stays byte-identical: a table's square corners, a
 * blockquote's gutter, a rule the assistant wrote, a bash box. Telling frames from
 * text by their shape is what this is, so a bare rounded box a model drew in an
 * unframed message reads as a frame.
 */

import { sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { liveSlot, tidyEnabled } from "./live.ts";
import { USER_RAIL_GLYPH } from "./messages/user-message.ts";
import { COPIED_CHIP, COPY_CHIP } from "./turns/code-blocks.ts";

/** `null` drops the row. `leftTrim` is the columns taken off its left edge. */
export type CleanedRow = { text: string; leftTrim: number } | null;

const USER_RAIL_PREFIX = `${USER_RAIL_GLYPH} `;
/** A block's opening fence with tidy's chip on it: the chip is chrome, the fence is not. */
const FENCE_CHIP_RE = new RegExp(`^(\`\`\`[^\`]*) {2}(?:${COPY_CHIP}|${COPIED_CHIP})$`);

const RULE_ROW_RE = /^─+$/;
/** A rail message's top rule, with who and when set into it; `├` where a run's rail meets it. */
const LABELED_RULE_RE = /^[─├]─*(?: [^─]+ ─+)+$/;
/** The rails and indent a frame hangs on. */
const HANG_RE = /^[│ ]*/;
/** `├` is a corner where a rail meets it; a table's `├─┼─┤` never ends in a round one. */
const FRAME_OPEN_RE = /^[╭├]─*(?: [^─]+ ─+)*╮$/;
const FRAME_CLOSE_RE = /^[╰├]─*╯$/;

function isRailRow(text: string): boolean {
  return text.startsWith(USER_RAIL_PREFIX) || text.trimEnd() === USER_RAIL_GLYPH;
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
  const railRows = new Map<number, string>();
  const flatRows = new Set<number>();

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
      dropped.add(top.row);
      dropped.add(row);
      const body = plain.slice(top.row + 1, row).map((text) => text.slice(left));
      const inset = body.every((text) => text.startsWith(`${USER_RAIL_GLYPH} `)) ? 1 : 0;
      for (let inner = top.row + 1; inner < row; inner++) frameRows.set(inner, { left, inset });
    }
  }

  // Rail user messages. A row without the rail breaks the pair, which is what keeps
  // an assistant's own `---` rules, and the text between them, from being eaten.
  let lastRule: { row: number; width: number } | undefined;
  for (let row = 0; row < plain.length; row++) {
    if (dropped.has(row)) continue;
    const text = plain[row]!;
    if (RULE_ROW_RE.test(text)) {
      const width = visibleWidth(text);
      if (lastRule && lastRule.width === width && row - lastRule.row >= 2) {
        dropped.add(lastRule.row);
        dropped.add(row);
        for (let inner = lastRule.row + 1; inner < row; inner++) {
          const body = plain[inner]!;
          railRows.set(inner, body.startsWith(USER_RAIL_PREFIX) && body.trim() !== USER_RAIL_GLYPH ? USER_RAIL_PREFIX : USER_RAIL_GLYPH);
        }
      }
      lastRule = { row, width };
    } else if (LABELED_RULE_RE.test(text)) {
      // A label only ever opens a message, and it closes nothing above it.
      lastRule = { row, width: visibleWidth(text) };
    } else if (!isRailRow(text)) {
      lastRule = undefined;
    }
  }

  // A message with only rules: a labeled top rule, an indented body, then the next plain
  // rule of its width. The label is what tells it from a model's own rules, so a "rules"
  // user message with no icons, and so no label, keeps its rules.
  for (let row = 0; row < plain.length; row++) {
    if (dropped.has(row) || !LABELED_RULE_RE.test(plain[row]!)) continue;
    const width = visibleWidth(plain[row]!);
    for (let end = row + 1; end < plain.length && !dropped.has(end) && !LABELED_RULE_RE.test(plain[end]!); end++) {
      if (!RULE_ROW_RE.test(plain[end]!) || visibleWidth(plain[end]!) !== width) continue;
      const body = Array.from({ length: end - row - 1 }, (_, index) => row + 1 + index);
      if (body.length === 0 || !body.every((inner) => plain[inner]!.trim() === "" || plain[inner]!.startsWith(" "))) break;
      dropped.add(row);
      dropped.add(end);
      for (const inner of body) flatRows.add(inner);
      break;
    }
  }

  const rows: CleanedRow[] = [];
  let changed = false;
  for (let row = startRow; row <= endRow; row++) {
    if (dropped.has(row)) {
      rows.push(null);
      changed = true;
      continue;
    }
    const text = plain[row] ?? "";
    const frame = frameRows.get(row);
    const framed = frame ? text.slice(frame.left).trimEnd() : "";
    if (frame && framed.length >= 2 && framed.startsWith(USER_RAIL_GLYPH) && framed.endsWith(USER_RAIL_GLYPH)) {
      rows.push({ text: framed.slice(1 + frame.inset, -1), leftTrim: frame.left + 1 + frame.inset });
      changed = true;
      continue;
    }
    const prefix = railRows.get(row);
    if (prefix !== undefined && text.startsWith(prefix)) {
      rows.push({ text: text.slice(prefix.length), leftTrim: visibleWidth(prefix) });
      changed = true;
      continue;
    }
    if (flatRows.has(row) && text.startsWith(" ")) {
      rows.push({ text: text.slice(1), leftTrim: 1 });
      changed = true;
      continue;
    }
    rows.push({ text, leftTrim: 0 });
  }

  // The chip on a block's opening fence is chrome: a fence that ends in it copies as
  // the fence alone.
  for (let index = 0; index < rows.length; index++) {
    const entry = rows[index];
    if (!entry) continue;
    const fence = FENCE_CHIP_RE.exec(entry.text.trimEnd());
    if (!fence) continue;
    rows[index] = { text: fence[1]!, leftTrim: entry.leftTrim };
    changed = true;
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
