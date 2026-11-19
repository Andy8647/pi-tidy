/**
 * The opened body of a call with nested calls, drawn from the record alone.
 *
 * codemode's `details.calls` is the fixture here because it is the thinnest
 * record (clipped JSON arguments, no output): whatever reads well from it reads
 * at least as well from fabric's audits or a tool's own `output` and `diff`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeNestedBody, nestedSections, toggleNestedSection, type NestedBodyInput } from "../src/tools/nested-body.ts";
import { nestedRunOf } from "../src/tools/nested-calls.ts";
import { getTheme } from "../src/theme-access.ts";

initTheme("dark");
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();

const CODE = "const a = await tools.bash({ command: 'pwd' });\nawait tools.read({ path: 'src/app.ts' });\ntext(a);";
const HEADER = "Script completed\nWall time 0.1 seconds\nOutput:\n";

function body(
  calls: unknown[],
  options: { output?: string; width?: number; icons?: boolean; script?: boolean; outputOpen?: boolean; code?: string } = {},
): string[] {
  const input: NestedBodyInput = {
    args: { code: options.code ?? CODE },
    run: nestedRunOf({ calls })!,
    output: options.output ?? `${HEADER}\n==> text 1/2 <==\n/tmp\n==> text 2/2 <==\nsecond`,
    isError: false,
    diffLines: 8,
    splitDiff: true,
    splitDiffMinWidth: 72,
    outputLines: 1,
    state: { script: options.script ?? false, output: options.outputOpen ?? false },
    theme: getTheme()!,
    options: { icons: options.icons ?? false, ...(options.width === undefined ? { width: 80 } : { width: options.width }) },
  };
  return composeNestedBody(input).lines.map(strip);
}

const CALLS = [
  { id: "c/1", name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 50 },
  { id: "c/2", name: "read", args: '{"path":"src/app.ts"}', status: "ok", durationMs: 1 },
];

test("a closed body is a call list: the script and the output one row each", () => {
  const lines = body(CALLS);
  assert.equal(lines[0], " ▸ script · 3 lines");
  assert.match(lines[1]!, /^ ─+$/, "a rule closes the script");
  assert.match(lines[2]!, /^ ✓ bash pwd\s+50ms$/);
  assert.match(lines[3]!, /^ ✓ read src\/app\.ts\s+1ms$/);
  assert.match(lines[4]!, /^ ─+$/);
  assert.equal(lines[5], " ▸ output · 2 items", "codemode's markers become the count");
  assert.equal(lines.length, 6);
});

test("the durations share one column, past the longest arguments", () => {
  const lines = body(CALLS);
  assert.equal(lines[2]!.indexOf("50ms"), lines[3]!.indexOf("1ms"), lines.join("\n"));
});

test("an open script sits under its label, above the calls", () => {
  const lines = body(CALLS, { script: true });
  assert.equal(lines[0], " ▾ script · 3 lines");
  assert.equal(lines[1], " const a = await tools.bash({ command: 'pwd' });");
  assert.equal(lines[3], " text(a);");
  assert.match(lines[4]!, /^ ─+$/);
});

test("an open output drops the markers and separates the items, without the run's header", () => {
  const lines = body(CALLS, { outputOpen: true });
  const at = lines.indexOf(" ▾ output · 2 items");
  assert.deepEqual(lines.slice(at + 1), [" /tmp", "", " second"]);
  assert.ok(!lines.some((line) => line.includes("Script completed")), "the row above says how the run went");
});

test("plain output counts lines", () => {
  const lines = body(CALLS, { output: `${HEADER}\nfirst\nsecond\nthird` });
  assert.ok(lines.includes(" ▸ output · 3 lines"), lines.join("\n"));
});

test("a program that called nothing still folds its output", () => {
  const lines = body([], { output: `${HEADER}\nhi`, code: "text('hi')" });
  assert.deepEqual(lines.slice(0, 1), [" ▸ script · 1 line"]);
  assert.match(lines[1]!, /^ ─+$/, "one rule between the two folds");
  assert.equal(lines[2], " ▸ output · 1 line");
  assert.equal(lines.length, 3);
});

test("call rows take the kind icon; the script and the output do not", () => {
  const lines = body(CALLS, { icons: true });
  assert.match(lines[2]!, /^ ✓ \S+ bash/);
  assert.equal(lines[0], " ▸ script · 3 lines");
});

test("icons off still summarizes the arguments: that is not an icon thing", () => {
  const lines = body(CALLS, { icons: false });
  assert.ok(lines.some((line) => line.startsWith(" ✓ bash pwd")), lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes('{"command"')), "no JSON on the row");
});

test("two calls of the same tool keep their own arguments", () => {
  const lines = body([
    { name: "bash", args: '{"command":"git status"}', status: "ok", durationMs: 3 },
    { name: "bash", args: '{"command":"git diff"}', status: "ok", durationMs: 4 },
  ]);
  assert.ok(lines.some((line) => line.includes("git status")));
  assert.ok(lines.some((line) => line.includes("git diff")));
});

test("names share a column, so every call's arguments start on one cell", () => {
  const lines = body([
    { name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 3 },
    { name: "grep", args: '{"pattern":"TODO"}', status: "ok", durationMs: 4 },
    { name: "ls", args: '{"path":"src"}', status: "ok", durationMs: 1 },
  ]);
  const starts = lines.filter((line) => line.startsWith(" ✓")).map((line) => line.indexOf(line.trim().split(/\s+/)[2]!));
  assert.equal(new Set(starts).size, 1, lines.join("\n"));
});

test("a failure hangs its text under its row, without bash's exit trailer", () => {
  const lines = body([
    { name: "bash", args: '{"command":"false"}', status: "error", durationMs: 12, error: "boom\n\nCommand exited with code 1" },
  ]);
  const at = lines.findIndex((line) => line.startsWith(" ✗ bash false"));
  assert.ok(at >= 0, lines.join("\n"));
  assert.equal(lines[at + 1], "     boom");
  assert.ok(!lines.some((line) => line.includes("Command exited")), lines.join("\n"));
});

test("arguments nothing could be read from are clipped to the row, never wrapped", () => {
  const raw = `{"items":[${"1,".repeat(120)}`;
  const lines = body([{ name: "mcp__x__y", args: raw, status: "ok", durationMs: 2 }], { width: 60 });
  const row = lines.find((line) => line.startsWith(" ✓ mcp__x__y"))!;
  assert.ok(row.includes("…"), row);
  assert.ok(visibleWidth(row) <= 60, row);
  assert.ok(row.endsWith("2ms"), "the duration survives the clip: " + row);
});

test("nothing on any row passes the width, open or shut", () => {
  const longCode = `const x = ${"y + ".repeat(60)}1;`;
  const calls = [
    { name: "bash", args: `{"command":"echo ${"z".repeat(150)}`, status: "error", durationMs: 2100, error: `fail ${"e ".repeat(80)}` },
  ];
  for (const width of [30, 50, 90]) {
    const lines = body(calls, { width, script: true, outputOpen: true, code: longCode, output: `${HEADER}\n${"o ".repeat(90)}` });
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test("model calls that cost something add up on a row of their own", () => {
  const lines = body([
    { name: "models.complete", status: "ok", cost: 0.012, durationMs: 900 },
    { name: "models.complete", status: "ok", cost: 0.02, durationMs: 800 },
  ]);
  assert.ok(lines.includes(" model calls · $0.03"), lines.join("\n"));
});

test("the fold state is per box and survives a re-render", () => {
  const box = {};
  assert.deepEqual(nestedSections(box), { script: false, output: false });
  toggleNestedSection(box, "script");
  assert.deepEqual(nestedSections(box), { script: true, output: false });
  assert.deepEqual(nestedSections({}), { script: false, output: false }, "another box starts shut");
});
