/**
 * The two one-line renderers. Colors are identity here, so assertions read as
 * plain text and the glyph/argument logic is what gets pinned down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGroupLine, formatToolLine, summarizeArgs, summarizeResult } from "../tool-lines.ts";
import { buildGroupSummary } from "../tool-groups.ts";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as any;

test("group line names the count, the per-tool breakdown and the duration", () => {
  const line = formatGroupLine(
    buildGroupSummary([
      { toolName: "bash", isPartial: false, durationMs: 1000 },
      { toolName: "bash", isPartial: false, durationMs: 150 },
      { toolName: "read", isPartial: false, durationMs: 50 },
    ]),
    theme,
    { icons: false },
  );
  assert.equal(line, " ▸ 3 calls · bash×2  read×1 · 1.2s");
});

test("group line reports a running tool instead of a duration", () => {
  const line = formatGroupLine(
    buildGroupSummary([{ toolName: "bash", isPartial: true, durationMs: undefined }]),
    theme,
    { icons: false },
  );
  assert.equal(line, " ▸ 1 call · bash×1 · running bash");
});

test("args summary: heredoc collapses to its first line and counts the rest", () => {
  assert.equal(summarizeArgs("bash", { command: "cd ~ && python3 - <<'PY'\nprint(1)\nPY" }), "cd ~ && python3 - <<'PY' (+2 lines)");
  assert.equal(summarizeArgs("read", { path: "src/app.ts" }), "src/app.ts");
  assert.equal(summarizeArgs("bash", {}), "");
  assert.equal(summarizeArgs("bash", { command: `echo ${"x".repeat(200)}` }).length, 60);
});

test("tool line carries the status glyph, name and duration", () => {
  const ok = formatToolLine(
    { toolName: "bash", args: { command: "ls -la" }, isPartial: false, result: { durationMs: 340 } },
    theme,
    { icons: false },
  );
  assert.equal(ok, " ✓ bash ls -la  0.3s");

  const running = formatToolLine({ toolName: "bash", args: { command: "sleep 5" }, isPartial: true }, theme, { icons: false });
  assert.equal(running, " ⋯ bash sleep 5");

  const failed = formatToolLine(
    { toolName: "bash", args: { command: "false" }, isPartial: false, result: { isError: true, durationMs: 10 } },
    theme,
    { icons: false },
  );
  assert.equal(failed, " ✗ bash false  0.0s");
});

test("group line counts failures", () => {
  const line = formatGroupLine(
    buildGroupSummary([
      { toolName: "bash", isPartial: false, durationMs: 100 },
      { toolName: "bash", isPartial: false, durationMs: 100, isError: true },
    ]),
    theme,
    { icons: false },
  );
  assert.equal(line, " ▸ 2 calls · bash×2 · 1 failed · 0.2s");
});

const textResult = (text: string, extra: { isError?: boolean; details?: unknown } = {}) => ({
  content: [{ type: "text", text }],
  ...extra,
});

test("result summary: what each built-in tool produced, in a few words", () => {
  assert.equal(summarizeResult("bash", textResult("a\nb\n\nc")), "3 lines");
  assert.equal(summarizeResult("bash", textResult("")), "", "no output: no note");
  assert.equal(summarizeResult("bash", textResult("boom\n\nCommand exited with code 2", { isError: true })), "exit 2");
  // A truncated result reports the original size, not the shown slice.
  assert.equal(
    summarizeResult("bash", textResult("x\n\n[Showing lines 801-1000 of 1000. Full output: /tmp/o]", { details: { truncation: { truncated: true, totalLines: 1000 } } })),
    "1000 lines",
  );
  assert.equal(summarizeResult("read", textResult("one\ntwo\n\n[Showing lines 1-2 of 40. Use offset=3 to continue.]")), "2 lines");
  assert.equal(summarizeResult("read", textResult("x", { isError: true })), "");
  assert.equal(summarizeResult("grep", textResult("a.ts:1: x\nb.ts:2: x")), "2 matches");
  assert.equal(summarizeResult("grep", textResult("No matches found")), "no matches");
  assert.equal(summarizeResult("find", textResult("a.ts")), "1 file");
  assert.equal(summarizeResult("find", textResult("No files found matching pattern")), "no files");
  assert.equal(summarizeResult("ls", textResult("a\nb/")), "2 entries");
  assert.equal(summarizeResult("ls", textResult("(empty directory)")), "empty");
  assert.equal(summarizeResult("mcp__github__search", textResult("lots")), "", "unknown tools get no note");
  assert.equal(summarizeResult("bash", undefined), "");
});

test("tool line puts the result note before the duration", () => {
  const line = formatToolLine(
    { toolName: "grep", args: { pattern: "TODO" }, isPartial: false, result: { durationMs: 300, ...textResult("a:1\nb:2") } },
    theme,
    { icons: false },
  );
  assert.equal(line, " ✓ grep TODO  2 matches · 0.3s");
});
