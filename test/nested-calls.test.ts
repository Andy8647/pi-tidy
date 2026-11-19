/**
 * A wrapper's own calls, read from either record a tool keeps.
 *
 * pi's `codemode` writes `details.calls` — arguments as a clipped JSON string,
 * no result. pi-fabric's `fabric_exec` writes `details.audits` — the whole
 * argument object, the result, and the diff a nested `edit` wrote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nestedCallsOf } from "../src/tools/nested-calls.ts";
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

test("pi's own record still reads as it did", () => {
  const details = { calls: [{ name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 5 }] };
  assert.deepEqual(nestedCallsOf(details), [
    { name: "bash", args: '{"command":"pwd"}', status: "ok", durationMs: 5 },
  ]);
  const cancelled = { calls: [{ name: "read", args: "", status: "cancelled" }] };
  assert.equal(nestedCallsOf(cancelled)[0]!.status, "cancelled");
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
