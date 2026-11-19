import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnStore, TURN_ENTRY, messageKey, unionMs, type TurnMessage } from "../src/turns/turn-state.ts";

const user = (timestamp: number): TurnMessage => ({ role: "user", timestamp, content: "check this" });
const reply = (timestamp: number, text = "Done", durationMs: number | undefined = 100): TurnMessage => ({
  role: "assistant", timestamp, provider: "openai", model: "test", durationMs, stopReason: "stop",
  content: [{ type: "text", text }],
});
const calling = (timestamp: number): TurnMessage => ({ ...reply(timestamp, "Checking"), stopReason: "toolUse", content: [
  { type: "text", text: "Checking" },
  { type: "toolCall", id: "a", name: "codemode", arguments: { code: "tools.read({path:'x'})" } },
  { type: "toolCall", id: "b", name: "mcp__docs__search", arguments: { query: "x" } },
] });

test("interval union counts parallel and nested execution only once", () => {
  assert.equal(unionMs([[100, 400], [150, 350], [500, 600], [100, 400]]), 400);
  assert.equal(unionMs([]), 0);
  const store = new TurnStore();
  store.begin(0); store.note(user(0)); store.note(calling(10));
  store.toolStart("a", undefined, 100); store.toolStart("b", undefined, 150);
  store.toolStart("a/1", "a", 200); store.toolEnd("a/1", "a", 250);
  store.requestStart(200); // a nested model request still belongs to the parent tool
  assert.equal(store.pendingLlmAt, undefined);
  assert.equal(store.toolTime(store.current!, 300), 200);
  store.toolEnd("b", undefined, 350); store.toolEnd("a", undefined, 400);
  const turn = store.current!;
  store.note({ role: "toolResult", toolCallId: "a", toolName: "codemode", timestamp: 450, isError: false,
    details: { calls: [{ name: "bash", status: "error" }] } });
  assert.equal(turn.tools.get("a")?.nestedFailed, 1, "a nested failure is counted once, from the tool's own record");
  store.note(reply(500)); store.settle(false, 1000);
  assert.equal(store.toolTime(turn), 300);
  assert.equal(turn.tools.size, 2);
  assert.equal(turn.endedAt! - turn.startedAt!, 1000);
});

test("LLM timing includes request wait and deduplicates streaming updates", () => {
  const store = new TurnStore();
  store.begin(0); store.pendingLlmAt = 100;
  assert.equal(store.llmTime(store.current!, 200), 100);
  const first = reply(100, "First", 1000);
  store.note(first); store.note(first);
  store.note(reply(2000, "Last", 500));
  assert.equal(store.llmTime(store.current!, 3000), 1500);
  const turn = store.current!;
  store.settle(false, 4000);
  assert.equal(store.llmTime(turn), 1500);
  const missing = reply(4100); delete missing.durationMs;
  store.begin(4000); store.note(missing, true);
  assert.equal(store.pendingLlmAt, undefined, "an ended response cannot keep charging retry wait to the LLM");
  store.requestStart(5000);
  assert.equal(store.llmTime(store.current!, 6000), undefined, "missing request timing stays unknown during continuation too");
});

test("a steer starts a second segment; a retry or continuation stays in the run", () => {
  const store = new TurnStore();
  store.begin(100); store.note(user(100)); store.note(calling(200));
  store.toolStart("a", undefined, 150); store.toolEnd("a", undefined, 300);
  const first = store.current!;
  const closed = store.note(user(500));
  assert.ok(closed, "the message the user typed closes the segment it landed in");
  assert.equal(first.outcome, "completed", "the segment answered what it was asked");
  assert.equal(first.endedAt, 500, "it ends where the new message was typed, not where it arrived");
  assert.equal(first.toolMs, 150, "its tool time stops with it");
  const second = store.current!;
  assert.notEqual(second, first);
  assert.equal(second.startedAt, 500, "the two segments meet without a gap");
  assert.equal(second.tools.size, 0, "counts are per segment, not carried over");
  assert.equal(store.byMessage.get(messageKey(user(100))!), first);
  assert.equal(store.byMessage.get(messageKey(user(500))!), second);
  // The same message's `message_end` is not a third segment, and neither is a
  // continuation: an automatic retry addresses nobody.
  store.note(user(500), true); store.begin(600); store.note(reply(700));
  assert.equal(store.current, second);
  store.settle(false, 1000);
  assert.equal(second.final, messageKey(reply(700)));
  assert.equal(second.outcome, "completed");
  store.begin(2000); store.note(user(2000));
  assert.notEqual(store.current, second);
});

test("interrupted tool-only endings never promote a planning message to final reply", () => {
  const store = new TurnStore();
  store.begin(0); store.note(user(0)); store.note(calling(100));
  const turn = store.current!;
  store.settle(true, 500);
  assert.equal(turn.outcome, "interrupted");
  assert.equal(turn.final, undefined);
  for (const [reason, expected] of [["error", "error"], ["length", "incomplete"], ["aborted", "interrupted"]]) {
    store.begin(1000); store.note({ ...reply(1100), stopReason: reason });
    const current = store.current!; store.settle(false, 2000);
    assert.equal(current.outcome, expected);
  }
  store.begin(3000); store.note(reply(3100)); store.settlementOutcome = "error";
  const failed = store.current!; store.settle(false, 4000);
  assert.equal(failed.outcome, "error", "final settlement errors override a prior normal assistant stop");
});

test("saved non-context metadata restores each segment the split created", () => {
  const store = new TurnStore();
  const messages = [user(100), calling(200), user(500), reply(700)];
  store.begin(100);
  store.toolStart("a", undefined, 300); store.toolEnd("a", undefined, 450);
  store.note(messages[0]!); store.note(messages[1]!);
  const closed = store.note(messages[2]!)!;
  store.note(messages[3]!);
  const last = store.settle(false, 1000)!;
  const restored = new TurnStore();
  // What the branch holds: the entry for a segment is written from inside the
  // message's own event, before the session has that message.
  restored.restore([
    { type: "message", message: messages[0] }, { type: "message", message: messages[1] },
    { type: "custom", customType: TURN_ENTRY, data: closed },
    { type: "message", message: messages[2] }, { type: "message", message: messages[3] },
    { type: "custom", customType: TURN_ENTRY, data: last },
  ]);
  const first = restored.byMessage.get(messageKey(messages[0])!)!;
  const second = restored.byMessage.get(messageKey(messages[2])!)!;
  assert.notEqual(first, second);
  assert.equal(first.firstAssistant, messageKey(messages[1]));
  assert.equal(first.endedAt, 500);
  assert.equal(first.toolMs, 150);
  assert.equal(restored.byTool.get("a"), first);
  assert.equal(restored.byTool.get("b"), first);
  assert.equal(second.startedAt, 500);
  assert.equal(second.final, messageKey(messages[3]));
  assert.equal(second.outcome, "completed");
  assert.equal(second.tools.size, 0);
  assert.equal(second.open, undefined, "expansion is not persisted");
  assert.equal(restored.current, undefined, "restoring never resumes a run");
});

test("a session with no saved entries splits at its user messages too", () => {
  const store = new TurnStore();
  const messages = [user(100), calling(200), user(500), reply(700)];
  store.restore(messages.map((message) => ({ type: "message", message })));
  const first = store.byMessage.get(messageKey(messages[0])!)!;
  assert.notEqual(first, store.byMessage.get(messageKey(messages[2])!), "a user message opens a turn of its own");
  assert.equal(first.outcome, "unknown", "timing that was never recorded stays unknown");
});

test("an entry written before the split restores as the runs it covered", () => {
  const messages = [user(100), calling(200), user(500), reply(700)];
  const store = new TurnStore();
  store.restore([
    ...messages.map((message) => ({ type: "message", message })),
    { type: "custom", customType: TURN_ENTRY, data: {
      keys: messages.map((message) => messageKey(message)!), startedAt: 100, endedAt: 1000, outcome: "completed", toolMs: 150,
    } },
  ]);
  const first = store.byMessage.get(messageKey(messages[0])!)!;
  const second = store.byMessage.get(messageKey(messages[2])!)!;
  assert.notEqual(first, second);
  assert.equal(first.startedAt, 100);
  assert.equal(first.endedAt, 500, "the first run ends where the second message was typed");
  assert.equal(first.outcome, "unknown", "how that run ended was never recorded on its own");
  assert.equal(first.final, undefined, "a tool-calling message is no reply");
  assert.equal(first.toolMs, undefined, "one run's tool time cannot be handed to the runs it was split into");
  assert.equal(store.byTool.get("a"), first);
  assert.equal(store.byTool.get("b"), first);
  assert.equal(second.startedAt, 500);
  assert.equal(second.endedAt, 1000);
  assert.equal(second.outcome, "completed");
  assert.equal(second.final, messageKey(messages[3]));
  assert.equal(second.toolMs, undefined);
});

test("legacy sessions keep missing timing unknown rather than inferring it", () => {
  const store = new TurnStore();
  const final = reply(700);
  delete final.durationMs;
  store.restore([user(100), calling(200), final].map((message) => ({ type: "message", message })));
  const turn = store.byMessage.get(messageKey(final)!)!;
  assert.equal(turn.startedAt, undefined);
  assert.equal(store.toolTime(turn), undefined);
  assert.equal(store.llmTime(turn), undefined);
  assert.equal(turn.final, messageKey(final));
});
