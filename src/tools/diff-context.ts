/**
 * How much unchanged code an edit's diff keeps around each change.
 *
 * pi's edit tool writes its diff with four lines of context on each side of a
 * change and folds anything further into a `...` row. That text is all a box has:
 * the panes are built from it, and pi's unified renderer draws it. Fewer lines of
 * context can be cut out of it; more cannot be put back.
 *
 * The format, as pi's `generateDiffString` writes it: a sign (`+`, `-`, or a space
 * for context), the line number padded to one width, a space and the line. A
 * skipped stretch is a space, that many blanks, then ` ...`. Every row carries its
 * own number, so dropping rows leaves the numbering right.
 */

/** The context pi writes. A setting at or above it changes nothing. */
export const PI_DIFF_CONTEXT = 4;

const CHANGE_RE = /^[+-]/;
/** A row pi drew for a stretch it skipped: no number, only `...`. */
const SKIP_RE = /^ +\.\.\.$/;
/** The sign, then the number padded to the diff's width. */
const NUMBER_RE = /^[ +-]( *\d+) /;

/**
 * `diff` with at most `context` unchanged rows on each side of a change. Whatever
 * a run of context loses becomes one `...` row, in the place pi puts its own.
 * Text that is not pi's display diff (no numbered rows) comes back unchanged.
 */
export function trimDiffContext(diff: string, context: number): string {
  const keep = Math.max(0, Math.floor(context));
  if (keep >= PI_DIFF_CONTEXT) return diff;
  const rows = diff.split("\n");
  const width = rows.map((row) => NUMBER_RE.exec(row)?.[1]?.length).find((cells) => cells !== undefined);
  // Not pi's numbered rows, or nothing changed: there is no change to keep context around.
  if (width === undefined || !rows.some((row) => CHANGE_RE.test(row))) return diff;
  const skip = ` ${" ".repeat(width)} ...`;
  const out: string[] = [];
  let index = 0;
  while (index < rows.length) {
    if (CHANGE_RE.test(rows[index]!)) {
      out.push(rows[index++]!);
      continue;
    }
    // A run of unchanged rows, with pi's own `...` rows inside it.
    const start = index;
    while (index < rows.length && !CHANGE_RE.test(rows[index]!)) index++;
    const run = rows.slice(start, index);
    const lines = run.filter((row) => !SKIP_RE.test(row));
    const skipped = lines.length < run.length;
    const after = start > 0 ? keep : 0;
    const before = index < rows.length ? keep : 0;
    if (!skipped && lines.length <= after + before) {
      out.push(...lines);
      continue;
    }
    out.push(...lines.slice(0, after), skip, ...lines.slice(Math.max(after, lines.length - before)));
  }
  return out.join("\n");
}
