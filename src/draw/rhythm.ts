/**
 * The transcript's vertical rhythm, in blank rows. Three steps and no more: nothing
 * between the parts of one thing (a summary and the calls under it), one between the
 * parts of a run (your message, its process, its reply), two between runs. pi's own
 * blank rows are trimmed off every message tidy draws, so these are the only gaps.
 */
export const GAP_PART = 1;
export const GAP_RUN = 2;
/** Rows a closed reply frame keeps clear inside its top and bottom edges. */
export const FRAME_PADDING_Y = 1;
