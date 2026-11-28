import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import tidy from "../src/index.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";
import { formatTurnMetrics, presentTurn } from "../src/turns/turn-view.ts";
import { harness, loadTidy } from "./renderer-harness.ts";

initTheme("dark");

test("formatTurnMetrics formats sub-second/second TTFT and tok/s cleanly", () => {
  assert.equal(formatTurnMetrics({ ttftMs: 420, tps: 48.54 }), "TTFT 420ms · 48.5 tok/s");
  assert.equal(formatTurnMetrics({ ttftMs: 1240, tps: 128.4 }), "TTFT 1.2s · 128 tok/s");
  assert.equal(formatTurnMetrics({ ttftMs: 850 }), "TTFT 850ms");
  assert.equal(formatTurnMetrics({ tps: 50 }), "50.0 tok/s");
  assert.equal(formatTurnMetrics({}), "");
});

test("TurnStore averages TTFT and computes tok/s over full request durations", () => {
  const store = new TurnStore();
  store.begin(1000);
  store.note({ role: "user", timestamp: 1000, content: "Check" });

  // Step 1: request at 1000, first token at 2000 (TTFT 1000ms), duration 3000ms, output 60.
  const step1: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 1005,
    stopReason: "toolUse",
    durationMs: 3000,
    usage: { output: 60 },
    content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }],
  };
  store.requestStart(1000);
  store.note(step1, false);
  store.noteStreamUpdate(step1, { type: "thinking_delta", delta: "h" }, 2000);
  store.note(step1, true);

  // A tool runs; a nested model request must not disturb the main step's timing.
  store.toolStart("t1", undefined, 4050);
  store.requestStart(4100);
  store.noteStreamUpdate({ ...step1, timestamp: 4105 }, { type: "text_delta", delta: "ignored" }, 4200);
  store.toolEnd("t1", undefined, 5000);

  // A failed retry step: excluded from both metrics.
  const failed: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 5055,
    stopReason: "error",
    durationMs: 900,
    usage: { output: 5 },
    content: [],
  };
  store.requestStart(5050);
  store.note(failed, false);
  store.noteStreamUpdate(failed, { type: "text_delta", delta: "err" }, 5900);
  store.note(failed, true);

  // Step 2: request at 6000, first token at 6600 (TTFT 600ms), duration 2600ms, output 160.
  const step2: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 6005,
    stopReason: "stop",
    durationMs: 2600,
    usage: { output: 160 },
    content: [{ type: "text", text: "Done" }],
  };
  store.requestStart(6000);
  store.note(step2, false);
  store.noteStreamUpdate(step2, { type: "text_delta", delta: "D" }, 6600);
  store.note(step2, true);

  const turn = store.current!;
  store.settle(false, 8610);

  const metrics = store.llmMetrics(turn);
  assert.equal(metrics.ttftMs, 800, "mean of 1000ms and 600ms");
  // (60 + 160) / ((3000 + 2600) / 1000) = 220 / 5.6
  assert.ok(metrics.tps !== undefined && Math.abs(metrics.tps - 220 / 5.6) < 1e-6, `got ${metrics.tps}`);
});

test("a step with time but no tokens does not drag the rate down", () => {
  const store = new TurnStore();
  store.begin(1000);
  store.note({ role: "user", timestamp: 1000, content: "Check" });

  // A tool-only step: 5000ms, no usage. It must not enter the denominator.
  const silent: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 1005,
    stopReason: "toolUse",
    durationMs: 5000,
    usage: { output: 0 },
    content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
  };
  store.requestStart(1000);
  store.note(silent, false);
  store.noteStreamUpdate(silent, { type: "toolcall_delta", delta: "{" }, 1500);
  store.note(silent, true);

  const answer: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 6005,
    stopReason: "stop",
    durationMs: 2000,
    usage: { output: 100 },
    content: [{ type: "text", text: "Done" }],
  };
  store.requestStart(6000);
  store.note(answer, false);
  store.noteStreamUpdate(answer, { type: "text_delta", delta: "D" }, 6200);
  store.note(answer, true);

  const turn = store.current!;
  store.settle(false, 8010);
  const metrics = store.llmMetrics(turn);
  assert.equal(metrics.ttftMs, 350, "mean of 500ms and 200ms");
  assert.ok(metrics.tps !== undefined && Math.abs(metrics.tps - 50) < 1e-6, `got ${metrics.tps}`);
});

test("a resumed turn with no live timing renders no metrics", () => {
  const store = new TurnStore();
  const final: any = {
    role: "assistant",
    provider: "openai",
    model: "test-model",
    timestamp: 700,
    stopReason: "stop",
    content: [{ type: "text", text: "Done" }],
  };
  store.restore([{ type: "message", message: { role: "user", timestamp: 100, content: "Hi" } }, { type: "message", message: final }]);
  const turn = store.byMessage.get("assistant:700:openai:test-model")!;
  const metrics = store.llmMetrics(turn);
  assert.equal(metrics.ttftMs, undefined);
  assert.equal(metrics.tps, undefined);
});

/** A settled final reply with one live step, rendered by `presentTurn`. */
function reply(metricsOn: boolean, replyStyle: "frame" | "rail") {
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note({ role: "user", timestamp: 1000, content: "Hi" });
  const finalMsg: any = {
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    timestamp: 1100,
    durationMs: 2200,
    usage: { output: 100 },
    stopReason: "stop",
    content: [{ type: "text", text: "Hello world" }],
  };
  store.requestStart(1100);
  store.note(finalMsg, false);
  store.noteStreamUpdate(finalMsg, { type: "text_delta", delta: "Hello" }, 1300); // TTFT 200ms
  store.note(finalMsg, true);
  store.settle(false, 3310);

  const previous = turnOptions.get();
  turnOptions.set({
    ...previous,
    collapseTurns: "off",
    frameFinalReply: true,
    replyStyle,
    replyMetrics: metricsOn,
    icons: false,
  });
  try {
    const component: any = new AssistantMessageComponent(finalMsg, true);
    return presentTurn(component, 90, (w) => component.render(w)).map(visibleText);
  } finally {
    turnOptions.set(previous);
  }
}

test("the final reply's top edge shows TTFT and tok/s when replyMetrics is on", () => {
  for (const style of ["frame", "rail"] as const) {
    const rows = reply(true, style);
    const top = rows.find((row) => row.includes("gpt-test"));
    assert.ok(top, `no top edge with the model name (${style}):\n${rows.join("\n")}`);
    assert.equal(visibleWidth(top), 90);
    assert.ok(top.includes("TTFT 200ms · 45.5 tok/s"), `${style}: ${top}`);
  }
});

test("replyMetrics off leaves the top edge as it was", () => {
  const rows = reply(false, "frame");
  const top = rows.find((row) => row.includes("gpt-test"));
  assert.ok(top);
  assert.ok(!top.includes("TTFT"), top);
  assert.ok(!top.includes("tok/s"), top);
});

test("the lifecycle records stream metrics end to end", async () => {
  const h = harness();
  loadTidy(tidy, h.pi, { collapseTurns: "off", finalReplyStyle: "frame", replyMetrics: true });
  const ctx = { sessionManager: { getBranch: () => [] }, ui: { notify() {} } } as any;
  const fire = async (event: string, data = {}) => {
    for (const handler of h.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  const msg: any = {
    role: "assistant",
    provider: "openai",
    model: "test",
    timestamp: Date.now(),
    stopReason: "stop",
    durationMs: 1200,
    usage: { output: 50 },
    content: [{ type: "text", text: "Answer" }],
  };
  await fire("session_start");
  await fire("before_agent_start");
  await fire("before_provider_request");
  await fire("message_start", { message: msg });
  await fire("message_update", { message: msg, assistantMessageEvent: { type: "text_delta", delta: "Ans", contentIndex: 0, partial: msg } });
  await new Promise((resolve) => setTimeout(resolve, 65));
  await fire("message_end", { message: msg });
  await fire("agent_settled", { aborted: false });
  const turns = [...new Set(turnStore.get().byMessage.values())];
  assert.equal(turns.length, 1);
  const metrics = turnStore.get().llmMetrics(turns[0]!);
  assert.ok(metrics.ttftMs !== undefined && metrics.ttftMs >= 0);
  assert.ok(metrics.tps !== undefined && metrics.tps > 0);
});
