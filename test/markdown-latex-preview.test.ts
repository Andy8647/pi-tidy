/**
 * Markdown and LaTeX previews, end to end: which path is which language, the
 * fallback highlighter pi has no grammar for, the `write` and `read` boxes that
 * draw a document instead of source, and the diff / fenced-block paths that had
 * to learn `.tex` and `md` as well.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  createReadPreviewComponent,
  findMathSpans,
  renderLatexPreviewLines,
  renderMarkdownLines,
  wrapLatexLines,
} from "../src/tools/markdown-latex-preview.ts";
import { highlightLines, isLatexPath, isMarkdownPath, resolveLanguageFromPath } from "../src/tools/lang-support.ts";
import { createWriteCallComponent, formatWriteCallText } from "../src/tools/write-preview.ts";
import { ruleCodeToken } from "../src/turns/code-blocks.ts";
import { SWATCH_GLYPH } from "../src/messages/hex-swatches.ts";
import { renderSplitDiff } from "../src/tools/split-diff.ts";
import tidy from "../src/index.ts";
import { harness, loadTidy as load } from "./renderer-harness.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/ +$/gm, "");
const rows = (lines: readonly string[]) => lines.map(plain).join("\n");
/** Highlighted source lines, ANSI kept: colour assertions need the escapes. */
const raw = (code: string, lang: string) => highlightLines(code, lang, theme).join("\n");

const loadTidy = (pi: Parameters<typeof load>[1], config: Record<string, unknown> = {}) =>
  load(tidy, pi, { highlightBash: false, backgroundJobs: false, ...config });

// ── paths ───────────────────────────────────────────────────────────────────

test("markdown and latex paths are recognised case-insensitively", () => {
  for (const path of ["a.md", "/tmp/a.MD", "notes.markdown", "page.mdx", "report.Rmd"]) {
    assert.ok(isMarkdownPath(path), path);
    assert.ok(!isLatexPath(path), path);
  }
  for (const path of ["main.tex", "x.LATEX", "paper.ltx", "preamble.sty", "notes.cls", "refs.bib"]) {
    assert.ok(isLatexPath(path), path);
    assert.ok(!isMarkdownPath(path), path);
  }
  for (const path of ["a.ts", "README", ".md", "notes.txt", "a.tex.bak", "/tmp/md/x.ts"]) {
    assert.ok(!isMarkdownPath(path), path);
    assert.ok(!isLatexPath(path), path);
  }
});

test("resolveLanguageFromPath keeps pi's answer and fills in its gaps", () => {
  assert.equal(resolveLanguageFromPath("a.ts"), "typescript");
  assert.equal(resolveLanguageFromPath("a.md"), "markdown");
  assert.equal(resolveLanguageFromPath("a.markdown"), "markdown");
  assert.equal(resolveLanguageFromPath("a.mdx"), "markdown");
  assert.equal(resolveLanguageFromPath("a.rmd"), "markdown");
  for (const path of ["a.tex", "a.latex", "a.ltx", "a.sty", "a.cls", "a.bib"]) {
    assert.equal(resolveLanguageFromPath(path), "latex", path);
  }
  assert.equal(resolveLanguageFromPath("a.txt"), undefined);
  assert.equal(resolveLanguageFromPath("Makefile"), "makefile", "pi's own answer wins");
  assert.equal(resolveLanguageFromPath("" ), undefined);
  assert.equal(resolveLanguageFromPath(undefined), undefined);
});

// ── the fallback highlighter ────────────────────────────────────────────────

test("a .tex line is highlighted when pi's highlighter has no grammar", () => {
  const lines = raw("% a comment\n\\documentclass{article}", "latex").split("\n");
  assert.equal(lines.length, 2, "one row per source line");
  assert.ok(lines[0]!.includes(theme.fg("syntaxComment", "% a comment")), lines[0]);
  assert.ok(lines[1]!.includes(theme.fg("syntaxKeyword", "\\documentclass")), lines[1]);
  assert.ok(lines[1]!.includes(theme.fg("syntaxPunctuation", "{")), lines[1]);
});

test("latex math spans and escaped percents", () => {
  const lines = raw("50\\% of $x^2$ and \\[y\\]", "latex").split("\n");
  assert.ok(lines[0]!.includes(theme.fg("syntaxString", "$x^2$")), lines[0]);
  assert.ok(!lines[0]!.includes(theme.fg("syntaxComment", "% of ")), "an escaped % opens no comment");
  assert.ok(plain(lines[0]!).startsWith("50\\% of "), plain(lines[0]!));
});

test("a markdown line is highlighted when pi's highlighter has no grammar", () => {
  for (const lang of ["markdown", "md", "mdx"]) {
    const lines = raw("# Title\n> quote\n- `code` and [link](u)\nplain", lang).split("\n");
    assert.equal(lines.length, 4, lang);
    assert.ok(lines[0]!.includes(theme.fg("mdHeading", theme.bold("# Title"))), lines[0]);
    assert.ok(lines[1]!.includes(theme.fg("mdQuote", "> ")), lines[1]);
    assert.ok(lines[2]!.includes(theme.fg("mdListBullet", "- ")), lines[2]);
    assert.ok(lines[2]!.includes(theme.fg("mdCode", "`code`")), lines[2]);
    assert.ok(lines[2]!.includes(theme.fg("mdLink", "[link]")), lines[2]);
    assert.equal(lines[3], "plain", "unstyled text stays as it was");
  }
});

test("markdown emphasis is bold and italic, not a colour", () => {
  const [line] = raw("**bold** and *italic*", "markdown").split("\n");
  assert.ok(line!.includes(theme.bold("bold")), line);
  assert.ok(line!.includes(theme.italic ? theme.italic("italic") : "italic"), line);
  assert.ok(!plain(line!).includes("*"), plain(line!));
});

test("every language keeps its line count; the fallback keeps control characters out", () => {
  const source = "a\u0007b\nc\rd\n\nlast";
  for (const lang of ["latex", "markdown", "typescript", undefined]) {
    const lines = highlightLines(source, lang, theme);
    assert.equal(lines.length, source.split("\n").length, String(lang));
    if (lang === "latex" || lang === "markdown") {
      for (const line of lines) assert.doesNotMatch(plain(line), /[\u0000-\u0008\u000b-\u001f\u007f]/, String(lang));
    }
  }
});

test("a language pi can highlight is left to pi", () => {
  const code = "const a = 1;";
  const lines = highlightLines(code, "typescript", theme);
  assert.equal(plain(lines[0]!), code);
  assert.equal(lines[0], highlightLines(code, "typescript", theme)[0]);
  assert.ok(lines[0]!.includes("\x1b["), "still highlighted");
});

// ── LaTeX bodies ────────────────────────────────────────────────────────────

const TEX = [
  "% \\alpha in a comment is not math",
  "\\documentclass{article}",
  "\\begin{document}",
  "Inline $\\alpha + \\beta$ here.",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "\\begin{equation}",
  "\\frac{a}{b} = c",
  "\\end{equation}",
  "",
  "\\begin{eqnarray}x=1\\end{eqnarray}",
  "\\end{document}",
].join("\n");

test("a LaTeX body renders its math and keeps the rest as source", () => {
  const out = rows(renderLatexPreviewLines(TEX, theme));
  assert.match(out, /Inline α \+ β here\./, out);
  assert.match(out, /E = mc²/, out);
  assert.match(out, /^a$/m, "the fraction's numerator");
  assert.match(out, /─ = c/, out);
  assert.match(out, /\\documentclass\{article\}/, "source lines stay");
  assert.match(out, /% \\alpha in a comment is not math/, "a comment is not math");
  assert.match(out, /\\begin\{eqnarray\}x=1\\end\{eqnarray\}/, "math pi cannot parse stays as source");
});

test("a LaTeX document starting with display math has no extra leading row", () => {
  const lines = renderLatexPreviewLines("$$x^2$$", theme);
  assert.match(plain(lines[0]!), /x²/);
  assert.match(plain(renderLatexPreviewLines("\\section{Intro}", theme)[0]!), /Intro/);
});

test("renderMath: false is the highlighted source and nothing else", () => {
  const out = rows(renderLatexPreviewLines(TEX, theme, { renderMath: false }));
  assert.match(out, /\$\\alpha \+ \\beta\$/, out);
  assert.match(out, /E = mc\^2/, out);
  assert.doesNotMatch(out, /α|²/);
});

test("math spans are found outside comments and code, block forms first", () => {
  const spans = findMathSpans("a $x$\n% $y$\n\n$$\nz\n$$\n\n\\begin{align}w\\end{align}");
  assert.deepEqual(
    spans.map((span) => [span.expr, span.display]),
    [
      ["x", false],
      ["\nz\n", true],
      ["\\begin{align}w\\end{align}", true],
    ],
  );
});

test("a \\begin{document} is not treated as math", () => {
  const spans = findMathSpans("\\begin{document}\nx\n\\end{document}");
  assert.deepEqual(spans, []);
});

test("a LaTeX body has no raw control characters or CRs", () => {
  const out = renderLatexPreviewLines("a\r\nb\u0007c\n$\\alpha$", theme);
  for (const line of out) assert.doesNotMatch(plain(line), /[\u0000-\u0008\u000b-\u001f\u007f\r]/);
  assert.equal(out.length, 3, "CRLF is one line break, not two");
});

test("wrapLatexLines keeps every row inside the width", () => {
  const long = `\\section{${"very long heading text ".repeat(8)}}`;
  const wrapped = wrapLatexLines(renderLatexPreviewLines(long, theme), 40);
  assert.ok(wrapped.length > 1, "it wrapped");
  for (const line of wrapped) assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}: ${line}`);
});

// ── Markdown bodies ─────────────────────────────────────────────────────────

test("a Markdown body renders headings, lists and math", () => {
  const out = rows(renderMarkdownLines("# Title\n\n- one\n- two\n\n$$x^2$$", 60));
  assert.match(out, /^Title$/m, out);
  assert.doesNotMatch(out, /^#/m);
  assert.match(out, /one/);
  assert.match(out, /x²/);
});

test("renderLatex: false leaves the math as written", () => {
  const out = rows(renderMarkdownLines("$$x^2$$", 60, { renderLatex: false }));
  assert.match(out, /x\^2/, out);
});

test("a Markdown body renders its display environments", () => {
  const out = rows(renderMarkdownLines("\\begin{equation}\\alpha\\end{equation}", 60, { renderLatex: true }));
  assert.match(out, /α/, out);
});

test("terminal escapes in the file never reach the terminal", () => {
  const escaped = "# T\n\n\u001b[31mred\u001b[39m";
  const markdown = renderMarkdownLines(escaped, 40).join("\n");
  assert.ok(!markdown.includes("\u001b[31m"), markdown);
  const latex = renderLatexPreviewLines(escaped, theme).join("\n");
  assert.ok(!latex.includes("\u001b[31m"), latex);
});

// ── the write box ───────────────────────────────────────────────────────────

const writeOptions = { expanded: true, lines: 10, renderMarkdown: true, renderLatex: true };

test("a written .md file is drawn as Markdown", () => {
  const component = createWriteCallComponent({ path: "/tmp/notes.md", content: "# Title\n\nBody **bold**" }, theme, writeOptions);
  assert.ok(component, "a component, not a Text row");
  const out = rows(component!.render(60));
  assert.match(out, /write .*notes\.md/, "the header stays");
  assert.match(out, /^Title$/m, out);
  assert.doesNotMatch(out, /^# Title$/m);
  assert.match(out, /Body/);
});

test("a written .tex file is highlighted, and its math rendered", () => {
  const content = "\\section{Intro}\nInline $\\alpha + \\beta$ end";
  const component = createWriteCallComponent({ path: "/tmp/main.tex", content }, theme, writeOptions);
  assert.ok(component);
  const lines = component!.render(60);
  assert.match(rows(lines), /write .*main\.tex/);
  assert.ok(lines.some((line) => line.includes(theme.fg("syntaxKeyword", "\\section"))), rows(lines));
  assert.match(rows(lines), /α \+ β/, rows(lines));
});

test("renderLatex: false keeps the .tex source", () => {
  const component = createWriteCallComponent(
    { path: "/tmp/main.tex", content: "$\\alpha$" },
    theme,
    { ...writeOptions, renderLatex: false },
  );
  assert.equal(component, undefined, "no LaTeX preview, so the plain source row is used");
});

test("anything that is not Markdown or LaTeX keeps pi's plain row", () => {
  for (const [path, config] of [
    ["/tmp/a.ts", {}],
    ["/tmp/a.txt", {}],
    ["/tmp/notes.md", { renderMarkdown: false }],
    ["/tmp/main.tex", { renderLatex: false }],
  ] as const) {
    assert.equal(
      createWriteCallComponent({ path, content: "# x" }, theme, { ...writeOptions, ...config }),
      undefined,
      path,
    );
  }
  assert.equal(createWriteCallComponent({ path: "/tmp/a.md", content: "" }, theme, writeOptions), undefined, "no body");
});

test("the document preview honours writeLines and says what it left out", () => {
  const content = Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  const args = { path: "/tmp/long.md", content };
  const collapsed = createWriteCallComponent(args, theme, { ...writeOptions, expanded: false, lines: 3 })!.render(40);
  const shown = collapsed.filter((line) => /Paragraph/.test(line)).length;
  assert.ok(shown > 0 && shown < 20, `${shown} paragraphs in the budget`);
  assert.match(rows(collapsed), /\.\.\. \(\d+ more lines, \d+ total, .*expand\)/);

  const hidden = createWriteCallComponent(args, theme, { ...writeOptions, expanded: false, lines: 0 })!.render(40);
  assert.doesNotMatch(rows(hidden), /Paragraph/);
  assert.match(rows(hidden), /more lines/);

  const expanded = createWriteCallComponent(args, theme, writeOptions)!.render(40);
  assert.equal(expanded.filter((line) => /Paragraph/.test(line)).length, 20);
  assert.doesNotMatch(rows(expanded), /more lines/);
});

test("a reused write preview refreshes its header when the theme changes", () => {
  let marker = "old:";
  const dynamicTheme = new Proxy(theme, {
    get(target, property) {
      if (property === "fg") return (slot: string, text: string) => `${marker}${text}`;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const component = createWriteCallComponent({ path: "/tmp/notes.md", content: "# Title" }, dynamicTheme, writeOptions)!;
  assert.match(rows(component.render(60)), /old:write/);
  marker = "new:";
  component.invalidate();
  assert.match(rows(component.render(60)), /new:write/);
});

test("a .tex file's plain row is highlighted even without the document preview", () => {
  const text = formatWriteCallText({ path: "/tmp/main.tex", content: "% note\n\\alpha" }, theme, { expanded: true, lines: 10 });
  assert.ok(text.includes(theme.fg("syntaxComment", "% note")), plain(text));
  assert.ok(text.includes(theme.fg("syntaxKeyword", "\\alpha")), plain(text));
});

test("a .ts file's plain row is unchanged by any of this", () => {
  const text = formatWriteCallText({ path: "/tmp/a.ts", content: "const a = 1;" }, theme, { expanded: true, lines: 10 });
  assert.match(plain(text), /^write .*a\.ts\n\nconst a = 1;$/);
});

// ── the read box ────────────────────────────────────────────────────────────

const MD = "# Title\n\nSome **text**.\n";
const READ_ARGS = { file_path: "/tmp/notes.md" };

/** A renderer with the harness's loose context: pi's types want the whole tool box. */
type LooseRender = (result: any, options: any, theme: any, context: any) => { render(width: number): string[] };

function readRenderer(h: ReturnType<typeof harness>, base: any): LooseRender {
  return h.resolve("read", base)!.renderResult as unknown as LooseRender;
}

const downstreamText = () => new Text("downstream body", 0, 0);
const baseRenderers = () => ({ renderResult: downstreamText });

test("an expanded read of a .md file is drawn as Markdown", () => {
  const h = harness();
  loadTidy(h.pi);
  const base = baseRenderers();
  const result = { content: [{ type: "text", text: MD }], details: undefined };
  const component = readRenderer(h, base)(result, { expanded: true, isPartial: false }, theme, {
    args: READ_ARGS,
    isError: false,
  });
  const out = rows(component.render(60));
  assert.match(out, /^Title$/m, out);
  assert.match(out, /Some \*\*text\*\*|Some text/, out);
  assert.ok(out.startsWith("\n"), "pi's renderers open with a blank row");
});

test("an expanded read of a .tex file renders its math", () => {
  const h = harness();
  loadTidy(h.pi);
  const result = { content: [{ type: "text", text: "\\section{Hi}\n$\\alpha + \\beta$" }], details: undefined };
  const component = readRenderer(h, baseRenderers())(result, { expanded: true, isPartial: false }, theme, {
    args: { file_path: "/tmp/main.tex" },
    isError: false,
  });
  const out = component.render(60).join("\n");
  assert.match(plain(out), /α \+ β/, plain(out));
  assert.ok(out.includes(theme.fg("syntaxKeyword", "\\section")), plain(out));
});

test("a collapsed read, an error, and any other file are left to pi", () => {
  const h = harness();
  loadTidy(h.pi);
  const base = baseRenderers();
  const render = readRenderer(h, base);
  const result = { content: [{ type: "text", text: MD }], details: undefined };
  for (const [options, context] of [
    [{ expanded: false, isPartial: false }, { args: READ_ARGS, isError: false }],
    [{ expanded: true, isPartial: false }, { args: READ_ARGS, isError: true }],
    [{ expanded: true, isPartial: false }, { args: { file_path: "/tmp/a.ts" }, isError: false }],
    [{ expanded: true, isPartial: false }, { args: {}, isError: false }],
  ] as const) {
    const component = render(result, options, theme, context);
    assert.equal(rows(component.render(60)), "downstream body", JSON.stringify(context));
  }
});

test("a document preview is not handed to pi's Text renderer on collapse or error", () => {
  const h = harness();
  loadTidy(h.pi);
  const base = createReadToolDefinition(process.cwd());
  const render = readRenderer(h, base);
  const result = { content: [{ type: "text", text: MD }], details: undefined };
  for (const isError of [false, true]) {
    const context: any = { args: READ_ARGS, isError: false, state: {}, cwd: process.cwd(), showImages: true };
    const preview = render(result, { expanded: true, isPartial: false }, theme, context);
    context.lastComponent = preview;
    context.isError = isError;
    const delegated = render(result, { expanded: isError, isPartial: false }, theme, context);
    assert.ok(delegated instanceof Text);
    if (!isError) assert.equal(rows(delegated.render(80)), "");
  }
});

test("renderMarkdown: false leaves an expanded read to pi", () => {
  const h = harness();
  loadTidy(h.pi, { renderMarkdown: false });
  const component = readRenderer(h, baseRenderers())(
    { content: [{ type: "text", text: MD }], details: undefined },
    { expanded: true, isPartial: false },
    theme,
    { args: READ_ARGS, isError: false },
  );
  assert.equal(rows(component.render(60)), "downstream body");
});

test("real read truncation keeps pi's continuation and warning outside the rendered document", async () => {
  for (const source of [
    Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"),
    Array.from({ length: 600 }, () => "a".repeat(100)).join("\n"),
  ]) {
    const base = createReadToolDefinition(process.cwd(), {
      operations: { access: async () => {}, readFile: async () => Buffer.from(source), detectImageMimeType: async () => null },
    });
    const result = await base.execute("read", { path: "/tmp/notes.md" }, undefined, undefined, {} as any);
    assert.equal(result.details?.truncation?.truncated, true);
    const h = harness();
    loadTidy(h.pi);
    const context = { args: READ_ARGS, isError: false, state: {}, cwd: process.cwd(), showImages: true };
    const options = { expanded: true, isPartial: false };
    const lines = readRenderer(h, base)(result, options, theme, context).render(120);
    const piLines = base.renderResult!(result, options, theme, context as any).render(120);
    const piWarning = piLines.map(plain).find((line) => line.includes("[Truncated:"));
    assert.ok(piWarning, rows(piLines));
    assert.ok(lines.some((line) => plain(line).includes(piWarning.trim())), rows(lines));
    assert.ok(lines.some((line) => line.includes(theme.fg("warning", piWarning.trim()))), rows(lines));
    assert.match(rows(lines), /\[Showing lines .* Use offset=\d+ to continue\.\]/);
    assert.equal(rows(lines).match(/\[Showing lines/g)?.length, 1);
  }
});

test("an oversized first line stays with pi's renderer", async () => {
  const base = createReadToolDefinition(process.cwd(), {
    operations: { access: async () => {}, readFile: async () => Buffer.from("x".repeat(60000)), detectImageMimeType: async () => null },
  });
  const result = await base.execute("read", { path: "/tmp/notes.md" }, undefined, undefined, {} as any);
  assert.equal(result.details?.truncation?.firstLineExceedsLimit, true);
  const h = harness();
  loadTidy(h.pi);
  const context = { args: READ_ARGS, isError: false, state: {}, cwd: process.cwd(), showImages: true };
  const options = { expanded: true, isPartial: false };
  const actual = rows(readRenderer(h, base)(result, options, theme, context).render(120));
  const expected = rows(base.renderResult!(result, options, theme, context as any).render(120));
  assert.equal(actual, expected);
  assert.match(actual, /First line exceeds/);
});

test("a document's own truncation-looking text is not mistaken for a warning", () => {
  const h = harness();
  loadTidy(h.pi);
  const content = `${MD}\n[Truncated: this is part of the document]`;
  const component = readRenderer(h, baseRenderers())(
    { content: [{ type: "text", text: content }], details: undefined },
    { expanded: true, isPartial: false }, theme, { args: READ_ARGS, isError: false },
  );
  assert.match(rows(component.render(80)), /Truncated: this is part of the document/);
});

test("the read renderer reuses its preview until the body changes", () => {
  const h = harness();
  loadTidy(h.pi);
  const read = readRenderer(h, baseRenderers());
  const readContext = { args: READ_ARGS, isError: false, state: {} };
  const options = { expanded: true, isPartial: false };
  const result = { content: [{ type: "text", text: MD }], details: undefined };
  const firstRead = read(result, options, theme, readContext);
  const firstRows = firstRead.render(60);
  assert.strictEqual(read(result, options, theme, readContext), firstRead);
  assert.strictEqual(firstRead.render(60), firstRows);
  assert.notStrictEqual(firstRead.render(61), firstRows);
  assert.notStrictEqual(read({ content: [{ type: "text", text: "# Changed" }] }, options, theme, readContext), firstRead);
});

test("the write renderer reuses its preview until its content or expansion changes", () => {
  const h = harness();
  loadTidy(h.pi);
  const write = h.resolve("write")!.renderCall!;
  const writeContext = { state: {}, expanded: false } as any;
  const args = { path: "/tmp/notes.md", content: MD };
  const firstWrite = write(args, theme, writeContext);
  const firstWriteRows = firstWrite.render(60);
  assert.strictEqual(write({ ...args }, theme, writeContext), firstWrite);
  assert.strictEqual(firstWrite.render(60), firstWriteRows);
  assert.notStrictEqual(firstWrite.render(61), firstWriteRows);
  assert.notStrictEqual(write({ ...args, content: "# Changed" }, theme, writeContext), firstWrite);
  writeContext.expanded = true;
  const expanded = write(args, theme, writeContext);
  assert.notStrictEqual(expanded, firstWrite);
  assert.strictEqual(write(args, theme, writeContext), expanded);
  const expandedRows = expanded.render(60);
  expanded.invalidate();
  assert.notStrictEqual(expanded.render(60), expandedRows);
});

test("the read body wraps to the box width", () => {
  const long = `# ${"long heading words ".repeat(10)}`;
  const component = createReadPreviewComponent(long, theme, { kind: "markdown", renderLatex: true });
  for (const line of component.render(40)) assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}: ${plain(line)}`);
});

test("the read body is not rendered twice for the same width", () => {
  const component = createReadPreviewComponent(MD, theme, { kind: "markdown", renderLatex: true });
  const first = component.render(50);
  assert.equal(component.render(50), first, "the same array, from the cache");
  assert.notEqual(component.render(51), first, "a new width is a new render");
  component.invalidate();
  assert.notEqual(component.render(50), first);
});

// ── diffs and fenced blocks ─────────────────────────────────────────────────

test("a .tex diff is highlighted as LaTeX", () => {
  const panes = renderSplitDiff({
    diff: " \\documentclass{article}\n % a comment\n \\begin{document}",
    width: 100,
    theme,
    filePath: "/tmp/main.tex",
    numbered: false,
  });
  assert.ok(panes, "the panes fit");
  const out = panes!.lines.join("\n");
  assert.ok(out.includes(theme.fg("syntaxKeyword", "\\documentclass")), rows(panes!.lines));
  assert.ok(out.includes(theme.fg("syntaxComment", "% a comment")), rows(panes!.lines));
});

test("a .md diff is highlighted as Markdown", () => {
  const panes = renderSplitDiff({
    diff: " # Old heading\n # Another",
    width: 100,
    theme,
    filePath: "/tmp/notes.md",
    numbered: false,
  });
  assert.ok(panes);
  const out = panes!.lines.join("\n");
  assert.ok(out.includes(theme.fg("mdHeading", theme.bold("# Old heading"))), rows(panes!.lines));
});

function fenced(lang: string, text: string) {
  const lines = ["```" + lang, ...text.split("\n"), "```"];
  return ruleCodeToken(lines, { lang, text }, 100, {
    theme,
    icons: false,
    ruleColor: "border",
    enabled: true,
    splitDiff: false,
    splitDiffMinWidth: 72,
    canCopy: false,
  });
}

test("md, markdown and tex fences get real highlighting", () => {
  const colours = (rowsIn: readonly string[]) => new Set(rowsIn.flatMap((row) => row.match(/\x1b\[38;[0-9;]*m/g) ?? [])).size;
  const markdown = "# Heading\n> quote\n- `code`";
  for (const lang of ["md", "markdown"]) {
    const rendered = fenced(lang, markdown);
    assert.ok(rendered, lang);
    const body = rendered!.lines.slice(1, 1 + markdown.split("\n").length);
    assert.ok(colours(body) > 1, `${lang}: ${rows(body)}`);
    assert.ok(body.join("\n").includes(theme.fg("mdHeading", theme.bold("# Heading"))), rows(body));
  }
  const latex = "% note\n\\alpha + $x^2$";
  for (const lang of ["tex", "latex", "bib"]) {
    const rendered = fenced(lang, latex);
    assert.ok(rendered, lang);
    const body = rendered!.lines.slice(1, 1 + latex.split("\n").length);
    assert.ok(body.join("\n").includes(theme.fg("syntaxKeyword", "\\alpha")), rows(body));
    assert.ok(body.join("\n").includes(theme.fg("syntaxString", "$x^2$")), rows(body));
  }
});

test("a fence with an unknown language still keeps pi's rows", () => {
  const unchanged = ruleCodeToken(["```plaintextish", "hello", "```"], { lang: "plaintextish", text: "hello" }, 100, {
    theme,
    icons: false,
    ruleColor: "border",
    enabled: true,
    splitDiff: false,
    splitDiffMinWidth: 72,
    canCopy: false,
  });
  assert.ok(unchanged);
  assert.equal(rows(unchanged!.lines.slice(1, 2)), "hello");
});

// ── the markdown transformer ────────────────────────────────────────────────

test("one transformer does both the math wrapping and the hex swatches", () => {
  const h = harness();
  const transformers: Array<(markdown: string, context: { messageType: string }) => string> = [];
  (h.pi as any).registerMarkdownTransformer = (fn: (markdown: string, context: { messageType: string }) => string) => {
    transformers.push(fn);
  };
  loadTidy(h.pi);
  assert.equal(transformers.length, 1, "pi keeps one markdownTransformer per extension");
  const transform = transformers[0]!;
  const assistant = transform("\\begin{equation}x=1\\end{equation}\n\n#7f849c", { messageType: "assistant" });
  assert.match(assistant, /^\$\$$/m, assistant);
  assert.ok(assistant.includes(SWATCH_GLYPH), assistant);
  const thinking = transform("\\begin{equation}x=1\\end{equation}\n\n#7f849c", { messageType: "assistant-thinking" });
  assert.match(thinking, /^\$\$$/m, "math is not a style, thinking keeps it");
  assert.ok(!thinking.includes(SWATCH_GLYPH), "a dim thinking box gets no swatch");
});

test("renderLatex: false leaves the message's environments alone", () => {
  const h = harness();
  const transformers: Array<(markdown: string, context: { messageType: string }) => string> = [];
  (h.pi as any).registerMarkdownTransformer = (fn: (markdown: string, context: { messageType: string }) => string) => {
    transformers.push(fn);
  };
  loadTidy(h.pi, { renderLatex: false });
  const out = transformers[0]!("\\begin{equation}x=1\\end{equation}", { messageType: "assistant" });
  assert.equal(out, "\\begin{equation}x=1\\end{equation}");
});

// ── through a real tool box ─────────────────────────────────────────────────

test("a written .md file draws its Markdown inside pi's write box", () => {
  const h = harness();
  loadTidy(h.pi);
  const resolved = h.resolve("write")!;
  const base = createWriteToolDefinition(process.cwd());
  const definition = { ...base, renderCall: resolved.renderCall, renderResult: resolved.renderResult };
  const component = new ToolExecutionComponent(
    "write",
    "call-md",
    { path: "/tmp/notes.md", content: "# Title\n\nBody text" },
    {},
    definition as any,
    { requestRender() {} } as any,
    process.cwd(),
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult({ content: [], isError: false, durationMs: 1 }, false);
  component.setExpanded(true);
  const out = rows(component.render(80));
  assert.match(out, /notes\.md/);
  assert.match(out, /^.*Title.*$/m);
  assert.doesNotMatch(out, /# Title/);
});

test("a collapsed read preview picks up a theme change when reopened", () => {
  initTheme("dark");
  try {
    const h = harness();
    h.pi.registerTool(createReadToolDefinition(process.cwd()));
    loadTidy(h.pi);
    const resolved = h.resolve("read")!;
    const base = createReadToolDefinition(process.cwd());
    const definition = { ...base, renderCall: resolved.renderCall, renderResult: resolved.renderResult };
    const makeBox = () => {
      const box = new ToolExecutionComponent(
        "read", "call-theme", READ_ARGS, {}, definition as any, { requestRender() {} } as any, process.cwd(),
      );
      box.setArgsComplete();
      box.markExecutionStarted();
      box.updateResult({ content: [{ type: "text", text: MD }], isError: false, durationMs: 1 }, false);
      box.setExpanded(true);
      box.render(80);
      return box;
    };
    const box = makeBox();
    const darkRows = (box as any).resultRendererComponent.render(80);
    box.setExpanded(false);
    box.render(80);
    initTheme("light");
    box.invalidate();
    box.setExpanded(true);
    box.render(80);
    const reopenedRows = (box as any).resultRendererComponent.render(80);
    const freshRows = (makeBox() as any).resultRendererComponent.render(80);
    assert.notDeepEqual(darkRows, freshRows, "the themes must produce different output");
    assert.deepEqual(reopenedRows, freshRows, "reopened preview must use the current theme");
  } finally {
    initTheme("dark");
  }
});

test("a read .md file draws its Markdown in pi's read box", () => {
  const h = harness();
  h.pi.registerTool(createReadToolDefinition(process.cwd()));
  loadTidy(h.pi);
  const resolved = h.resolve("read")!;
  const base = createReadToolDefinition(process.cwd());
  const definition = { ...base, renderCall: resolved.renderCall, renderResult: resolved.renderResult };
  const component = new ToolExecutionComponent(
    "read",
    "call-read",
    { file_path: "/tmp/notes.md" },
    {},
    definition as any,
    { requestRender() {} } as any,
    process.cwd(),
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult({ content: [{ type: "text", text: MD }], isError: false, durationMs: 1 }, false);
  component.setExpanded(true);
  const out = rows(component.render(80));
  assert.match(out, /read .*notes\.md/, out);
  assert.match(out, /^.*Title.*$/m, out);
  assert.doesNotMatch(out, /# Title/);
  component.setExpanded(false);
  const collapsed = rows(component.render(80));
  assert.doesNotMatch(collapsed, /# Title|Some \*\*text\*\*/, collapsed);
  component.setExpanded(true);
  const reopened = rows(component.render(80));
  assert.match(reopened, /^.*Title.*$/m, reopened);
  assert.doesNotMatch(reopened, /# Title/);
});
