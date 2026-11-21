/**
 * `diffContext`: how many unchanged lines an edit's diff keeps on each side of a
 * change. pi writes four; tidy cuts that down in the panes and in pi's unified diff.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditToolDefinition, generateDiffString, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { patchToolBoxFrames } from "../src/frame.ts";
import { PI_DIFF_CONTEXT, trimDiffContext } from "../src/tools/diff-context.ts";

initTheme("dark");
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const BEFORE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
const AFTER = BEFORE.replace("line 10\n", "line ten\n").replace("line 17\n", "line seventeen\n");
/** pi's own diff of the two: four lines either side, the rest folded. */
const PI_DIFF = generateDiffString(BEFORE, AFTER).diff;
const numbers = (diff: string) => diff.split("\n").map((row) => /^[ +-] *(\d+) /.exec(row)?.[1] ?? row.trim());

test("pi's own context is four lines, and four or more changes nothing", () => {
  assert.equal(PI_DIFF_CONTEXT, 4);
  assert.deepEqual(numbers(PI_DIFF), ["...", "6", "7", "8", "9", "10", "10", "11", "12", "13", "14", "15", "16", "17", "17", "18", "19", "20"]);
  assert.equal(trimDiffContext(PI_DIFF, 4), PI_DIFF);
  assert.equal(trimDiffContext(PI_DIFF, 9), PI_DIFF);
});

test("fewer lines keep that many on each side of a change, and the rest folds into one `...`", () => {
  assert.deepEqual(numbers(trimDiffContext(PI_DIFF, 2)), ["...", "8", "9", "10", "10", "11", "12", "...", "15", "16", "17", "17", "18", "19", "..."]);
  assert.deepEqual(numbers(trimDiffContext(PI_DIFF, 1)), ["...", "9", "10", "10", "11", "...", "16", "17", "17", "18", "..."]);
  assert.deepEqual(numbers(trimDiffContext(PI_DIFF, 0)), ["...", "10", "10", "...", "17", "17", "..."]);
  // The fold keeps pi's own shape: a blank where the number goes.
  const fold = trimDiffContext(PI_DIFF, 1).split("\n").find((row) => row.trim() === "...");
  assert.equal(fold, PI_DIFF.split("\n").find((row) => row.trim() === "..."));
});

test("a short stretch between two changes stays whole when nothing would fold", () => {
  const near = generateDiffString("a\nb\nc\nd\ne", "A\nb\nc\nd\nE").diff;
  assert.equal(trimDiffContext(near, 2), near, "three lines between two changes fit in two either side");
  assert.deepEqual(numbers(trimDiffContext(near, 1)), ["1", "1", "2", "...", "4", "5", "5"]);
});

test("text that is not pi's numbered diff comes back as it was", () => {
  for (const text of ["", "plain text", "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", " 1 a\n 2 b"]) {
    assert.equal(trimDiffContext(text, 1), text, JSON.stringify(text));
  }
});

// ── In an edit box ──────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "pi-tidy-context-"));
const editDef = createEditToolDefinition(dir);
const ui = { requestRender: () => {} };

/** pi computes the preview asynchronously (it reads the file); give it a beat. */
async function editBox(name: string, width: number, ready: (text: string) => boolean): Promise<string> {
  const file = join(dir, name);
  writeFileSync(file, BEFORE);
  const component = new ToolExecutionComponent(
    "edit",
    `call-${name}`,
    { path: file, edits: [{ oldText: "line 10\n", newText: "line ten\n" }] },
    {},
    editDef as any,
    ui as any,
    dir,
  );
  component.setArgsComplete();
  component.setExpanded(true);
  let text = component.render(width).map(plain).join("\n");
  for (let attempt = 0; attempt < 40 && !ready(text); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    text = component.render(width).map(plain).join("\n");
  }
  return text;
}

for (const [mode, width] of [["panes", 110], ["unified", 60]] as const) {
  test(`${mode}: an edit box keeps diffContext lines around its change`, async () => {
    const shown = /line ten/;
    patchToolBoxFrames({ icons: false, splitDiff: true, splitDiffMinWidth: 72, diffContext: 4 });
    const four = await editBox(`${mode}-4.txt`, width, (text) => shown.test(text));
    assert.match(four, /line 6\b/, four);
    patchToolBoxFrames({ icons: false, splitDiff: true, splitDiffMinWidth: 72, diffContext: 1 });
    const one = await editBox(`${mode}-1.txt`, width, (text) => shown.test(text));
    assert.match(one, /line ten/, one);
    assert.match(one, /line 9\b/, one);
    assert.match(one, /line 11\b/, one);
    assert.doesNotMatch(one, /line (?:6|7|8|12|13|14)\b/, one);
    patchToolBoxFrames({ icons: false, splitDiff: true, splitDiffMinWidth: 72 });
  });
}
