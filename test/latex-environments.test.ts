/**
 * A message's bare display-math environments: wrapped so pi's tokenizer sees
 * them, left alone when they are already inside code or inside math, and
 * actually rendered once pi gets the message.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { transformLatexEnvironments, transformLatexEnvironmentsCached } from "../src/messages/latex-environments.ts";

initTheme("dark");

const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/ +$/gm, "");
const render = (markdown: string, width = 80) =>
  new Markdown(transformLatexEnvironments(markdown), 0, 0, getMarkdownTheme(), undefined, { renderLatex: true })
    .render(width)
    .map(plain)
    .join("\n");

test("a single-line equation becomes a $$ block", () => {
  const out = transformLatexEnvironments("We have\n\n\\begin{equation}x=1\\end{equation}\n\ndone");
  assert.match(out, /^\$\$\n\\begin\{equation\}x=1\\end\{equation\}\n\$\$$/m);
  assert.match(out, /^We have$/m);
  assert.match(out, /^done$/m);
});

test("a multi-line align* is wrapped whole, backslashes and all", () => {
  const source = ["\\begin{align*}", "a &= b + c \\\\", "d &= e", "\\end{align*}"].join("\n");
  assert.equal(transformLatexEnvironments(source), `$$\n${source}\n$$`);
});

test("a bare cases block is display math too", () => {
  const source = "\\begin{cases}x & y\\\\z & w\\end{cases}";
  assert.equal(transformLatexEnvironments(source), `$$\n${source}\n$$`);
});

test("a cases nested in an align is part of the align, not wrapped twice", () => {
  const source = ["\\begin{align}", "x &= \\begin{cases}1 & y\\\\2 & z\\end{cases}", "\\end{align}"].join("\n");
  const out = transformLatexEnvironments(source);
  assert.equal(out, `$$\n${source}\n$$`);
  assert.equal(out.match(/\$\$/g)?.length, 2, "exactly one pair of delimiters");
});

test("nested aligned stays inside its equation", () => {
  const source = ["\\begin{equation}", "\\begin{aligned}a &= b\\end{aligned}", "\\end{equation}"].join("\n");
  const out = transformLatexEnvironments(source);
  assert.equal(out, `$$\n${source}\n$$`);
});

test("indentation is dropped, because $$ only opens a block within three columns", () => {
  const out = transformLatexEnvironments("      \\begin{equation}x=1\\end{equation}");
  assert.equal(out, "$$\n\\begin{equation}x=1\\end{equation}\n$$");
});

test("a fenced code block is left exactly as it was", () => {
  const source = "Example:\n\n```tex\n\\begin{equation}x=1\\end{equation}\n```\n";
  assert.equal(transformLatexEnvironments(source), source);
});

test("an inline code span is left exactly as it was", () => {
  const source = "Write `\\begin{equation}x=1\\end{equation}` to start.";
  assert.equal(transformLatexEnvironments(source), source);
});

test("math already wrapped in $$ or \\[ \\] is not wrapped again", () => {
  for (const source of [
    "$$\n\\begin{equation}x=1\\end{equation}\n$$",
    "\\[\n\\begin{equation}x=1\\end{equation}\n\\]",
  ]) {
    assert.equal(transformLatexEnvironments(source), source, source);
  }
});

test("an environment that shares its line with prose is left alone", () => {
  const source = "Since \\begin{equation}x=1\\end{equation} holds, we are done.";
  assert.equal(transformLatexEnvironments(source), source);
});

test("an unclosed environment is left alone", () => {
  const source = "\\begin{align}\na &= b";
  assert.equal(transformLatexEnvironments(source), source);
});

test("a \\begin{document} is not math and does not swallow the file", () => {
  const source = ["\\begin{document}", "\\begin{equation}x=1\\end{equation}", "\\end{document}"].join("\n");
  const out = transformLatexEnvironments(source);
  assert.match(out, /^\$\$\n\\begin\{equation\}x=1\\end\{equation\}\n\$\$$/m);
  assert.equal(out.match(/\$\$/g)?.length, 2);
});

test("an indented \\[ … \\] block is dedented so pi sees it", () => {
  const out = transformLatexEnvironments("    \\[\n    x = 1\n    \\]");
  assert.equal(out, "\\[\nx = 1\n\\]");
});

test("no latex leaves the message byte-identical", () => {
  for (const source of ["# Title\n\n- a\n- b", "#7f849c is a colour", ""]) {
    assert.equal(transformLatexEnvironments(source), source);
  }
});

test("the cached transform agrees with the plain one", () => {
  const source = "Text\n\n\\begin{align}a &= b\\end{align}\n";
  assert.equal(transformLatexEnvironmentsCached(source), transformLatexEnvironments(source));
  assert.equal(transformLatexEnvironmentsCached(source), transformLatexEnvironmentsCached(source));
  assert.equal(transformLatexEnvironmentsCached("plain prose"), "plain prose");
});

test("an equation renders as Unicode math through pi's Markdown", () => {
  const rows = render("Result:\n\n\\begin{equation}\n\\alpha + \\beta = \\frac{1}{2}\n\\end{equation}");
  assert.match(rows, /α \+ β/, rows);
  assert.match(rows, /─/, "the fraction is stacked");
  assert.doesNotMatch(rows, /\\begin\{equation\}/, "the source is gone");
});

test("an align renders one row per line", () => {
  const rows = render("\\begin{align}\na &= b + c \\\\\nd &= e\n\\end{align}");
  assert.match(rows, /^a = b \+ c$/m, rows);
  assert.match(rows, /^d = e$/m, rows);
  assert.doesNotMatch(rows, /\\begin/);
});

test("cases renders its brace column", () => {
  const rows = render("\\begin{cases}x & \\text{if } y\\\\z & \\text{else}\\end{cases}");
  assert.match(rows, /x if y/, rows);
  assert.match(rows, /z if else/, rows);
});

test("without wrapping, pi would have shown the raw environment", () => {
  const source = "\\begin{equation}x=1\\end{equation}";
  const bare = new Markdown(source, 0, 0, getMarkdownTheme(), undefined, { renderLatex: true })
    .render(80)
    .map(plain)
    .join("\n");
  assert.match(bare, /\\begin\{equation\}/, "the tokenizer does not know this form");
  assert.doesNotMatch(render(source), /\\begin\{equation\}/);
});
