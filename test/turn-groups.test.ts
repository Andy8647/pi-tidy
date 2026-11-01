import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleText } from "../frame-draw.ts";
import { patchToolBoxFrames } from "../tool-frame.ts";
import { resetGroups } from "../tool-groups.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../tool-group-view.ts";
import { TurnStore, TURN_ENTRY, turnOptions, turnStore, type CollapseTurns } from "../turn-state.ts";

initTheme("dark");
const cwd = process.cwd();
const W = 100;
let nextId = 0;

/** No assistant text boundary may mask the boundary supplied by the pinned tool. */
function fixture(mode: CollapseTurns, groupOpen: boolean, pinned = "edit", expanded = false, restored = true) {
  resetGroups(); resetHover();
  patchToolBoxFrames({ groupTools: true, groupOpen, icons: false, alwaysShowTools: ["edit", "write", "codemode"] });
  turnOptions.set({ collapseTurns: mode, frameFinalReply: true, icons: false });
  const user = { role: "user", timestamp: 1000, content: "Go" };
  const messages: any[] = ["read", pinned, "read"].map((name, i) => ({
    role: "assistant", timestamp: 1100 + i * 100, provider: "openai", model: "test", durationMs: 10, stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: `THOUGHT_${i}` },
      { type: "toolCall", id: `call-${++nextId}`, name, arguments: name === "edit"
        ? { path: `${cwd}/x.ts`, edits: [{ oldText: "a", newText: "b" }] }
        : name === "write" ? { path: `${cwd}/x.ts`, content: "b" }
        : name === "codemode" ? { code: "text(1)" } : { path: `${cwd}/x.ts` } },
    ],
  }));
  const final: any = { ...messages[0], timestamp: 1500, stopReason: "stop", content: [{ type: "text", text: "Done" }] };
  const chat = new Container(); chat.addChild(new UserMessageComponent("Go"));
  for (const message of messages) {
    chat.addChild(new AssistantMessageComponent(message, true));
    const call = message.content[1];
    const definition = call.name === "read" ? createReadToolDefinition(cwd)
      : call.name === "edit" ? createEditToolDefinition(cwd)
      : call.name === "write" ? createWriteToolDefinition(cwd) : undefined;
    const tool = new ToolExecutionComponent(call.name, call.id, call.arguments, {}, definition as any, { requestRender() {} } as any, cwd);
    tool.setExpanded(expanded && call.name === pinned);
    tool.setArgsComplete(); tool.markExecutionStarted();
    tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 10 });
    chat.addChild(tool);
  }
  chat.addChild(new AssistantMessageComponent(final, true));
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000);
  for (const message of [user, ...messages, final]) store.note(message, true);
  if (restored) {
    const saved = store.settle(false, 1800);
    store.restore([
      ...[user, ...messages, final].map(message => ({ type: "message", message })),
      { type: "custom", customType: TURN_ENTRY, data: saved },
    ]);
  }
  return { chat, store };
}

function rawFrame(chat: Container): string[] {
  let rows: string[] = [];
  for (let pass = 0; pass < 5; pass++) rows = chat.render(W);
  return rows;
}
const frame = (chat: Container) => rawFrame(chat).map(visibleText);
const headers = (chat: Container) => frame(chat).filter(line => /\b1 call\b/.test(line));
function send(chat: Container, type: "click" | "move", predicate: (line: string) => boolean) {
  const lines = frame(chat);
  const y = lines.findIndex(predicate);
  assert.ok(y >= 0, lines.join("\n"));
  return chat.handleMouse({ type, button: type === "click" ? "left" : "none", x: 4, y,
    screenX: 4, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
}
const summary = (line: string) => line.includes("took") || line.includes("running");
function openTurn(chat: Container, mode: CollapseTurns) {
  if (mode !== "off") send(chat, "click", summary);
}
function openGroups(chat: Container) {
  for (let group = 0; group < 2; group++) {
    if (headers(chat).some(line => line.includes("▸"))) {
      send(chat, "click", line => /\b1 call\b/.test(line) && line.includes("▸"));
    }
  }
  assert.ok(headers(chat).every(line => line.includes("▾")));
}

test("restored folded turns keep thoughts in the groups split by pinned tools", () => {
  for (const mode of ["off", "afterRun", "live"] as const) for (const groupOpen of [false, true]) {
    for (const pinned of ["edit", "write", "codemode"]) for (const expanded of [false, true]) {
      const { chat } = fixture(mode, groupOpen, pinned, expanded);
      const initial = frame(chat);
      if (mode !== "off") assert.ok(!initial.some(line => line.includes("THOUGHT_")));
      openTurn(chat, mode); openGroups(chat);
      const groups = headers(chat);
      const context = `${mode}, groupOpen=${groupOpen}, ${pinned}, expanded=${expanded}`;
      assert.equal(groups.length, 2, context);
      assert.match(groups[0], expanded ? /1 thought\b/ : /2 thoughts\b/, context);
      assert.match(groups[1], /1 thought\b/, context);
      const rows = frame(chat);
      assert.ok(rows.findIndex(line => line.includes("THOUGHT_2")) > rows.findIndex(line => line === groups[1]), context);
    }
  }
});

test("a running live-folded turn registers pinned boundaries before settlement", () => {
  const { chat, store } = fixture("live", true, "edit", false, false);
  assert.ok(!frame(chat).some(line => line.includes("THOUGHT_")));
  openTurn(chat, "live");
  assert.match(headers(chat)[0], /2 thoughts\b/);
  assert.match(headers(chat)[1], /1 thought\b/);
  store.settle(false, 1800);
  assert.match(headers(chat)[0], /2 thoughts\b/);
  assert.match(headers(chat)[1], /1 thought\b/);
});

test("closing the first group cannot hide a later group's thinking", () => {
  for (const groupOpen of [false, true]) {
    const { chat } = fixture("afterRun", groupOpen);
    frame(chat); openTurn(chat, "afterRun"); openGroups(chat);
    send(chat, "click", line => /\b1 call\b/.test(line));
    const closed = frame(chat);
    assert.ok(!closed.some(line => line.includes("THOUGHT_0") || line.includes("THOUGHT_1")));
    assert.ok(closed.some(line => line.includes("THOUGHT_2")));
    send(chat, "click", summary); send(chat, "click", summary);
    assert.deepEqual(frame(chat), closed, "outer toggling preserves both groups' independent state");
  }
});

test("turn and group headers on one carrier have independent hover and click targets", () => {
  enableHoverForTests();
  try {
    const { chat } = fixture("afterRun", true);
    frame(chat); openTurn(chat, "afterRun");
    for (const target of [summary, (line: string) => /\b1 call\b/.test(line)]) {
      send(chat, "move", target);
      const lit = rawFrame(chat).filter(line => summary(visibleText(line)) || /\b1 call\b/.test(visibleText(line)))
        .filter(line => /\x1b\[48;/.test(line)).map(visibleText);
      assert.equal(lit.length, 1, lit.join("\n"));
      assert.ok(target(lit[0]));
    }
    send(chat, "click", line => /\b1 call\b/.test(line));
    assert.ok(frame(chat).some(line => line.includes("THOUGHT_2")));
    assert.ok(!frame(chat).some(line => line.includes("THOUGHT_0")));
    send(chat, "click", summary);
    assert.ok(!frame(chat).some(line => line.includes("THOUGHT_")));
  } finally {
    resetHover(); disableHoverForTests();
  }
});
