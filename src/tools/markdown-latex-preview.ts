/**
 * Markdown and LaTeX bodies for the `write` and `read` boxes.
 *
 * A `.ts` file's preview is source code, and pi draws it perfectly well. A `.md`
 * file's is Markdown, and a `.tex` file's is LaTeX: shown as source, a README
 * reads as a wall of `#` and `**`, and an equation reads as backslashes. These
 * two renderers draw the same text the way pi's own reply renderer would:
 *
 * - Markdown goes through pi-tui's `Markdown`, so headings, lists, quotes and
 *   code blocks get the theme's own tokens. Display-math environments are wrapped
 *   first (see `latex-environments.ts`) so `renderLatex` sees them.
 * - LaTeX gets syntax highlighting plus Unicode math: `renderLatex` turns a
 *   `$…$`, a `$$…$$` or a `\begin{equation}` into `α + β = ─` where it can, and
 *   the source line stands when it cannot.
 *
 * Display only: nothing here reads or writes a file, it is given the text the
 * tool already returned.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, renderLatex, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { transformLatexEnvironmentsCached, DISPLAY_MATH_ENVIRONMENTS } from "../messages/latex-environments.ts";
import type { ThemeLike } from "../theme-access.ts";
import { highlightLines } from "./lang-support.ts";

/** Control characters that must never reach the terminal. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * File text with the terminal put out of reach: CRLF is one line break, and an
 * ESC (a colour code in a file being previewed would otherwise be interpreted)
 * is dropped along with the rest of the C0 range.
 */
function sanitize(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");
}

export interface MarkdownBodyOptions {
  /** `tidy.renderLatex`: render `$$…$$` math inside the Markdown (default true). */
  renderLatex?: boolean;
}

/**
 * A Markdown string as pi would draw it in a reply: wrapped to `width`, themed,
 * with display math rendered.
 */
export function renderMarkdownLines(content: string, width: number, options: MarkdownBodyOptions = {}): string[] {
  const renderMath = options.renderLatex ?? true;
  const source = sanitize(content);
  const text = renderMath ? transformLatexEnvironmentsCached(source) : source;
  const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), undefined, { renderLatex: renderMath });
  // Trailing blanks keep the width for a background fill; these rows are rail- or
  // box-drawn, so they only cost cells.
  return markdown.render(Math.max(1, Math.floor(width))).map((line) => line.replace(/[ \t]+$/, ""));
}

export interface LatexBodyOptions {
  /** `tidy.renderLatex`: draw math as Unicode instead of raw source (default true). */
  renderMath?: boolean;
}

interface MathSpan {
  start: number;
  end: number;
  /** What `renderLatex` is given: the whole match, or the inside of a delimiter. */
  expr: string;
  display: boolean;
}

const BLOCK_PATTERNS = [/\$\$([\s\S]*?)\$\$/g, /\\\[([\s\S]*?)\\\]/g];
const INLINE_PATTERNS = [/\$([^$\n]+)\$/g, /\\\(([^\n]*?)\\\)/g];
/** A `\begin{ENV}` opener; only the display environments below are math. */
const BEGIN_PATTERN = /\\begin\{([A-Za-z]+\*?)\}/g;

/** The first unescaped `%` of a line, or -1. */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let slashes = 0;
    for (let back = i - 1; back >= 0 && line[back] === "\\"; back--) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * The source with every comment blanked to spaces. `%` is a comment wherever it
 * appears in TeX, math included, so a `$…$` in one is not math.
 */
function maskComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const at = commentStart(line);
      return at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at);
    })
    .join("\n");
}

/** Whether the character at `index` is preceded by an odd run of backslashes. */
function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Math spans in source order: block forms first, then what is left as inline. */
export function findMathSpans(source: string): MathSpan[] {
  const masked = maskComments(source);
  const taken: MathSpan[] = [];
  const overlaps = (start: number, end: number) => taken.some((span) => start < span.end && span.start < end);
  for (const pattern of BLOCK_PATTERNS) {
    for (const match of masked.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      const expr = match[1] ?? "";
      if (!expr.trim()) continue;
      taken.push({ start, end, expr, display: true });
    }
  }
  for (const match of masked.matchAll(BEGIN_PATTERN)) {
    const environment = match[1]!;
    if (!DISPLAY_MATH_ENVIRONMENTS.has(environment)) continue;
    const start = match.index!;
    const closer = `\\end{${environment}}`;
    const close = masked.indexOf(closer, start + match[0].length);
    if (close === -1) continue;
    const end = close + closer.length;
    if (overlaps(start, end)) continue;
    taken.push({ start, end, expr: source.slice(start, end), display: true });
  }
  for (const pattern of INLINE_PATTERNS) {
    for (const match of masked.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (escaped(masked, start) || overlaps(start, end)) continue;
      const expr = match[1] ?? "";
      if (!expr.trim()) continue;
      taken.push({ start, end, expr, display: false });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * A LaTeX file as preview lines: syntax-highlighted source, with each math span
 * replaced by the Unicode math `renderLatex` produces for it where it can. A span
 * it cannot parse stays as highlighted source, so nothing is ever hidden.
 *
 * One entry per source line, except a display span's own rendered rows.
 */
export function renderLatexPreviewLines(content: string, theme: ThemeLike, options: LatexBodyOptions = {}): string[] {
  const source = sanitize(content);
  const renderMath = options.renderMath ?? true;
  if (!renderMath) return highlightLines(source, "latex", theme);
  const spans = findMathSpans(source);
  if (spans.length === 0) return highlightLines(source, "latex", theme);

  const lines: string[] = [""];
  let filled = false;
  const appendText = (text: string): void => {
    if (text === "") return;
    const parts = text.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        lines.push("");
        filled = false;
      }
      const part = parts[index]!;
      if (part === "") continue;
      lines[lines.length - 1] += highlightLines(part, "latex", theme)[0] ?? part;
      filled = true;
    }
  };
  let cursor = 0;
  for (const span of spans) {
    appendText(source.slice(cursor, span.start));
    cursor = span.end;
    const rendered = renderLatex(span.expr, { display: span.display });
    if (rendered === undefined) {
      appendText(source.slice(span.start, span.end));
      continue;
    }
    if (!span.display) {
      // Inline math must stay on its line, so a fraction falls back to a flat row.
      lines[lines.length - 1] += theme.fg("syntaxString", rendered.replace(/\s*\n\s*/g, " "));
      filled = true;
      continue;
    }
    if (filled) {
      lines.push("");
      filled = false;
    }
    for (const row of rendered.split("\n")) {
      lines.push(theme.fg("accent", row));
    }
    lines.push("");
  }
  appendText(source.slice(cursor));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/**
 * Wrap a LaTeX preview row to `width` so a long equation never overflows the box.
 */
export function wrapLatexLines(lines: readonly string[], width: number): string[] {
  const room = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(line, room).map((row) => row.replace(/[ \t]+$/, "")));
  }
  return out;
}

export type PreviewKind = "markdown" | "latex";

export interface ReadPreviewOptions {
  kind: PreviewKind;
  /** `tidy.renderLatex`: math in Markdown, math in LaTeX. */
  renderLatex: boolean;
  /** pi's `[Truncated: …]` row, re-appended in `warning` under the body. */
  notice?: string;
}

/**
 * A `read` result for a Markdown or LaTeX file, drawn as a body: a leading blank
 * row (pi's own result renderers open with one), the rendered text at the box's
 * width, then pi's truncation row if the file was cut.
 *
 * Rendering is lazy and cached per width: pi renders every box on every frame,
 * and the body only changes when the box or the terminal is resized.
 */
export function createReadPreviewComponent(body: string, theme: ThemeLike, options: ReadPreviewOptions): Component {
  const cache = new Map<number, string[]>();
  const build = (width: number): string[] => {
    const rows = [""];
    if (options.kind === "markdown") {
      rows.push(...renderMarkdownLines(body, width, { renderLatex: options.renderLatex }));
    } else {
      rows.push(...wrapLatexLines(renderLatexPreviewLines(body, theme, { renderMath: options.renderLatex }), width));
    }
    if (options.notice) rows.push(theme.fg("warning", options.notice));
    return rows;
  };
  return {
    render(width: number): string[] {
      const key = Math.max(1, Math.floor(width));
      const hit = cache.get(key);
      if (hit) return hit;
      const rows = build(key);
      if (cache.size >= 8) cache.clear();
      cache.set(key, rows);
      return rows;
    },
    invalidate(): void {
      cache.clear();
    },
  };
}
