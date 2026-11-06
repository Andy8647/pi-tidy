/**
 * A reply's fenced code blocks, pi's own drawing plus two things: a `copy` chip on
 * the opening fence row, and a grammar for languages pi's highlighter has none for.
 *
 * Everything else stays pi-tui's: the fences, the indent, the colours, the closing
 * row. The hook is the Markdown component's private `renderToken`, which is what
 * makes the token's own language and text available; a pi that renames it leaves
 * replies exactly as they are and the caller says so once at load.
 */

import { highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "../draw/frame-draw.ts";
import { renderSplitDiff } from "../tools/split-diff.ts";
import type { ThemeLike } from "../theme-access.ts";

/** The chip's word, and what it says once the text is on the clipboard. */
export const COPY_CHIP = "copy";
export const COPIED_CHIP = "copied";
/** How long the chip keeps saying `copied`. */
export const COPIED_MS = 1200;
/** The cells between the info string and the chip. */
const CHIP_GAP = "  ";

/**
 * Languages highlight.js has no grammar for, and the closest one it does. pi paints a
 * block it cannot parse with one flat colour, so an alias can only add: `fish` is a
 * shell (bash's grammar reads its keywords, strings and comments right), while `.env`
 * and TOML are the same `key = value` + `# comment` shape as INI.
 */
const HIGHLIGHT_ALIASES: Record<string, string> = {
  fish: "bash",
  toml: "ini",
  env: "ini",
  dotenv: "ini",
};

/** A fenced block found while the reply was rendered, in row order. */
export interface CodeBlock {
  /** The first word of the info string, or `code` for a bare fence. */
  lang: string;
  /** The token's text, tabs already expanded: exactly what the chip copies. */
  text: string;
  /** The opening row's visible text, which is how a hit test finds it again. */
  label: string;
  /** False when this pi cannot copy, and the fence carries no chip. */
  copyable: boolean;
}

export interface CodeBlockOptions {
  theme: ThemeLike;
  /** `tidy.codeBlocks`: off leaves every block exactly as pi drew it. */
  enabled: boolean;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  canCopy: boolean;
}

/** A reply's blocks, plus the one chip currently showing `copied`. */
export interface CodeBlocks {
  blocks: CodeBlock[];
  flash?: { index: number; until: number };
}

/** One column range a click on a chip covers. */
export interface ChipSpan {
  row: number;
  /** Index into `CodeBlocks.blocks`. */
  index: number;
  x: number;
  end: number;
}

function infoWord(lang: string | undefined): string {
  return (lang ?? "").trim().split(/\s+/)[0] || "code";
}

/** The indent pi puts in front of every body row, taken from its own first row. */
function bodyIndent(row: string | undefined): string {
  return /^ */.exec(row ?? "")![0];
}

/**
 * pi's lines for one `code` token, with the chip added to the opening fence (and a
 * grammar substituted when pi has none). Undefined when the shape is not what this
 * expects, or the block is off, and then the caller keeps pi's rows untouched.
 *
 * `lines` is the opening fence, one row per code line, the closing fence, and
 * sometimes a blank after it, so the body's extent is known without reading rows.
 */
export function decorateCodeToken(
  lines: readonly string[],
  token: { lang?: string; text: string },
  width: number,
  options: CodeBlockOptions,
): { lines: string[]; block: CodeBlock } | undefined {
  const count = token.text.split("\n").length;
  if (!options.enabled || lines.length < count + 2) return undefined;
  const lang = infoWord(token.lang);
  const out = [...lines];
  // pi's own body rows already carry its indent; only rows this module makes need it back.
  const indent = bodyIndent(out[1]);
  const body = bodyRows(token.text, lang, width, visibleWidth(indent), options);
  if (body) for (let row = 0; row < count; row++) out[1 + row] = `${indent}${(body[row] ?? "").trimEnd()}`;
  const chip = options.canCopy ? `${CHIP_GAP}${options.theme.fg("muted", COPY_CHIP)}` : "";
  out[0] = `${out[0]}${chip}`;
  return { lines: out, block: { lang, text: token.text, label: visibleText(out[0]!), copyable: options.canCopy } };
}

/**
 * Rows to put in place of pi's body, or undefined to keep pi's. A `diff` block goes
 * side by side when it fits, with the same renderer and switch as an edit's diff;
 * a language pi has no grammar for gets the closest one.
 */
function bodyRows(text: string, lang: string, width: number, indent: number, options: CodeBlockOptions): string[] | undefined {
  if (lang === "diff" && options.splitDiff && options.splitDiffMinWidth <= width) {
    const panes = renderSplitDiff({ diff: text, width: Math.max(1, width - indent), theme: options.theme, numbered: false });
    if (panes) return panes.lines;
  }
  const alias = HIGHLIGHT_ALIASES[lang];
  return alias ? highlightCode(text, alias) : undefined;
}

/**
 * Where each chip sits in the finished body, in row order. Rows arrive with the
 * message's own padding in front and the width's in back, so the label is matched
 * with both ends off and the chip's column is measured on the row as drawn.
 */
export function chipSpans(body: readonly string[], blocks: readonly CodeBlock[]): ChipSpan[] {
  const spans: ChipSpan[] = [];
  let next = 0;
  for (let row = 0; row < body.length && next < blocks.length; row++) {
    const block = blocks[next]!;
    const text = visibleText(body[row]!);
    if (!block.copyable || text.trim() !== block.label) continue;
    const x = visibleWidth(text.trimEnd()) - COPY_CHIP.length;
    spans.push({ row, index: next, x, end: x + COPY_CHIP.length });
    next++;
  }
  return spans;
}

/** The body with one block's chip reading `copied`. */
export function chipAsCopied(body: readonly string[], span: ChipSpan, theme: ThemeLike): string[] {
  const out = [...body];
  out[span.row] = out[span.row]!.replace(theme.fg("muted", COPY_CHIP), theme.fg("muted", COPIED_CHIP));
  return out;
}
