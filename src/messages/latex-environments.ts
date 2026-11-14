/**
 * A message's bare display-math environments become math blocks pi can render.
 *
 * pi-tui's `Markdown` only tokenizes `$$…$$` and `\[…\]` as block math, while
 * its `renderLatex` understands `\begin{equation}`, `\begin{align*}`,
 * `\begin{cases}`, the matrices and friends. A model that writes
 *
 *     \begin{align}
 *       a &= b + c \\
 *       d &= e
 *     \end{align}
 *
 * in a reply therefore gets raw LaTeX, even though pi could draw it. This
 * transformer wraps such an environment in `$$ … $$` so the existing tokenizer
 * picks it up; nothing is rewritten, the environment keeps its own text.
 *
 * Left alone: fenced code blocks, inline code spans, and math that is already
 * wrapped in `$$…$$` or `\[…\]`. A `\begin{cases}` nested inside an outer
 * `\begin{align}` is part of the outer block and is not wrapped twice.
 *
 * Display only — `pi.registerMarkdownTransformer` never touches the session or
 * the model context.
 */

/**
 * Environments `renderLatex` renders as display math. `cases` counts: it is a
 * display construct even when it appears without an enclosing environment.
 */
export const DISPLAY_MATH_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "aligned",
  "alignedat",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "eqnarray",
  "eqnarray*",
  "displaymath",
  "cases",
  "cases*",
]);

/** Up to three spaces of indent, then a run of three or more of one char. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** An opener that pi's block tokenizer can see: it allows `{0,3}` indentation. */
const INDENTED_MATH_RE = /^([ \t]{4,})(\\\[|\$\$)[ \t]*$/;
const ANY_BEGIN_RE = /\\begin\{([A-Za-z]+\*?)\}/g;
const BLOCK_MATH_PATTERNS = [/\$\$[\s\S]*?\$\$/g, /\\\[[\s\S]*?\\\]/g];
const MAX_CACHE = 256;

interface Range {
  start: number;
  end: number;
}

/** Replace `[start, end)` with spaces, keeping newlines and therefore every index. */
function blank(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const range of ranges) {
    for (let i = Math.max(0, range.start); i < Math.min(chars.length, range.end); i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

/** The character ranges of fenced code blocks, fences included. */
function fenceRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let open: { char: string; length: number; start: number } | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const fence = FENCE_RE.exec(line);
    if (open) {
      if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && line.slice(fence[0].length).trim() === "") {
        ranges.push({ start: open.start, end: offset + line.length });
        open = undefined;
      }
    } else if (fence) {
      open = { char: fence[1]![0]!, length: fence[1]!.length, start: offset };
    }
    offset += line.length + 1;
  }
  // An unclosed fence runs to the end of the message: pi keeps it as code too.
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

/** Inline code spans (`` `…` ``, ` ``…`` `) within a single line. */
function inlineCodeRanges(text: string, skip: readonly Range[]): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let skipped = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    while (skipped < skip.length && skip[skipped]!.end < start) skipped++;
    if (skipped < skip.length && skip[skipped]!.start <= start && skip[skipped]!.end >= end) continue;
    let i = 0;
    while (i < line.length) {
      if (line[i] !== "`") {
        i++;
        continue;
      }
      let run = 1;
      while (line[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      let close = line.indexOf(ticks, i + run);
      while (close !== -1 && line[close + run] === "`") close = line.indexOf(ticks, close + run + 1);
      if (close === -1) break; // an unclosed run is literal text, not a span
      ranges.push({ start: start + i, end: start + close + run });
      i = close + run;
    }
  }
  return ranges;
}

/** Every line start index, for "is this the first thing on its line". */
function lineStartAt(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

function lineEndAt(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end === -1 ? text.length : end;
}

/**
 * The ranges of `\begin{ENV}…\end{ENV}` blocks that stand alone on their lines,
 * scanned on a masked copy so nothing inside code or existing math is seen.
 */
function displayEnvironmentRanges(masked: string): Range[] {
  const ranges: Range[] = [];
  ANY_BEGIN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumedTo = 0;
  while ((match = ANY_BEGIN_RE.exec(masked)) !== null) {
    const environment = match[1]!;
    const start = match.index;
    if (start < consumedTo) continue;
    if (!DISPLAY_MATH_ENVIRONMENTS.has(environment)) continue;
    // Standalone: nothing but whitespace before it on its line. The indent goes
    // into the replacement, because `$$` is only a block opener within three
    // columns.
    const lineStart = lineStartAt(masked, start);
    if (masked.slice(lineStart, start).trim() !== "") continue;
    const closer = `\\end{${environment}}`;
    const close = masked.indexOf(closer, start + match[0].length);
    if (close === -1) continue;
    const end = close + closer.length;
    if (masked.slice(end, lineEndAt(masked, end)).trim() !== "") continue;
    // The scan resumes past this block, so a `cases` nested in an `align` is
    // never wrapped on its own.
    ranges.push({ start: lineStart, end });
    consumedTo = end;
    ANY_BEGIN_RE.lastIndex = end;
  }
  return ranges;
}

/**
 * Wrap every standalone display-math environment in `$$ … $$`. Idempotent: a
 * second pass finds the `\begin` inside an existing `$$` block, which the mask
 * hides.
 */
function wrapDisplayEnvironments(markdown: string): string {
  if (!markdown.includes("\\begin{")) return markdown;
  const fences = fenceRanges(markdown);
  const code = inlineCodeRanges(markdown, fences);
  const excluded = [...fences, ...code];
  const maskedForMath = blank(markdown, excluded);
  const math: Range[] = [];
  for (const pattern of BLOCK_MATH_PATTERNS) {
    for (const match of maskedForMath.matchAll(pattern)) {
      math.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }
  const masked = blank(maskedForMath, math);
  const ranges = displayEnvironmentRanges(masked);
  if (ranges.length === 0) return markdown;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += `${markdown.slice(cursor, range.start)}$$\n${markdown.slice(range.start, range.end).trim()}\n$$`;
    cursor = range.end;
  }
  return out + markdown.slice(cursor);
}

/**
 * A `\[ … \]` or `$$ … $$` block indented past the three columns pi's block
 * tokenizer allows is dedented so it is recognised. Only the block's own lines
 * lose the indent; relative indentation inside it is kept.
 */
function normalizeIndentedBlocks(markdown: string): string {
  if (!/(?:^|\n)[ \t]{4,}(?:\\\[|\$\$)[ \t]*(?:\n|$)/.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opened = FENCE_RE.exec(line);
    if (fence) {
      if (opened && opened[1]![0] === fence.char && opened[1]!.length >= fence.length && line.slice(opened[0].length).trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (opened) {
      fence = { char: opened[1]![0]!, length: opened[1]!.length };
      continue;
    }
    const block = INDENTED_MATH_RE.exec(line);
    if (!block) continue;
    const closer = block[2] === "\\[" ? "\\]" : "$$";
    let end = i + 1;
    for (; end < lines.length; end++) {
      const candidate = FENCE_RE.exec(lines[end]!);
      if (candidate) break;
      if (lines[end]!.trim() === closer) break;
    }
    if (end >= lines.length || lines[end]!.trim() !== closer) continue;
    const indent = block[1]!;
    for (let row = i; row <= end; row++) {
      lines[row] = lines[row]!.startsWith(indent) ? lines[row]!.slice(indent.length) : lines[row]!.replace(/^[ \t]+/, "");
    }
    i = end;
  }
  return lines.join("\n");
}

/** The message with every bare display-math environment wrapped for pi's tokenizer. */
export function transformLatexEnvironments(markdown: string): string {
  if (!markdown.includes("\\begin{") && !markdown.includes("\\[") && !markdown.includes("$$")) return markdown;
  return normalizeIndentedBlocks(wrapDisplayEnvironments(markdown));
}

/**
 * The same transform, memoised. Streaming re-renders a growing message several
 * times a second and a settled reply re-renders on every width change; the
 * wrapped text only changes when the message does.
 */
const cache = new Map<string, string>();

export function transformLatexEnvironmentsCached(markdown: string): string {
  const hit = cache.get(markdown);
  if (hit !== undefined) return hit;
  const out = transformLatexEnvironments(markdown);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(markdown, out);
  return out;
}
