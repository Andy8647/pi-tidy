import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, createReadToolDefinition, createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../tool-frame.ts";
import { resetGroups } from "../tool-groups.ts";
import { visibleText } from "../frame-draw.ts";
import { folded, TurnStore, TURN_ENTRY, turnOptions, turnStore, type CollapseTurns } from "../turn-state.ts";
import { replyLabel } from "../turn-view.ts";

initTheme("dark");
const cwd = process.cwd();
const W = 100;
const ui = { requestRender() {} } as any;
const user = { role: "user", content: "Fix this", timestamp: 1000 };
const first: any = { role: "assistant", provider: "openai", model: "test", timestamp: 1100, durationMs: 50, stopReason: "toolUse", content: [
  { type: "thinking", thinking: "Inspect the source carefully" }, { type: "text", text: "Checking the implementation." },
  { type: "toolCall", id: "a", name: "read", arguments: { path: `${cwd}/src/a.ts` } },
] };
const middle: any = { ...first, timestamp: 1300, content: [
  { type: "text", text: "Now I will fix the implementation." },
  { type: "toolCall", id: "b", name: "edit", arguments: { path: `${cwd}/src/a.ts`, edits: [{ oldText: "a", newText: "b" }] } },
] };
const final: any = { ...first, provider: "anthropic", timestamp: 1500, stopReason: "stop", content: [
  { type: "thinking", thinking: "Verify the final result carefully" }, { type: "text", text: "Fixed the result.\n\n```ts\nconst value = 2;\n```" },
] };
function fixture(mode: CollapseTurns = "afterRun", settled = true, groupOpen = false, groupTools = true) {
  resetGroups();
  patchToolBoxFrames({ groupTools, groupOpen, icons: false, splitDiff: true });
  turnOptions.set({ collapseTurns: mode, frameFinalReply: true, icons: true });
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000); store.note(user); store.note(first); store.note(middle);
  if (settled) store.note(final);
  const saved = settled ? store.settle(false, 1800) : undefined;
  const chat = new Container();
  chat.addChild(new UserMessageComponent("Fix this"));
  const read = new ToolExecutionComponent("read", "a", first.content[2].arguments, {}, createReadToolDefinition(cwd) as any, ui, cwd);
  read.setExpanded(false); read.setArgsComplete(); read.markExecutionStarted();
  read.updateResult({ content: [{ type: "text", text: "const value = 1;" }], isError: false, durationMs: 10 });
  const edit = new ToolExecutionComponent("edit", "b", middle.content[1].arguments, {}, createEditToolDefinition(cwd) as any, ui, cwd);
  edit.setExpanded(false); edit.setArgsComplete(); edit.markExecutionStarted();
  edit.updateResult({ content: [{ type: "text", text: "updated" }], isError: false, durationMs: 10, details: { diff: "-1 const value = 1;\n+1 const value = 2;", firstChangedLine: 1 } });
  chat.addChild(new AssistantMessageComponent(first, true)); chat.addChild(read);
  chat.addChild(new AssistantMessageComponent(middle, true)); chat.addChild(edit);
  const answer = new AssistantMessageComponent(final, true);
  if (settled) chat.addChild(answer);
  return { chat, store, read, edit, answer, saved };
}
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let pass = 0; pass < 4; pass++) lines = chat.render(W);
  return lines.map(visibleText);
}
function click(chat: Container, predicate: (line: string) => boolean, last = false) {
  const lines = frame(chat);
  const indices = lines.map((line, index) => predicate(line) ? index : -1).filter((index) => index >= 0);
  const y = last ? indices.at(-1) : indices[0];
  assert.notEqual(y, undefined, lines.join("\n"));
  return chat.handleMouse({ type: "click", button: "left", x: 4, y: y!, screenX: 4, screenY: y!, width: W, height: lines.length, shift: false, alt: false, ctrl: false });
}

test("outer fold hides all process including thinking and always-shown edits; summary stays before final reply", () => {
  const { chat } = fixture();
  const folded = frame(chat).join("\n");
  assert.ok(folded.includes("took 1s"));
  assert.ok(folded.includes("Fixed the result"));
  assert.ok(folded.includes("anthropic"));
  assert.ok(!folded.includes("Checking the implementation"));
  assert.ok(!folded.includes("thinking"));
  assert.ok(!folded.includes("diff"));
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  assert.ok(opened.join("\n").includes("Checking the implementation"));
  assert.ok(opened.join("\n").includes("diff"));
  assert.equal(opened.filter((line) => line.includes("took")).length, 1);
  assert.ok(opened.findIndex((line) => line.includes("took")) < opened.findIndex((line) => line.includes("anthropic")));
  click(chat, (line) => line.includes("took"));
  assert.equal(frame(chat).join("\n"), folded);
});

test("outer toggling preserves groupOpen and a manually opened tool box", () => {
  const { chat, read } = fixture("afterRun", true, true);
  click(chat, (line) => line.includes("took"));
  assert.ok(frame(chat).some((line) => line.includes("✓") && line.includes("read")));
  click(chat, (line) => line.includes("✓") && line.includes("read"));
  assert.equal((read as any).expanded, true);
  click(chat, (line) => line.includes("took"));
  click(chat, (line) => line.includes("took"));
  assert.equal((read as any).expanded, true);
  assert.ok(frame(chat).join("\n").includes("const value = 1;"));
});

test("afterRun keeps an active run open; live folds it and replaces its latest text", () => {
  const active = fixture("afterRun", false);
  assert.ok(frame(active.chat).join("\n").includes("Checking the implementation"));
  const live = fixture("live", false);
  assert.ok(!frame(live.chat).join("\n").includes("Checking the implementation"));
  assert.ok(frame(live.chat).join("\n").includes("Now I will fix"));
  live.store.note(final); live.chat.addChild(live.answer);
  assert.ok(!frame(live.chat).join("\n").includes("Now I will fix"));
  assert.ok(!frame(live.chat).join("\n").includes("anthropic"), "streaming final text is not boxed yet");
  live.store.settle(false, 1800);
  assert.ok(frame(live.chat).join("\n").includes("anthropic"));
});

test("the final reply's thinking remains clickable through its frame and summary offset", () => {
  const { chat, answer } = fixture();
  click(chat, (line) => line.includes("took"));
  click(chat, (line) => line.includes("thinking"), true);
  assert.equal((answer as any).thinkingVisibilityOverrides.get(0), false);
  const thought = (answer as any).contentContainer.children.find((child: any) => child.constructor.name === "MouseRegion");
  let renders = 0; const original = thought.render.bind(thought);
  thought.render = (width: number) => { renders++; return original(width); };
  click(chat, (line) => line.includes("took"));
  renders = 0; frame(chat);
  assert.equal(renders, 0, "folded thinking must not render even when it was expanded inside");
  click(chat, (line) => line.includes("took"));
  assert.equal((answer as any).thinkingVisibilityOverrides.get(0), false);
});

test("outer folding works without grouping and ctrl+o can open hidden calls", () => {
  const { chat, read, edit } = fixture("afterRun", true, false, false);
  assert.ok(!frame(chat).join("\n").includes("diff"));
  read.setExpanded(true); edit.setExpanded(true);
  assert.ok(frame(chat).join("\n").includes("diff"));
  read.setExpanded(false); edit.setExpanded(false);
  assert.ok(!frame(chat).join("\n").includes("diff"));
});

test("existing component caches cannot retain a previous runtime's turn click handler", () => {
  const { chat, store, saved } = fixture();
  frame(chat);
  const oldTurn = store.byTool.get("a")!;
  const rebuilt = new TurnStore();
  rebuilt.restore([...[user, first, middle, final].map((message) => ({ type: "message", message })),
    { type: "custom", customType: TURN_ENTRY, data: saved }]);
  turnStore.set(rebuilt);
  click(chat, (line) => line.includes("took"));
  assert.equal(folded(rebuilt.byTool.get("a")!), false);
  assert.equal(folded(oldTurn), true);
});

test("provider errors with no text or tools remain visible and can be inspected", () => {
  const error = { ...final, timestamp: 1200, stopReason: "error", content: [], errorMessage: "Provider timed out" };
  for (const historical of [false, true]) {
    const store = new TurnStore(); turnStore.set(store);
    if (historical) store.restore([user, error].map((message) => ({ type: "message", message })));
    else { store.begin(1000); store.note(user); store.note(error); store.settle(false, 1800); }
    turnOptions.set({ collapseTurns: "afterRun", frameFinalReply: true, icons: true });
    const chat = new Container(); chat.addChild(new AssistantMessageComponent(error, true));
    assert.ok(frame(chat).join("\n").includes("error"));
    click(chat, (line) => line.includes("took"));
    assert.ok(frame(chat).join("\n").includes("Provider timed out"));
  }
  const retried = new TurnStore(); turnStore.set(retried);
  retried.begin(1000); retried.note(user); retried.note(error); retried.note(final); retried.settle(false, 1800);
  const chat = new Container(); chat.addChild(new AssistantMessageComponent(error, true)); chat.addChild(new AssistantMessageComponent(final, true));
  const rendered = frame(chat).join("\n");
  assert.ok(rendered.includes("1 LLM failed"));
  assert.ok(rendered.includes("Fixed the result"));
});

test("repeated outer toggling leaves one stable summary and no stale click geometry", () => {
  const { chat } = fixture();
  const initial = frame(chat);
  for (let pass = 0; pass < 30; pass++) {
    click(chat, (line) => line.includes("took"));
    assert.equal(frame(chat).filter((line) => line.includes("took")).length, 1);
    click(chat, (line) => line.includes("took"));
    assert.deepEqual(frame(chat), initial);
  }
});

test("framed reply Markdown retains its native capture target and resized coordinates", () => {
  const { chat, answer } = fixture();
  const markdown = (answer as any).contentContainer.children.find((child: any) => child instanceof Markdown);
  const events: TuiMouseEvent[] = [];
  markdown.handleMouse = (event: TuiMouseEvent) => { events.push(event); return { handled: true, capture: event.type === "press" }; };
  for (const width of [40, 100]) {
    const lines = chat.render(width).map(visibleText);
    const y = lines.findIndex((line) => line.includes("Fixed the result"));
    const x = lines[y].indexOf("Fixed");
    const press: TuiMouseEvent = { type: "press", button: "left", x, y, screenX: x + 7, screenY: y + 19, width, height: lines.length, shift: false, alt: false, ctrl: false };
    const result = chat.handleMouse(press);
    assert.equal(result?.target?.component, markdown);
    assert.equal(events.at(-1)?.width, width - 2);
    assert.equal(events.at(-1)?.x, x - 1);
    assert.equal(events.at(-1)?.y, 0);
    const target = result!.target!;
    chat.render(width);
    target.component.handleMouse?.({ ...press, type: "drag", x: press.screenX - target.originX, y: press.screenY - target.originY, width: target.width, height: target.height });
    assert.equal(events.at(-1)?.y, 0);
  }
});

test("caught nested failures remain visible, and final framing can be disabled independently", () => {
  const { chat, store } = fixture();
  // A calling tool may succeed while one of its nested calls fails.
  const turn = store.byTool.get("a")!;
  turn.tools.get("a")!.nestedFailed = 1;
  turnOptions.set({ collapseTurns: "afterRun", frameFinalReply: false, icons: true });
  const lines = frame(chat).join("\n");
  assert.ok(lines.includes("1 nested failed"));
  assert.ok(lines.includes("Fixed the result"));
  assert.ok(!lines.includes("anthropic"));
  assert.ok(!lines.includes("╭"));
});

test("pure chat gets no empty process summary; final frame uses the message's provider", () => {
  const { chat } = fixture("off");
  assert.ok(!frame(chat).join("\n").includes("took"));
  assert.equal(replyLabel("unknown-provider", true), "\u{f06a9} unknown-provider");
  assert.equal(replyLabel("openai-codex", true), "\uec81 openai-codex");
  assert.equal(replyLabel("anthropic", false), "anthropic");
  assert.ok(frame(chat).every((line) => visibleWidth(line) <= W));
  const store = new TurnStore(); turnStore.set(store);
  const plain = { ...final, content: [{ type: "text", text: "Just chatting" }] };
  store.begin(1000); store.note(user); store.note(plain); store.settle(false, 1800);
  turnOptions.set({ collapseTurns: "afterRun", frameFinalReply: true, icons: true });
  const only = new Container(); only.addChild(new AssistantMessageComponent(plain, true));
  const rendered = frame(only).join("\n");
  const raw = only.render(W).join("\n");
  for (const marker of ["A", "B", "C"]) assert.equal((raw.match(new RegExp(`\\x1b\\]133;${marker}\\x07`, "g")) ?? []).length, 1);
  assert.ok(rendered.includes("anthropic"));
  assert.ok(!rendered.includes("took"));
});
