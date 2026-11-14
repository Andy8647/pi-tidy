/**
 * Which language a path is, and lines coloured for it.
 *
 * pi's `getLanguageFromPath` knows the code extensions and maps `.md` to
 * `markdown`, but it has no answer for `.tex`, `.latex`, `.ltx`, `.sty`, `.cls`,
 * `.bib`, `.mdx` or `.rmd`. pi's `highlightCode` then has no grammar for
 * `markdown` or `latex` until its async `loadAllHighlightLanguages()` finishes
 * (and highlight.js ships no LaTeX grammar at all), so it paints those files with
 * one flat `mdCodeBlock` colour.
 *
 * `resolveLanguageFromPath` fills the extension gap, and `highlightLines` keeps
 * pi's highlighter whenever it actually parsed the text and otherwise falls back
 * to a small, deterministic highlighter built from the theme's own tokens. The
 * fallback is per-line and never changes the line count, so a caller can still
 * address a row of the source by index.
 */

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../theme-access.ts";

/** Paths a message/file preview renders as Markdown. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "rmd"]);
/** Paths that are LaTeX source of some kind. */
const LATEX_EXTENSIONS = new Set(["tex", "latex", "ltx", "sty", "cls", "bib"]);

/** Control characters that must never reach the terminal. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Any SGR sequence, so the fallback trigger can look at what a theme actually painted. */
const ANSI_RE = /\x1b\[[0-9;:]*m/g;

/**
 * The extension of a path, lowercased, or "" for a dotfile / no extension.
 * Only the basename counts: `~/v1.2/README` is not a `.2` file.
 */
function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `.md`, `.markdown`, `.mdx`, `.rmd` (case-insensitive). */
export function isMarkdownPath(filePath: string | undefined): boolean {
  return typeof filePath === "string" && MARKDOWN_EXTENSIONS.has(extensionOf(filePath));
}

/** `.tex`, `.latex`, `.ltx`, `.sty`, `.cls`, `.bib` (case-insensitive). */
export function isLatexPath(filePath: string | undefined): boolean {
  return typeof filePath === "string" && LATEX_EXTENSIONS.has(extensionOf(filePath));
}

/**
 * The highlighter language for `filePath`: pi's answer where it has one, and
 * `latex` / `markdown` for the extensions it does not know.
 */
export function resolveLanguageFromPath(filePath: string | undefined): string | undefined {
  if (typeof filePath !== "string" || filePath === "") return undefined;
  let language: string | undefined;
  try {
    language = getLanguageFromPath(filePath);
  } catch {
    language = undefined;
  }
  if (language) return language;
  const extension = extensionOf(filePath);
  if (LATEX_EXTENSIONS.has(extension)) return "latex";
  if (extension === "mdx" || extension === "rmd") return "markdown";
  return undefined;
}

// ── fallback highlighter ────────────────────────────────────────────────────

/** A path segment's LaTeX comment: the first unescaped `%`. */
export function latexCommentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let slashes = 0;
    for (let back = i - 1; back >= 0 && line[back] === "\\"; back--) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

/** `\command`, `{...}` delimiters and `$...$` spans, outside the comment. */
function latexCode(text: string, theme: ThemeLike): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== undefined && /[A-Za-z@]/.test(next)) {
        let end = i + 2;
        while (end < text.length && /[A-Za-z@]/.test(text[end]!)) end++;
        const command = text.slice(i, end);
        out += theme.fg("syntaxKeyword", command);
        i = end;
        // `\begin{align}`: the environment's name is what the line is about.
        if ((command === "\\begin" || command === "\\end") && text[end] === "{") {
          const close = text.indexOf("}", end + 1);
          if (close !== -1) {
            out += theme.fg("syntaxPunctuation", "{") + theme.fg("syntaxFunction", text.slice(end + 1, close)) + theme.fg("syntaxPunctuation", "}");
            i = close + 1;
          }
        }
        continue;
      }
      // `\\` (row break), `\%`, `\{`: a two-character control symbol.
      if (next !== undefined) {
        out += theme.fg("syntaxKeyword", text.slice(i, i + 2));
        i += 2;
        continue;
      }
    }
    if (char === "$") {
      const run = text[i + 1] === "$" ? 2 : 1;
      const close = text.indexOf("$".repeat(run), i + run);
      if (close !== -1) {
        out += theme.fg("syntaxString", text.slice(i, close + run));
        i = close + run;
        continue;
      }
    }
    if (char === "{" || char === "}" || char === "[" || char === "]") {
      out += theme.fg("syntaxPunctuation", char);
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * One LaTeX source line: `%` to end of line is a comment (true everywhere in
 * TeX, math included), the rest is commands, delimiters and math spans.
 */
function latexLine(text: string, theme: ThemeLike): string {
  const comment = latexCommentStart(text);
  if (comment < 0) return latexCode(text, theme);
  return latexCode(text.slice(0, comment), theme) + theme.fg("syntaxComment", text.slice(comment));
}

/** `**bold**`, `*italic*`, `` `code` `` and `[text](url)` inside one line. */
function markdownInline(text: string, theme: ThemeLike): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const close = text.indexOf("`".repeat(run), i + run);
      if (close !== -1) {
        out += theme.fg("mdCode", text.slice(i, close + run));
        i = close + run;
        continue;
      }
    }
    if (char === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        out += theme.bold(markdownInline(text.slice(i + 2, close), theme));
        i = close + 2;
        continue;
      }
    }
    if (char === "*") {
      const close = text.indexOf("*", i + 1);
      if (close > i + 1) {
        const inner = markdownInline(text.slice(i + 1, close), theme);
        out += theme.italic ? theme.italic(inner) : theme.fg("syntaxString", inner);
        i = close + 1;
        continue;
      }
    }
    if (char === "[") {
      const label = text.indexOf("]", i + 1);
      if (label !== -1 && text[label + 1] === "(") {
        const target = text.indexOf(")", label + 2);
        if (target !== -1) {
          out += theme.fg("mdLink", text.slice(i, label + 1)) + theme.fg("mdLinkUrl", text.slice(label + 1, target + 1));
          i = target + 1;
          continue;
        }
      }
    }
    out += char;
    i++;
  }
  return out;
}

/** A `#` heading, a `>` quote, a list bullet, then the inline forms. */
function markdownLine(text: string, theme: ThemeLike): string {
  const heading = /^ {0,3}#{1,6}(?:\s|$)/.exec(text);
  if (heading) return theme.fg("mdHeading", theme.bold(text));
  const quote = /^( {0,3}>\s?)([\s\S]*)$/.exec(text);
  if (quote) return theme.fg("mdQuote", quote[1]!) + markdownInline(quote[2]!, theme);
  const bullet = /^( {0,3}(?:[-+*]|\d{1,9}[.)])\s+)([\s\S]*)$/.exec(text);
  if (bullet) return theme.fg("mdListBullet", bullet[1]!) + markdownInline(bullet[2]!, theme);
  const rule = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.exec(text);
  if (rule) return theme.fg("mdCode", text);
  return markdownInline(text, theme);
}

/** The `\x1b[38;…m` a theme slot opens with, for comparing painted output. */
function fgPrefix(theme: ThemeLike, color: string): string {
  const sentinel = "\u0000";
  let painted: string;
  try {
    painted = theme.fg(color, sentinel);
  } catch {
    return "";
  }
  const at = painted.indexOf(sentinel);
  return at > 0 ? painted.slice(0, at) : "";
}

/**
 * Whether the highlighter returned the flat `mdCodeBlock` paint it uses when it
 * has no grammar (or failed): either byte-identical to that paint, or carrying no
 * colour beyond it.
 */
function looksUnhighlighted(lines: readonly string[], code: string, theme: ThemeLike): boolean {
  const flat = code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
  if (lines.length === flat.length && lines.every((line, index) => line === flat[index])) return true;
  const prefix = fgPrefix(theme, "mdCodeBlock");
  const allowed = new Set([prefix, "\x1b[39m", "\x1b[0m"]);
  return lines.every((line) => [...line.matchAll(ANSI_RE)].every((match) => allowed.has(match[0])));
}

const MARKDOWN_LANGUAGES = new Set(["markdown", "md", "mdx"]);
const LATEX_LANGUAGES = new Set(["latex", "tex", "ltx"]);

/**
 * Highlighted lines for `code`, one per source line.
 *
 * `lang` is a highlight.js language name (`resolveLanguageFromPath`'s answer).
 * Markdown and LaTeX get the deterministic fallback whenever pi's highlighter
 * could not parse them, which on a cold start is always.
 */
export function highlightLines(code: string, lang: string | undefined, theme: ThemeLike): string[] {
  const source = code.split("\n");
  const language = typeof lang === "string" ? lang.trim().toLowerCase() : "";
  let lines: string[] | undefined;
  if (language) {
    try {
      lines = highlightCode(code, language);
    } catch {
      lines = undefined;
    }
  }
  if (!lines || lines.length !== source.length) {
    lines = source.map((line) => theme.fg("mdCodeBlock", line));
  }
  if (!language || !looksUnhighlighted(lines, code, theme)) return lines;
  if (LATEX_LANGUAGES.has(language)) {
    return source.map((line) => latexLine(line.replace(CONTROL_RE, " "), theme));
  }
  if (MARKDOWN_LANGUAGES.has(language)) {
    return source.map((line) => markdownLine(line.replace(CONTROL_RE, " "), theme));
  }
  return lines;
}
