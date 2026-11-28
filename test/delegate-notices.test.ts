/**
 * billion-context's sub-agent notices (#59): drawn as Tidy's own notice, and
 * hung back under the `acp_delegate` call that launched them, with the turn's
 * summary counting how the runs ended. Real pi components and a real turn store.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, initTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { patchContainerBoxes, patchToolBoxFrames } from "../src/frame.ts";
import { tidyEnabled } from "../src/live.ts";
import { DELEGATE_NOTICE, noticeBodyText, noticeLabel } from "../src/messages/extension-notice.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { claimNotices, delegateCounts, noteDelegateNotice, resetDelegateNotices } from "../src/turns/delegate-notices.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";

initTheme("dark");
const W = 100;
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();
const ui = { requestRender: () => {} };

const COMPLETED = "[acp_delegate completed] **researcher** (runId `del_r`, exit 0)\n\nTask: audit auth flow\n\nFull result: `/tmp/del_r.md`";
const FAILED = "[acp_delegate FAILED ⚠️] **reviewer** (runId `del_v`, exit 1)\n\nTask: review PR 42\n\nError: rate limited";

function notice(timestamp: number, runs: object[], content: string, kind = "terminal") {
  return { role: "custom", customType: DELEGATE_NOTICE, content, display: true, timestamp, details: { version: 1, kind, runs } } as any;
}
const researcher = (status = "completed", origin: string | undefined = "d1") =>
  ({ runId: "del_r", status, agent: "researcher", ...(origin ? { originToolCallId: origin } : {}) });
const reviewer = (status = "failed", origin: string | undefined = "d2") =>
  ({ runId: "del_v", status, agent: "reviewer", ...(origin ? { originToolCallId: origin } : {}) });

test("a notice wears its agent and how it ended; its title line goes, a recovery note stays", () => {
  const done = notice(1, [researcher()], COMPLETED);
  const label = noticeLabel(done)!;
  assert.deepEqual(label, { name: "researcher", status: "completed", tone: "success" });
  assert.ok(!noticeBodyText(done, label).includes("[acp_delegate"), "the title is the label");
  // No agent: the run id names it.
  assert.equal(noticeLabel(notice(1, [{ runId: "del_x", status: "cancelled" }], "x"))!.name, "del_x");
  assert.equal(noticeLabel(notice(1, [{ runId: "del_x", status: "cancelled" }], "x"))!.tone, "warning");
  assert.equal(noticeLabel(notice(1, [researcher()], COMPLETED, "usage"))!.status, "completed · usage");
  const batch = notice(1, [researcher(), reviewer()], "⚠️ Recovery notice: 1 earlier result never reached you.\n[acp_delegate] 2 delegates finished");
  const both = noticeLabel(batch)!;
  assert.equal(both.status, "2 background runs");
  assert.equal(both.tone, "error", "the worst of them");
  assert.ok(noticeBodyText(batch, both).startsWith("⚠️ Recovery notice"), "a first line that is not the title is news");
});

test("runs count once each, by their latest notice, in the turn that launched them", () => {
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(0);
  store.note({ role: "user", content: "go", timestamp: 0 } as any);
  store.note({ role: "assistant", timestamp: 10, provider: "p", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: "d1", name: "acp_delegate", arguments: {} }, { type: "toolCall", id: "d2", name: "acp_delegate", arguments: {} }] } as any, true);
  const turn = store.current!;
  resetDelegateNotices();
  noteDelegateNotice(notice(100, [researcher("completed")], COMPLETED));
  noteDelegateNotice(notice(100, [researcher("completed")], COMPLETED)); // the same message, seen twice
  noteDelegateNotice(notice(200, [reviewer("failed")], FAILED));
  noteDelegateNotice(notice(300, [reviewer("failed")], FAILED, "usage")); // its usage note, later
  noteDelegateNotice(notice(400, [{ runId: "del_o", status: "completed", originToolCallId: "elsewhere" }], "x"));
  assert.deepEqual(delegateCounts(turn), { completed: 1, failed: 1, other: 0 });
  resetDelegateNotices();
});

/** One launched turn, a later prompt, then the notices: the order they really arrive in. */
function session(notices: any[]) {
  const store = new TurnStore();
  turnStore.set(store);
  const launch = { role: "assistant", timestamp: 1100, provider: "p", model: "m", stopReason: "toolUse", content: [
    { type: "text", text: "Launching." },
    { type: "toolCall", id: "d1", name: "acp_delegate", arguments: { agent: "researcher", task: "audit" } },
    { type: "toolCall", id: "d2", name: "acp_delegate", arguments: { agent: "reviewer", task: "review" } },
  ] } as any;
  const results = ["d1", "d2"].map((id, i) => ({ role: "toolResult", toolCallId: id, toolName: "acp_delegate", timestamp: 1200 + i, isError: false, content: [{ type: "text", text: "started" }] }) as any);
  const reply = { role: "assistant", timestamp: 1300, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "Both running." }] } as any;
  const later = { role: "user", content: "meanwhile", timestamp: 2000 } as any;
  const answer = { role: "assistant", timestamp: 2100, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "Sure." }] } as any;
  store.restore([{ role: "user", content: "go", timestamp: 1000 }, launch, ...results, reply, later, answer].map((message) => ({ type: "message", message })));
  resetDelegateNotices(notices.map((n) => ({ type: "custom_message", customType: n.customType, content: n.content, display: true, details: n.details, timestamp: new Date(n.timestamp).toISOString() })));

  const chat = new Container();
  chat.addChild(new UserMessageComponent("go"));
  chat.addChild(new AssistantMessageComponent(launch, true));
  const calls = ["d1", "d2"].map((id, i) => {
    const call = new ToolExecutionComponent("acp_delegate", id, launch.content[i + 1].arguments, {}, undefined, ui as any, "/tmp");
    call.setArgsComplete();
    call.markExecutionStarted();
    call.updateResult({ ...results[i], durationMs: 20 } as any, false);
    chat.addChild(call);
    return call;
  });
  chat.addChild(new AssistantMessageComponent(reply, true));
  chat.addChild(new UserMessageComponent("meanwhile"));
  chat.addChild(new AssistantMessageComponent(answer, true));
  for (const n of notices) chat.addChild(new CustomMessageComponent(n));
  return { chat, calls, store };
}

function frame(chat: Container, width = W): readonly string[] {
  let lines: readonly string[] = [];
  for (let i = 0; i < 4; i++) lines = chat.render(width);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `past the width: ${strip(line)}`);
  return lines.map(strip);
}

function setup(collapseTurns: "afterRun" | "off" = "afterRun") {
  tidyEnabled.set(true);
  resetGroups();
  patchToolBoxFrames({ icons: false, groupTools: true });
  patchContainerBoxes({ user: "accent", custom: "warning" }, { icons: false });
  turnOptions.set({ ...turnOptions.get(), collapseTurns, frameFinalReply: true, icons: false });
}

test("folded, a late notice is gone from where it arrived and counted on its turn", () => {
  setup();
  const { chat } = session([notice(3000, [researcher()], COMPLETED), notice(4000, [reviewer()], FAILED)]);
  const lines = frame(chat);
  const body = lines.join("\n");
  assert.ok(!body.includes("researcher completed"), `not drawn where it arrived:\n${body}`);
  assert.ok(!body.includes("reviewer failed"), body);
  const summary = lines.find((line) => line.includes("sub-agent"))!;
  assert.ok(summary, body);
  assert.match(summary, /1 sub-agent failed/, summary);
  assert.match(summary, /sub-agents 1 completed/, summary);
  assert.ok(summary.indexOf("failed") < summary.indexOf("LLM"), "the failure comes first, before narrow rows clip: " + summary);
});

test("opened, each notice hangs under its call, and a click opens what it said", () => {
  setup();
  const { chat } = session([notice(3000, [researcher()], COMPLETED), notice(4000, [reviewer()], FAILED)]);
  const click = (pattern: RegExp) => {
    const lines = frame(chat);
    const y = lines.findIndex((line) => pattern.test(line));
    assert.ok(y >= 0, `no row for ${pattern}:\n${lines.join("\n")}`);
    const x = Math.max(0, lines[y]!.search(/\S/) + 2);
    chat.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as any);
  };
  click(/▸ took/);
  // The group is still folded: only the failure keeps a row under its header.
  let lines = frame(chat);
  assert.ok(lines.some((line) => /▸ ✗ reviewer failed/.test(line)), lines.join("\n"));
  assert.ok(!lines.some((line) => /researcher completed/.test(line)), lines.join("\n"));
  click(/▸ 2 calls/);
  lines = frame(chat);
  const first = lines.findIndex((line) => line.includes("acp_delegate") && line.includes("researcher"));
  assert.ok(/▸ ✓ researcher completed/.test(lines[first + 1]!), `under its own call:\n${lines.join("\n")}`);
  // On the call's arguments' column, like everything else hung under a row.
  assert.equal(lines[first + 1]!.indexOf("▸"), lines[first]!.indexOf("researcher"), lines.join("\n"));
  const second = lines.findIndex((line) => line.includes("acp_delegate") && line.includes("reviewer"));
  assert.ok(/▸ ✗ reviewer failed/.test(lines[second + 1]!), lines.join("\n"));
  click(/▸ ✗ reviewer failed/);
  const opened = frame(chat).join("\n");
  assert.ok(opened.includes("▾ ✗ reviewer failed"), opened);
  assert.ok(opened.includes("rate limited"), "the notice's own text, in full: " + opened);
  const rows = opened.split("\n");
  const head = rows.find((line) => line.includes("▾ ✗ reviewer failed"))!;
  const text = rows.find((line) => line.includes("rate limited"))!;
  assert.equal(text.indexOf("Error"), head.indexOf("▾") + 4, "its text sits under the agent's name:\n" + opened);
  assert.ok(!opened.includes("[acp_delegate"), "its title is the row already");
});

test("a notice nobody can own stays where it arrived", () => {
  setup();
  const orphan = notice(5000, [{ runId: "del_o", status: "completed", agent: "oracle" }], "[acp_delegate completed] **oracle**\n\nTask: elsewhere");
  const split = notice(6000, [researcher(), { ...reviewer(), originToolCallId: "from-another-turn" }], "[acp_delegate] 2 delegates finished");
  const { chat } = session([orphan, split]);
  const body = frame(chat).join("\n");
  assert.ok(body.includes("oracle completed"), body);
  assert.ok(body.includes("2 background runs"), body);
});

test("with turn folding off nothing moves, and the notice is Tidy's own frame in place", () => {
  setup("off");
  const { chat } = session([notice(3000, [researcher()], COMPLETED)]);
  const body = frame(chat).join("\n");
  assert.match(body, /╭─ researcher completed ─+╮/, body);
  assert.ok(body.includes("Task: audit auth flow"), body);
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun" });
});

test("a turn compacted away claims nothing: its notice is back in place", () => {
  setup();
  const { chat, calls } = session([notice(3000, [researcher()], COMPLETED)]);
  frame(chat);
  for (const call of calls) chat.removeChild(call);
  const body = frame(chat).join("\n");
  assert.ok(body.includes("researcher completed"), body);
  resetDelegateNotices();
});

/**
 * A sub-agent launched from inside a program (#102): the run's origin is the
 * nested call (`cm1/3`), which only the program's result names. The call that
 * ran the program stands in for it.
 */
const nested = (status = "completed") => researcher(status, "cm1/3");
const programCall = { type: "toolCall", id: "cm1", name: "codemode", arguments: { code: "await tools.acp_delegate({ agent: 'researcher', async: true })" } };
const programResult = {
  role: "toolResult", toolCallId: "cm1", toolName: "codemode", timestamp: 1200, isError: false,
  content: [{ type: "text", text: "launched" }],
  details: { calls: [{ id: "cm1/3", name: "acp_delegate", args: '{"agent":"researcher","async":true}', status: "ok" }] },
  nestedCalls: { calls: [{ id: "cm1/3", name: "acp_delegate", arguments: { agent: "researcher", async: true } }] },
} as any;

test("a run launched inside a program is counted on, and drawn by, the program's call", () => {
  setup();
  const store = new TurnStore();
  turnStore.set(store);
  const launch = { role: "assistant", timestamp: 1100, provider: "p", model: "m", stopReason: "toolUse", content: [programCall] } as any;
  const reply = { role: "assistant", timestamp: 1300, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "Running." }] } as any;
  const later = { role: "user", content: "meanwhile", timestamp: 2000 } as any;
  const answer = { role: "assistant", timestamp: 2100, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "Sure." }] } as any;
  store.restore([{ role: "user", content: "go", timestamp: 1000 }, launch, programResult, reply, later, answer].map((message) => ({ type: "message", message })));
  const done = notice(3000, [nested()], COMPLETED);
  resetDelegateNotices([{ type: "custom_message", customType: done.customType, content: done.content, display: true, details: done.details, timestamp: new Date(done.timestamp).toISOString() }]);

  const chat = new Container();
  chat.addChild(new UserMessageComponent("go"));
  chat.addChild(new AssistantMessageComponent(launch, true));
  const call = new ToolExecutionComponent("codemode", "cm1", programCall.arguments, {}, undefined, ui as any, "/tmp");
  call.setArgsComplete();
  call.markExecutionStarted();
  call.updateResult({ ...programResult, durationMs: 20 } as any, false);
  chat.addChild(call);
  chat.addChild(new AssistantMessageComponent(reply, true));
  chat.addChild(new UserMessageComponent("meanwhile"));
  chat.addChild(new AssistantMessageComponent(answer, true));
  chat.addChild(new CustomMessageComponent(done));

  const lines = frame(chat);
  const body = lines.join("\n");
  assert.ok(!body.includes("researcher completed"), `not drawn where it arrived:\n${body}`);
  assert.match(lines.find((line) => line.includes("sub-agent")) ?? "", /sub-agents 1 completed/, body);
  resetDelegateNotices();
});

test("a nested run's notice that beats its program's result is claimed once the result lands", () => {
  const store = new TurnStore();
  turnStore.set(store);
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun" });
  store.begin(0);
  store.note({ role: "user", content: "go", timestamp: 0 } as any);
  store.note({ role: "assistant", timestamp: 10, provider: "p", model: "m", stopReason: "toolUse", content: [programCall] } as any, true);
  resetDelegateNotices();
  noteDelegateNotice(notice(20, [nested()], COMPLETED));
  assert.equal(claimNotices("cm1").length, 0, "nothing says yet where cm1/3 came from");
  store.note(programResult, true);
  assert.equal(claimNotices("cm1").length, 1, "the program's result says it");
  assert.deepEqual(delegateCounts(store.current!), { completed: 1, failed: 0, other: 0 });
  resetDelegateNotices();
});
