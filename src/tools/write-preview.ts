/**
 * The write box's call row: `write ~/path` plus the file's first lines.
 *
 * pi's own renderer hard-codes 10 lines and has no setting, so index.ts
 * registers a call renderer with a configurable budget (`writeLines`) without
 * replacing the tool's execution. Everything below the path mirrors pi: the whole content
 * highlighted once (so multi-line constructs colour correctly), tabs expanded,
 * trailing blank lines dropped, and a `... (N more lines, M total, ctrl+o to
 * expand)` footer while collapsed.
 *
 * A Markdown or LaTeX file is different: its content is not source code to read
 * line by line but a document to draw, so `createWriteCallComponent` returns a
 * rendered preview instead (same budget, same footer). Everything else — `.txt`,
 * source code, an empty body — keeps pi's plain highlighted text.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import type { ThemeLike } from "../theme-access.ts";
import { highlightLines, isLatexPath, isMarkdownPath, resolveLanguageFromPath } from "./lang-support.ts";
import { renderLatexPreviewLines, renderMarkdownLines, wrapLatexLines } from "./markdown-latex-preview.ts";

export interface WriteCallOptions {
  expanded: boolean;
  /** Visual lines shown while collapsed; `0` hides the preview entirely. */
  lines: number;
}

/** How a document preview is drawn; a subset of `TidyConfig`. */
export interface WriteDocumentOptions extends WriteCallOptions {
  renderMarkdown: boolean;
  renderLatex: boolean;
}

/** Digits pi uses when it expands a tab in a tool preview. */
const TAB = "   ";

function shorten(path: string): string {
  const home = homedir();
  if (!home || !path.startsWith(home)) return path;
  return `~${path.slice(home.length)}`;
}

const cache = new Map<string, string[]>();

function highlightedLines(content: string, language: string | undefined, theme: ThemeLike): string[] {
  const key = `${theme.getColorMode?.() ?? "truecolor"}\u0000${language ?? ""}\u0000${content}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = language && content.trim() ? highlightLines(content, language, theme) : content.split("\n");
  // Streaming rewrites this string on every delta; keep only the last few.
  if (cache.size > 8) cache.clear();
  cache.set(key, lines);
  return lines;
}

function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function pathOf(args: { path?: unknown; file_path?: unknown } | undefined): string {
  return typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
}

/** `write ~/notes.md` — the row every preview starts with. */
function header(rawPath: string, theme: ThemeLike): string {
  return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("syntaxVariable", shorten(rawPath))}`;
}

/** pi's `... (N more lines, M total, ctrl+o to expand)`, in our theme slots. */
function moreLines(remaining: number, total: number, theme: ThemeLike): string {
  const hint = keyHint("app.tools.expand", "to expand");
  return `${theme.fg("toolOutput", `\n... (${remaining} more lines, ${total} total,`)} ${hint}${theme.fg("toolOutput", ")")}`;
}

export function formatWriteCallText(
  args: { path?: unknown; file_path?: unknown; content?: unknown } | undefined,
  theme: ThemeLike,
  options: WriteCallOptions,
): string {
  const rawPath = pathOf(args);
  const head = header(rawPath, theme);
  if (typeof args?.content !== "string" || args.content === "") return head;

  const language = rawPath ? resolveLanguageFromPath(rawPath) : undefined;
  const lines = trimTrailingEmpty(highlightedLines(args.content.replace(/\t/g, TAB), language, theme));
  const budget = options.expanded ? lines.length : Math.max(0, options.lines);
  const shown = lines.slice(0, budget);
  const remaining = lines.length - shown.length;
  const body = shown.map((line) => (language ? line : theme.fg("toolOutput", line))).join("\n");
  let text = shown.length > 0 ? `${head}\n\n${body}` : head;
  if (remaining > 0) text += moreLines(remaining, lines.length, theme);
  return text;
}

/**
 * The write call for a Markdown or LaTeX file, or `undefined` when this file is
 * not one of those (or the corresponding setting is off) and the caller should
 * keep `formatWriteCallText`.
 *
 * Rendering is lazy and memoised per width: the component is handed back to pi
 * once, and pi re-renders it on every frame at whatever width the box has.
 */
export function createWriteCallComponent(
  args: { path?: unknown; file_path?: unknown; content?: unknown } | undefined,
  theme: ThemeLike,
  options: WriteDocumentOptions,
): Component | undefined {
  const rawPath = pathOf(args);
  const content = typeof args?.content === "string" ? args.content : "";
  if (!rawPath || content === "") return undefined;
  const kind = options.renderMarkdown && isMarkdownPath(rawPath) ? "markdown" : options.renderLatex && isLatexPath(rawPath) ? "latex" : undefined;
  if (!kind) return undefined;

  const head = header(rawPath, theme);
  const rendered = new Map<number, string[]>();
  const build = (width: number): string[] => {
    const body =
      kind === "markdown"
        ? renderMarkdownLines(content, width, { renderLatex: options.renderLatex })
        : wrapLatexLines(renderLatexPreviewLines(content, theme, { renderMath: options.renderLatex }), width);
    const budget = options.expanded ? body.length : Math.max(0, options.lines);
    const shown = body.slice(0, budget);
    const remaining = body.length - shown.length;
    let text = shown.length > 0 ? `${head}\n\n${shown.join("\n")}` : head;
    if (remaining > 0) text += moreLines(remaining, body.length, theme);
    return text.split("\n");
  };
  return {
    render(width: number): string[] {
      const key = Math.max(1, Math.floor(width));
      const hit = rendered.get(key);
      if (hit) return hit;
      const rows = build(key);
      if (rendered.size >= 8) rendered.clear();
      rendered.set(key, rows);
      return rows;
    },
    invalidate(): void {
      rendered.clear();
    },
  };
}
