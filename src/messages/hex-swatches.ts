/**
 * A color swatch in front of a hex color in message markdown: `#7f849c` gains
 * two full-block cells painted with the color it names.
 *
 * Display only — `pi.registerMarkdownTransformer` never touches the session or
 * the model context. The swatch is a foreground block, not a background fill:
 * a user message's rows go through `stripBackgroundFills` (the rail and frame
 * styles repaint the fill themselves), and a fill would be painted out there.
 *
 * Fenced code blocks and inline code are left alone. A swatch inside a snippet
 * is noise, and a shell comment that happens to look like a color (`#abc`) is
 * not one.
 */

import { paint } from "../draw/paint.ts";
import type { ThemeLike } from "../theme-access.ts";

/**
 * A dot, not a block: one cell wide, present in every monospace font, and it
 * reads as a color chip beside the value instead of a hole punched in the line.
 * Nerd Font private-use glyphs are the alternative, but their real width varies
 * by font (pi-tui measures them as one cell, some draw two).
 */
export const SWATCH_GLYPH = "●";

/** Longest first, so `#7f849cff` does not match as `#7f84` plus a broken tail. */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/;
const HEX_AT = new RegExp(HEX_RE.source, "g");

/** Up to three spaces of indent, then a run of three or more of one char. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Fence {
  char: string;
  length: number;
}

/**
 * `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as `#rrggbb`. Alpha has nothing to
 * show here: the block is either painted or not.
 */
export function swatchColor(hex: string): string | undefined {
  let body = hex.slice(1);
  if (body.length === 4) body = body.slice(0, 3);
  else if (body.length === 8) body = body.slice(0, 6);
  if (body.length === 3) body = [...body].map((cell) => cell + cell).join("");
  return body.length === 6 ? `#${body.toLowerCase()}` : undefined;
}

/**
 * The escape sequence that puts a user message's text color back.
 *
 * pi draws a user message's Markdown with a `defaultTextStyle` that wraps each
 * text token in `userMessageText`, so an SGR reset inside the token drops the
 * color for the rest of it. Assistant text has no default style, so nothing is
 * lost there and this returns "". Built the way pi-tui builds its own
 * `stylePrefix`: style a sentinel, keep what came before it.
 */
export function restoreColor(theme: ThemeLike, messageType: string): string {
  if (messageType !== "user") return "";
  const sentinel = "\u0000";
  let styled: string;
  try {
    styled = theme.fg("userMessageText", sentinel);
  } catch {
    return "";
  }
  const at = styled.indexOf(sentinel);
  return at > 0 ? styled.slice(0, at) : "";
}

function swatch(hex: string, restore: string, theme: ThemeLike): string {
  const color = swatchColor(hex);
  if (!color) return hex;
  // The block, then the enclosing style back, then the value itself unpainted:
  // it reads as the sentence it belongs to, not as the label of a chip.
  return `${paint(theme, color, SWATCH_GLYPH)}${restore} ${hex}`;
}

/** The index just past a closing run of exactly `length` backticks, or -1. */
function closingTicks(line: string, from: number, length: number): number {
  let at = line.indexOf("`".repeat(length), from);
  while (at !== -1) {
    // A longer run is that run, not the end of this one.
    if (line[at + length] !== "`") return at + length;
    at = line.indexOf("`".repeat(length), at + length + 1);
  }
  return -1;
}

function swatchesInLine(line: string, restore: string, theme: ThemeLike): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    if (char === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const end = closingTicks(line, i + run, run);
      if (end === -1) return out + line.slice(i);
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (char === "#") {
      HEX_AT.lastIndex = i;
      const match = HEX_AT.exec(line);
      if (match && match.index === i) {
        out += swatch(match[0], restore, theme);
        i += match[0].length;
        continue;
      }
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * The markdown with a swatch in front of every hex color outside code. `restore`
 * is what `restoreColor` returned for this message.
 */
export function withHexSwatches(markdown: string, restore: string, theme: ThemeLike): string {
  if (!markdown.includes("#")) return markdown;
  const lines = markdown.split("\n");
  let fence: Fence | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opened = FENCE_RE.exec(line);
    if (fence) {
      // The closing fence is the same character, at least as long, and nothing
      // but whitespace after it.
      if (opened && opened[1]![0] === fence.char && opened[1]!.length >= fence.length && line.slice(opened[0].length).trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (opened) {
      fence = { char: opened[1]![0]!, length: opened[1]!.length };
      continue;
    }
    if (line.includes("#")) lines[i] = swatchesInLine(line, restore, theme);
  }
  return lines.join("\n");
}

/**
 * Streaming re-renders the same markdown several times a second, and a settled
 * reply re-renders on every width change. The swatches of one message do not
 * change until its text does, so the last few results are kept.
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

export function withHexSwatchesCached(markdown: string, restore: string, theme: ThemeLike): string {
  if (!markdown.includes("#")) return markdown;
  const key = `${theme.getColorMode?.() ?? "truecolor"}\u0000${restore}\u0000${markdown}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = withHexSwatches(markdown, restore, theme);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
