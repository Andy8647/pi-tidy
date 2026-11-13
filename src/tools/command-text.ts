/**
 * The bash call row: a `Text` whose later rows hang on the command's column.
 *
 * pi draws a shell command as one `Text`, so line two of a script starts at the
 * frame's edge and reads as the box's content rather than as the command's body.
 * The column is not a constant: in a box of its own the command starts after
 * `$ `, and under a group row it starts after the icon and the name. So the
 * caller that draws the frame hands the column in through the renderer state it
 * already shares with the call (see `renderGroupedTool` and `frameBox`).
 */

import { Text } from "@earendil-works/pi-tui";

/** Cells `$ ` takes: the command's column when nothing else says otherwise. */
export const CALL_PROMPT_CELLS = 2;

/** The renderer-state slot: written by the frame, read on the next render. */
export interface CommandIndent {
  tidyCommandIndent?: number;
}

/** Cells the row keeps for its own text, whatever column the caller asks for. */
const MIN_ROW_CELLS = 8;

export class CommandText extends Text {
  private readonly indent: CommandIndent;

  constructor(state: CommandIndent) {
    super("", 0, 0);
    this.indent = state;
  }

  override render(width: number): string[] {
    const column = Math.min(this.indent.tidyCommandIndent ?? CALL_PROMPT_CELLS, Math.max(0, width - MIN_ROW_CELLS));
    // One row, or a frame too narrow to give a column away: nothing to hang.
    if (column <= 0) return super.render(width);
    // Wrapped narrower by the column it hangs on, so the pad lands inside the
    // frame instead of pushing the row past its right edge. Row 0 is the command
    // row itself: it keeps the frame's edge.
    const pad = " ".repeat(column);
    return super.render(width - column).map((row, index) => (index === 0 ? row : pad + row));
  }
}
