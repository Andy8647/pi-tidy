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

// ─────────────────────────────────────────────────────────────────────────────
// Failure emphasis: one red, and only where there is something to read
// ─────────────────────────────────────────────────────────────────────────────

const named = { fg: (token: string, text: string) => `<${token}>${text}</${token}>`, bold: (text: string) => text } as any;

test("a folded group's failed count is the only red left", () => {
  const line = formatGroupLine(
    buildGroupSummary([
      { toolName: "bash", isPartial: false, durationMs: 100 },
      { toolName: "bash", isPartial: false, durationMs: 100, isError: true },
    ]),
    named,
    { icons: false },
  );
  // Folded: no row hangs below, so this line has to say it — in red.
  assert.match(line, /<error>1 failed<\/error>/);
  // Open: every failed row carries its own ✗, so the count goes quiet.
  const open = formatGroupLine(
    buildGroupSummary([
      { toolName: "bash", isPartial: false, durationMs: 100 },
      { toolName: "bash", isPartial: false, durationMs: 100, isError: true },
    ]),
    named,
    { icons: false, open: true },
  );
  assert.match(open, /<muted>1 failed<\/muted>/);
  assert.doesNotMatch(open, /<error>/);
});

test("a failure's note is data, not an alarm: `exit 1` goes muted", () => {
  const line = formatToolLine(
    { toolName: "bash", args: { command: "sed -n 1,3p app.css" }, isPartial: false, result: textResult("sed: Is a directory\n\nCommand exited with code 1", { isError: true }) },
    named,
    { icons: false },
  );
  assert.match(line, /<error>✗<\/error>/);
  assert.match(line, /<toolTitle>bash<\/toolTitle>/, "an error with output keeps full contrast");
  assert.match(line, /<muted>exit 1<\/muted>/);
});

test("a failure that printed nothing is dimmed, its glyph stays red", () => {
  const line = formatToolLine(
    { toolName: "bash", args: { command: "test -d apps" }, isPartial: false, result: textResult("(no output)\n\nCommand exited with code 1", { isError: true }) },
    named,
    { icons: false },
  );
  assert.match(line, /<error>✗<\/error>/);
  assert.match(line, /<dim>bash<\/dim>/);
  assert.match(line, /<dim> test -d apps<\/dim>/);
  assert.match(line, /<dim>exit 1<\/dim>/);
  assert.doesNotMatch(line, /<toolTitle>/);
});

test("silence is pi's notices only — a timeout or an abort is worth reading", () => {
  const timeout = formatToolLine(
    { toolName: "bash", args: { command: "sleep 30" }, isPartial: false, result: textResult("Command timed out after 30 seconds", { isError: true }) },
    named,
    { icons: false },
  );
  assert.doesNotMatch(timeout, /<dim>/);
  assert.match(timeout, /<toolTitle>bash<\/toolTitle>/);
});

test("hover adds a › hint to a tool row and turns ▸ into ▶ on the summary", () => {
  const row = formatToolLine(
    { toolName: "read", args: { path: "src/app.ts" }, isPartial: false, result: textResult("a\nb") },
    named,
    { icons: false, hovered: true },
  );
  assert.match(row, /›<\/muted>$/);
  const summary = buildGroupSummary([{ toolName: "bash", isPartial: false, durationMs: 100 }]);
  assert.match(formatGroupLine(summary, named, { icons: false, hovered: true }), /<accent>▶<\/accent>/);
  assert.doesNotMatch(formatToolLine(
    { toolName: "read", args: { path: "src/app.ts" }, isPartial: false, result: textResult("a\nb") },
    named,
    { icons: false },
  ), /›/);
});
