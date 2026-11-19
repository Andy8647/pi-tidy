/**
 * The nested-calls protocol: every record a tool can keep, read into one shape.
 *
 * pi's `codemode` writes `details.calls` — arguments as a clipped JSON string,
 * no result. pi-fabric's `fabric_exec` writes `details.audits` — the whole
 * argument object, the result, and the diff a nested `edit` wrote. Any other
 * tool may write `details.calls` with an object for `args` and its own
 * `output`, `diff` and `cost`. pi's own `nestedCalls` on the result message
 * completes clipped arguments, and never makes a tool one with nested calls.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nestedCallsOf, nestedRunOf, noteHostRecord, resetHostRecords } from "../src/tools/nested-calls.ts";
import { nestedBreakdown } from "../src/tools/tool-groups.ts";

const fabric = {
  success: true,
  kernel: "typescript",
  phases: [],
  audits: [
    // fabric's own plumbing: a successful load of a provider's tools.
    { ref: "native.load", tool: "load", provider: "fabric", success: true, args: {}, result: { ok: true } },
    {
      ref: "pi.bash",
      tool: "bash",
      provider: "pi",
      success: true,
      args: { command: "pwd" },
      result: { ok: true, output: "/tmp" },
      startedAt: 10,
      endedAt: 60,
    },
    {
      ref: "pi.edit",
      tool: "edit",
      provider: "pi",
      success: true,
      args: { path: "a.ts", edits: [{ oldText: "b", newText: "c" }] },
      result: { ok: true, output: "replaced", details: { diff: " 1 a\n-2 b\n+2 c" } },
      startedAt: 60,
      endedAt: 90,
    },
    { ref: "pi.read", tool: "read", provider: "pi", success: false, error: "no such file", args: { path: "b.ts" }, startedAt: 90, endedAt: 95 },
    // still running: fabric leaves `success` off until the call ends.
    { ref: "pi.bash", tool: "bash", provider: "pi", args: { command: "sleep 1" }, startedAt: 95 },
  ],
};

test("fabric's audits read as one call each, in the order they ran", () => {
  const calls = nestedCallsOf(fabric);
  assert.deepEqual(
    calls.map((call) => [call.name, call.status]),
    [
      ["bash", "ok"],
      ["edit", "ok"],
      ["read", "error"],
      ["bash", "running"],
    ],
  );
  assert.deepEqual(calls[0]!.args, { command: "pwd" }, "the whole argument object survives");
  assert.equal(calls[0]!.durationMs, 50);
  assert.equal(calls[0]!.output, "/tmp");
  assert.equal(calls[1]!.diff, " 1 a\n-2 b\n+2 c", "the edit's diff comes with it");
  assert.equal(calls[2]!.error, "no such file");
  assert.equal(calls[3]!.durationMs, undefined, "a running call has no duration yet");
});

test("a successful load is plumbing, and its failure is a call worth showing", () => {
  const names = nestedCallsOf(fabric).map((call) => call.name);
  assert.ok(!names.includes("load"), names.join(","));
  const failed = { audits: [{ ref: "native.load", tool: "load", success: false, error: "no provider" }] };
  assert.deepEqual(
    nestedCallsOf(failed).map((call) => [call.name, call.status, call.error]),
    [["load", "error", "no provider"]],
  );
});

test("an audit rebuilt from the trace keeps its row and loses what it cannot show", () => {
  const traced = {
    audits: [{ ref: "pi.edit", tool: "edit", success: true, fromTrace: true, args: { path: "a.ts" }, startedAt: 1, endedAt: 2 }],
  };
  const [call] = nestedCallsOf(traced);
  assert.equal(call!.name, "edit");
  assert.equal(call!.diff, undefined);
  assert.equal(call!.output, undefined);
});

test("codemode's record reads its clipped JSON back into arguments", () => {
  const details = { calls: [{ name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 5 }] };
  assert.deepEqual(nestedCallsOf(details), [{ name: "bash", status: "ok", args: { command: "pwd" }, durationMs: 5 }]);
  const cancelled = { calls: [{ name: "read", args: "", status: "cancelled" }] };
  assert.equal(nestedCallsOf(cancelled)[0]!.status, "cancelled");
  // Cut at 200 characters: the key that survived is what the row can say.
  const clipped = { calls: [{ name: "write", args: `{"path":"/tmp/out.txt","content":"${"x".repeat(180)}...`, status: "ok" }] };
  assert.deepEqual(nestedCallsOf(clipped)[0]!.args, { path: "/tmp/out.txt" });
  // Nothing readable left: the raw text, so the row still says something.
  const opaque = { calls: [{ name: "mcp__x__y", args: '{"items":[1,2,3', status: "ok" }] };
  assert.equal(nestedCallsOf(opaque)[0]!.args, '{"items":[1,2,3');
});

test("bash's exit trailer comes off a nested failure: the row already says it failed", () => {
  const details = { calls: [{ name: "bash", args: '{"command":"false"}', status: "error", error: "boom\n\nCommand exited with code 1" }] };
  assert.equal(nestedCallsOf(details)[0]!.error, "boom");
  const other = { calls: [{ name: "read", status: "error", error: "Command exited with code 1" }] };
  assert.equal(nestedCallsOf(other)[0]!.error, "Command exited with code 1", "only bash writes that trailer");
});

test("any tool can write the record, with what it produced", () => {
  const details = {
    calls: [
      { name: "bash", args: { command: "ls" }, status: "ok", durationMs: 3, output: "a\nb" },
      { name: "edit", args: { path: "a.ts" }, status: "ok", diff: " 1 a\n-2 b\n+2 c" },
      { name: "llm", status: "ok", cost: 0.004 },
      { name: "llm", status: "ok", cost: 0 },
    ],
  };
  const calls = nestedCallsOf(details);
  assert.deepEqual(calls[0]!.args, { command: "ls" });
  assert.equal(calls[0]!.output, "a\nb");
  assert.equal(calls[1]!.diff, " 1 a\n-2 b\n+2 c");
  assert.equal(calls[2]!.cost, 0.004);
  assert.equal(calls[3]!.cost, undefined, "a free call has nothing to add up");
});

test("pi's own record completes clipped arguments, and makes no tool a program by itself", () => {
  resetHostRecords();
  const long = "y".repeat(300);
  noteHostRecord({
    role: "toolResult",
    toolCallId: "outer",
    nestedCalls: { calls: [{ id: "n1", name: "bash", status: "ok", arguments: { command: `echo ${long}`, timeout: 5 } }], complete: true },
  });
  const details = { calls: [{ id: "n1", name: "bash", args: `{"command":"echo ${long.slice(0, 150)}...`, status: "ok" }] };
  assert.deepEqual(nestedCallsOf(details, "outer")[0]!.args, { command: `echo ${long}`, timeout: 5 });
  assert.deepEqual(nestedCallsOf(details, "other")[0]!.args, { command: `echo ${long.slice(0, 150)}` }, "another call's record is not this one's");
  // pi-subagents launches one helper through executeTool: its result has no
  // record of its own, so it stays an ordinary tool.
  noteHostRecord({ role: "toolResult", toolCallId: "subagent", nestedCalls: { calls: [{ id: "s1", name: "subagent_launch", status: "ok", arguments: {} }] } });
  assert.equal(nestedRunOf({ task: "x" }, "subagent"), undefined);
  // A restored session rebuilds the records from the stored messages.
  resetHostRecords([{ type: "message", message: { role: "toolResult", toolCallId: "outer", nestedCalls: { calls: [{ id: "n1", name: "bash", arguments: { command: "pwd" } }] } } }]);
  assert.deepEqual(nestedCallsOf(details, "outer")[0]!.args, { command: "pwd" });
  resetHostRecords();
});

test("fabric's dropped calls are counted, minus its own plumbing", () => {
  assert.equal(nestedRunOf({ audits: [], omittedCalls: { count: 5, done: 5, internal: 2 } })!.omitted, 3);
});

test("a result that records no calls reads as none, whichever shape it is missing", () => {
  for (const details of [undefined, null, {}, { calls: [] }, { audits: [] }, { audits: "no" }, { calls: 3 }]) {
    assert.deepEqual(nestedCallsOf(details), [], JSON.stringify(details));
  }
});

test("the summary counts both shapes by tool, most frequent first", () => {
  assert.deepEqual(nestedBreakdown(fabric), [
    { name: "bash", count: 2 },
    { name: "edit", count: 1 },
    { name: "read", count: 1 },
  ]);
  assert.deepEqual(nestedBreakdown({ calls: [{ name: "mcp__chrome_devtools__click" }, { name: "bash" }] }), [
    { name: "bash", count: 1 },
    { name: "chrome_devtools", count: 1 },
  ]);
});
