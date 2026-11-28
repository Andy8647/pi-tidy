import assert from "node:assert/strict";
import { test } from "node:test";
import tidy from "../src/index.ts";
import { harness, loadTidy } from "./renderer-harness.ts";
import { folded, messageKey, turnStore, TURN_ENTRY } from "../src/turns/turn-state.ts";

const user = { role: "user", timestamp: 1000, content: "Check this" };
const first = { role: "assistant", provider: "openai", model: "test", timestamp: 1100, durationMs: 10, stopReason: "toolUse", content: [
  { type: "thinking", thinking: "Inspect first" },
  { type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
] };
const answer = { ...first, timestamp: 1500, stopReason: "stop", content: [{ type: "text", text: "Done" }] };

test("lifecycle settles once, persists outside model context, and restores the active branch", async () => {
  const h = harness();
  loadTidy(tidy, h.pi, { collapseTurns: "afterRun", frameFinalReply: true, groupTools: false });
  const messages = [user, first, answer].map((message) => ({ type: "message", message }));
  let branch: any[] = [];
  const ctx = { sessionManager: { getBranch: () => branch }, ui: { notify() {} } } as any;
  const fire = async (event: string, data = {}) => {
    for (const handler of h.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  await fire("session_start");
  await fire("before_agent_start"); await fire("agent_start");
  await fire("message_start", { message: user });
  await fire("message_end", { message: first });
  await fire("tool_execution_start", { toolCallId: "a" });
  await fire("tool_execution_end", { toolCallId: "a" });
  await fire("message_end", { message: answer });
  await fire("agent_end");
  assert.equal(h.entries.length, 0, "a low-level loop ending is not final settlement");
  assert.equal(turnStore.get().current?.outcome, "running");
  await fire("agent_settled", { aborted: false }); await fire("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, TURN_ENTRY);
  assert.equal(h.entries[0].type, "custom", "not a context message");
  branch = [...messages, ...h.entries];
  await fire("session_tree");
  const turn = turnStore.get().byMessage.get(messageKey(answer)!)!;
  assert.equal(turn.outcome, "completed");
  assert.equal(turn.final, messageKey(answer));
  assert.equal(folded(turn), true);
  await h.commands.get("tidy").handler("turn last", ctx);
  assert.equal(folded(turn), false);
  await h.commands.get("tidy").handler("turn 1", ctx);
  assert.equal(folded(turn), true);
  branch = messages.slice(0, 1);
  await fire("session_tree");
  assert.equal(turnStore.get().byMessage.has(messageKey(answer)!), false, "abandoned branches cannot leak into current state");
});

test("a steer mid-run persists the segment it closed, and only the last one at settlement", async () => {
  const h = harness();
  loadTidy(tidy, h.pi, { collapseTurns: "afterRun", frameFinalReply: true, groupTools: false });
  const ctx = { sessionManager: { getBranch: () => [] }, ui: { notify() {} } } as any;
  const fire = async (event: string, data = {}) => {
    for (const handler of h.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  const steer = { role: "user", timestamp: 2000, content: "Also the tests" };
  const second = { ...answer, timestamp: 2100, content: [{ type: "text", text: "Both done" }] };
  const keys = (index: number) => (h.entries[index]!.data as { keys: string[] }).keys;
  await fire("before_agent_start"); await fire("agent_start");
  await fire("message_start", { message: user });
  await fire("message_end", { message: answer });
  assert.equal(h.entries.length, 0, "a run still on its first segment has nothing to write");
  await fire("message_start", { message: steer });
  assert.equal(h.entries.length, 1, "the segment is written down as the steer arrives");
  assert.deepEqual(keys(0), [messageKey(user), messageKey(answer)]);
  await fire("message_end", { message: steer });
  assert.equal(h.entries.length, 1, "the same message's end is not a second segment");
  await fire("message_end", { message: second });
  await fire("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 2, "the run's last segment settles with the run");
  assert.deepEqual(keys(1), [messageKey(steer), messageKey(second)]);
  const store = turnStore.get();
  assert.equal(store.byMessage.get(messageKey(user)!), store.byMessage.get(messageKey(answer)!));
  assert.notEqual(store.byMessage.get(messageKey(steer)!), store.byMessage.get(messageKey(answer)!));
});

test("disabled turn features register no timing or persistence listeners", () => {
  const h = harness(); loadTidy(tidy, h.pi, { collapseTurns: "off", frameFinalReply: false });
  assert.equal(h.handlers.has("before_provider_request"), false);
  assert.equal(h.handlers.has("message_end"), false);
  assert.equal(h.commands.has("tidy"), true, "/tidy settings stays reachable when turn folding is off");
});

test("with no settings at all, turn features are on", () => {
  const h = harness(); loadTidy(tidy, h.pi);
  assert.equal(h.handlers.has("message_end"), true);
  assert.equal(h.commands.has("tidy"), true);
});
