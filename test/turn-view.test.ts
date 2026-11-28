import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, createReadToolDefinition, createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { clipToWidth, formatMessageTime, visibleText } from "../src/draw/frame-draw.ts";
import { DEFAULT_TOOL_ICON, toolKindIcon } from "../src/draw/icons.ts";
import { paint } from "../src/draw/paint.ts";
import { folded, messageKey, TurnStore, TURN_ENTRY, turnOptions, turnStore, type CollapseTurns } from "../src/turns/turn-state.ts";
import { joinBoxCorners, replyLabel, summaryLine, railRows } from "../src/turns/turn-view.ts";
import { getTheme } from "../src/theme-access.ts";
import { jobForTool, noteJobMessage, resetJobs } from "../src/tools/background-jobs.ts";

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
const final: any = { ...first, provider: "anthropic", model: "claude-sonnet-4-5", timestamp: 1500, stopReason: "stop", content: [
  { type: "thinking", thinking: "Verify the final result carefully" }, { type: "text", text: "Fixed the result.\n\n```ts\nconst value = 2;\n```" },
] };
function fixture(mode: CollapseTurns = "afterRun", settled = true, groupOpen = false, groupTools = true, withUser = true) {
  resetGroups();
  patchToolBoxFrames({ groupTools, groupOpen, icons: false, splitDiff: true });
  turnOptions.set({ ...turnOptions.get(), collapseTurns: mode, frameFinalReply: true, icons: true });
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000); if (withUser) store.note(user); store.note(first); store.note(middle);
  if (settled) store.note(final);
  const saved = settled ? store.settle(false, 1800) : undefined;
  const chat = new Container();
  if (withUser) chat.addChild(new UserMessageComponent("Fix this"));
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
function frame(chat: Container): readonly string[] {
  let lines: readonly string[] = [];
  for (let pass = 0; pass < 4; pass++) lines = chat.render(W);
  return lines.map(visibleText);
}

/**
 * A run the user talked to while it worked: a steer (Enter mid-run) or a
 * follow-up (queued for when the run would stop). Both arrive as a user message
 * between two answers, so the transcript holds two segments. Replayed through the
 * same `note` calls the lifecycle makes, with the components pi would draw.
 */
function talkedTo(messages: any[]) {
  resetGroups(); resetHover();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: false });
  const store = new TurnStore(); turnStore.set(store);
  store.begin(1000);
  const chat = new Container();
  for (const message of messages) {
    if (message.role === "user") {
      // Both events, as pi sends them: the second one lands in the segment the first opened.
      store.note(message); store.note(message, true);
      chat.addChild(new UserMessageComponent(message.content));
      continue;
    }
    store.note(message, true);
    chat.addChild(new AssistantMessageComponent(message, true));
    const call = message.content.find((block: any) => block.type === "toolCall");
    if (!call) continue;
    const tool = new ToolExecutionComponent(call.name, call.id, call.arguments, {}, createReadToolDefinition(cwd) as any, ui, cwd);
    tool.setExpanded(false); tool.setArgsComplete(); tool.markExecutionStarted();
    tool.updateResult({ content: [{ type: "text", text: `contents of ${call.id}` }], isError: false, durationMs: 10 });
    chat.addChild(tool);
    store.note({ role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: message.timestamp + 5, isError: false, content: [] } as any);
  }
  store.settle(false, 4000);
  return { chat, store, messages };
}

/** An answer that wrote a line, thought about it and called a tool. */
function step(timestamp: number, id: string, text: string): any {
  return {
    role: "assistant", provider: "openai", model: "test", timestamp, durationMs: 50, stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: `thinking about ${id}` },
      { type: "text", text },
      { type: "toolCall", id, name: "read", arguments: { path: `${cwd}/src/${id}.ts` } },
    ],
  };
}
/** Text with no tool call after it: the segment's final reply. */
const closing = (timestamp: number, text: string): any => ({ ...step(timestamp, "unused", text), stopReason: "stop", content: [{ type: "text", text }] });
function click(chat: Container, predicate: (line: string) => boolean, last = false) {
  const lines = frame(chat);
  const indices = lines.map((line, index) => predicate(line) ? index : -1).filter((index) => index >= 0);
  const y = last ? indices.at(-1) : indices[0];
  assert.notEqual(y, undefined, lines.join("\n"));
  return chat.handleMouse({ type: "click", button: "left", x: 4, y: y!, screenX: 4, screenY: y!, width: W, height: lines.length, shift: false, alt: false, ctrl: false });
}

test("a folded turn's summary counts what its jobs reported", () => {
  const { store } = fixture("afterRun", true);
  const turn = store.byTool.get("a")!;
  const theme = getTheme()!;
  assert.ok(!summaryLine(turn, theme, W, false, 2000).includes("matched"), "nothing reported yet");
  resetJobs();
  jobForTool({
    toolName: "process", toolCallId: "a", args: { action: "start" }, isPartial: false,
    result: { details: { process: { id: "p1", name: "ticker", status: "running", startTime: 1000 } } },
  });
  noteJobMessage({ customType: "ad-process:notification", details: {
    kind: "log_match", processId: "p1", timestamp: 1900, logMatch: { pattern: "tick", stream: "stdout", line: "tick 5" },
  } });
  const line = summaryLine(turn, theme, W, false, 2000);
  assert.ok(line.includes("1 matched"), line);
  turn.open = true;
  assert.ok(!summaryLine(turn, theme, W, false, 2000).includes("matched"), "opened, the row itself carries it");
  resetJobs(); // the store is global: later fixtures must not inherit this job
});

test("the summary line is cached per frame but rebuilt when a second passes or the turn moves", () => {
  const { store } = fixture("afterRun", false);
  const turn = store.current!;
  // Folded: the summary is where a failure is counted (open, its group says it).
  turn.open = false;
  const theme = getTheme()!;
  const early = summaryLine(turn, theme, W, false, 2500);
  // 1500 ms and 1600 ms of wall time both read "2s", so the cache may serve.
  assert.equal(summaryLine(turn, theme, W, false, 2600), early);
  assert.notEqual(summaryLine(turn, theme, W, false, 3500), early, "a later second repaints");
  const before = summaryLine(turn, theme, W, false, 4000);
  store.note({ role: "toolResult", toolCallId: "a", toolName: "read", isError: true, content: [], timestamp: 1650 } as any);
  const after = summaryLine(turn, theme, W, false, 4000);
  assert.ok(after.includes("1 failed"), after);
  assert.notEqual(after, before, "a failure the turn gained lands on the next frame");
});

/**
 * The folded turn's summary at `width`. A fresh turn per call: `summaryCache`
 * keys on the turn and the width, and these reads are the same turn twice.
 */
function summaryAt(width: number, icons: boolean): string {
  const { store } = fixture();
  turnOptions.set({ ...turnOptions.get(), icons });
  return summaryLine(store.byTool.get("a")!, getTheme()!, width, false, 4000);
}

test("the summary's counts and its LLM time wear the kind and provider glyphs", () => {
  const line = summaryAt(W, true);
  assert.ok(visibleWidth(line) <= W, line);
  const text = visibleText(line);
  assert.ok(text.includes("\u{f06e} read×1"), text);
  assert.ok(text.includes("\u{f044} edit×1"), text);
  assert.ok(text.includes("\uec82 LLM "), "anthropic's glyph, the one the reply's border draws");
  assert.ok(text.includes("2 calls"), "the call total has no kind to name");
});

test("a row too narrow for the glyphs comes back as the plain line, count for count", () => {
  const icon = summaryAt(W, true);
  const plain = summaryAt(W, false);
  const room = visibleWidth(icon);
  assert.ok(room > visibleWidth(plain), "the glyphs cost cells");
  assert.equal(summaryAt(room, true), icon, "its own width still fits the glyphs");
  const tight = summaryAt(room - 1, true);
  assert.equal(tight, summaryAt(room - 1, false), "the fallback is the current line, byte for byte");
  const text = visibleText(tight);
  assert.ok(!text.includes("\u{f06e}") && !text.includes("\uec82"), text);
  assert.ok(text.includes("read×1") && text.includes("edit×1"), `the tail truncation must not eat a count:\n${text}`);
});

test("with icons off the summary is exactly the line it was before", () => {
  const theme = getTheme()!;
  const muted = (text: string) => theme.fg("muted", text);
  const expected = [
    muted("▸ took 1s"), muted("LLM 0s"), muted("tools 0s"), muted("2 calls"), muted("read×1"), muted("edit×1"),
  ].join(muted(" · "));
  assert.equal(summaryAt(W, false), expected);
  assert.equal(summaryAt(20, false), clipToWidth(expected, 20, "…"), "a clipped line clips the same way");
});

test("codemode has a glyph of its own, one cell wide like its neighbours", () => {
  const glyph = toolKindIcon("codemode");
  assert.notEqual(glyph, DEFAULT_TOOL_ICON);
  assert.equal(visibleWidth(glyph), 1);
  assert.equal(toolKindIcon("no-such-tool"), DEFAULT_TOOL_ICON, "an unmapped name keeps the wrench");
  assert.equal(toolKindIcon("mcp"), "\u{f12e}", "mcp is still its own kind");
});

test("outer fold hides all process including thinking and always-shown edits; summary stays before final reply", () => {
  const { chat } = fixture();
  const folded = frame(chat).join("\n");
  assert.ok(folded.includes("took 1s"));
  assert.match(folded, /took.*\d+ calls/, "folded, the summary is the only count");
  assert.ok(folded.includes("Fixed the result"));
  assert.ok(folded.includes("claude-sonnet-4-5"));
  assert.ok(!folded.includes("Checking the implementation"));
  assert.ok(!folded.includes("thinking"));
  assert.ok(!folded.includes("diff"));
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  assert.ok(opened.join("\n").includes("Checking the implementation"));
  assert.ok(opened.join("\n").includes("diff"));
  assert.equal(opened.filter((line) => line.includes("took")).length, 1);
  assert.doesNotMatch(opened.find((line) => line.includes("took"))!, /calls/, "open, the group headers count the calls");
  assert.ok(opened.findIndex((line) => line.includes("took")) < opened.findIndex((line) => line.includes("Checking the implementation")), "an opened turn keeps its summary at the top");
  assert.ok(opened.findIndex((line) => line.includes("took")) < opened.findIndex((line) => line.includes("claude-sonnet-4-5")));
  click(chat, (line) => line.includes("took"));
  assert.equal(frame(chat).join("\n"), folded);
});

test("an open turn hangs its process on a rail, and the reply stands clear of it at full width", () => {
  const { chat, read } = fixture("afterRun", true, true);
  assert.ok(!frame(chat).some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), "folded: no rail");
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  const top = opened.findIndex((line) => line.includes("took"));
  const reply = opened.findIndex((line) => line.includes("claude-sonnet-4-5"));
  const process = opened.slice(top + 1, reply).filter((line) => line.trim());
  assert.ok(process.length > 2, opened.join("\n"));
  assert.ok(process.every((line) => line.startsWith("│")), opened.join("\n"));
  assert.ok(process.some((line) => line.startsWith("│ ▾ ") && line.includes("call")), `the group sits one level in:\n${opened.join("\n")}`);
  assert.ok(opened[top]!.startsWith("▾ took"), "the rail runs down from the summary's marker");
  assert.ok(opened[reply]!.startsWith("├─ "), `the rail runs into the reply's corner:\n${opened.join("\n")}`);
  assert.ok(opened.slice(reply + 1).every((line) => !line.startsWith("│ ▾")), opened.join("\n"));
  assert.equal(opened[reply]!.length, W, "the reply keeps the full width");
  assert.ok(opened.every((line) => visibleWidth(line) <= W), opened.join("\n"));

  // A click reaches the call through the rail.
  const y = opened.findIndex((line) => line.startsWith("│ │") && line.includes("read"));
  assert.ok(y >= 0, opened.join("\n"));
  chat.handleMouse({ type: "click", button: "left", x: 20, y, screenX: 20, screenY: y, width: W, height: opened.length, shift: false, alt: false, ctrl: false } as any);
  assert.equal((read as any).expanded, true);

  click(chat, (line) => line.includes("took"));
  const closed = frame(chat);
  assert.ok(!closed.some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), "folded again: no rail");
  assert.ok(closed.some((line) => line.startsWith("╭─ ") && line.includes("claude-sonnet-4-5")), `no rail, no join:\n${closed.join("\n")}`);
});

test("without a frame the reply still stands clear of the rail, and while running nothing is the reply yet", () => {
  const { chat } = fixture("afterRun", true, true);
  turnOptions.set({ ...turnOptions.get(), frameFinalReply: false });
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  const reply = opened.find((line) => line.includes("Fixed the result"))!;
  assert.ok(!reply.startsWith("│"), opened.join("\n"));
  assert.ok(opened.some((line) => line.startsWith("│ ▾ ")), opened.join("\n"));
  const running = fixture("afterRun", false, true);
  turnOptions.set({ ...turnOptions.get(), frameFinalReply: false });
  const live = frame(running.chat);
  assert.ok(live.some((line) => line.startsWith("│")), live.join("\n"));
  assert.ok(!live.some((line) => line.includes("running") && line.startsWith("│")), "the summary itself is not on the rail");
});

test("a framed box on the rail takes the pointer in its own coordinates", () => {
  const { chat, edit } = fixture("afterRun", true, false);
  click(chat, (line) => line.includes("took"));
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes("x.ts") || line.includes("╭"));
  assert.ok(y >= 0, lines.join("\n"));
  const seen: number[] = [];
  const target = (edit as any).getRenderShell() === "self" ? (edit as any).selfRenderContainer : (edit as any).contentBox;
  const geometry = (edit as any).__frameGeometry;
  assert.ok(geometry, "the edit drew a frame");
  target.handleMouse = (event: any) => { seen.push(event.x); return { handled: true }; };
  // Past the rail and its gap (2) and the left border (1), column 7 of the screen is column 4 of the source.
  (edit as any).handleMouse({ type: "press", button: "left", x: 7, y: geometry.top + 1, width: W, height: 10 });
  assert.deepEqual(seen, [4]);
});

test("the rail takes the colour of the reply it runs into", () => {
  const painted: string[] = [];
  const theme: any = { fg: (color: string, value: string) => { painted.push(color); return value; } };
  railRows(["one"], theme);
  assert.deepEqual(painted, [turnOptions.get().assistantColor]);
});

test("box corners join only where asked, and the frame's other rows stay put", () => {
  const box = ["\x1b[36m╭─ a ─╮\x1b[39m", "│ ╭ x │", "│ ╰ y │", "\x1b[36m╰─────╯\x1b[39m"];
  assert.equal(joinBoxCorners(box, false, false), box);
  assert.deepEqual(joinBoxCorners(box, true, false), ["\x1b[36m├─ a ─╮\x1b[39m", box[1], box[2], box[3]]);
  assert.deepEqual(joinBoxCorners(box, false, true), [box[0], box[1], box[2], "\x1b[36m├─────╯\x1b[39m"]);
  const both = joinBoxCorners(box, true, true);
  assert.equal(joinBoxCorners(box, true, true), both, "the same rows come back as the same array");
  assert.equal(box[0], "\x1b[36m╭─ a ─╮\x1b[39m", "the box's own rows are not written to");
});

test("the rail starts after a row's opening prompt marker", () => {
  const theme: any = { fg: (_: string, value: string) => value };
  const rows = ["\x1b]133;A\x07one", "two\x1b]133;B\x07"];
  const railed = railRows(rows, theme);
  assert.deepEqual(railed, ["\x1b]133;A\x07│one", "│two\x1b]133;B\x07"]);
  assert.equal(railRows(rows, theme), railed, "the same rows come back as the same array");
});

test("with turn folding off there is no rail", () => {
  const { chat } = fixture("off", true, true);
  assert.ok(!frame(chat).some((line) => line.startsWith("│ ▾") || line.startsWith("│ │")), frame(chat).join("\n"));
});

test("outer toggling preserves groupOpen and forgets a manually opened tool box", () => {
  const { chat, read } = fixture("afterRun", true, true);
  click(chat, (line) => line.includes("took"));
  assert.ok(frame(chat).some((line) => line.includes("✓") && line.includes("read")));
  click(chat, (line) => line.includes("✓") && line.includes("read"));
  assert.equal((read as any).expanded, true);
  click(chat, (line) => line.includes("took"));
  click(chat, (line) => line.includes("took"));
  // A folded turn forgets which of its calls were open, so reopening it shows the
  // rows it opened with; the groups keep the level the reader left them at.
  assert.equal((read as any).expanded, false);
  assert.ok(frame(chat).some((line) => line.includes("✓") && line.includes("read")), "the row is back");
});

test("afterRun keeps an active run open; live folds it and replaces its latest text", () => {
  const active = fixture("afterRun", false);
  assert.ok(frame(active.chat).join("\n").includes("Checking the implementation"));
  const live = fixture("live", false);
  assert.ok(!frame(live.chat).join("\n").includes("Checking the implementation"));
  assert.ok(frame(live.chat).join("\n").includes("Now I will fix"));
  live.store.note(final); live.chat.addChild(live.answer);
  assert.ok(!frame(live.chat).join("\n").includes("Now I will fix"));
  assert.ok(!frame(live.chat).join("\n").includes("claude-sonnet-4-5"), "streaming final text is not boxed yet");
  live.store.settle(false, 1800);
  assert.ok(frame(live.chat).join("\n").includes("claude-sonnet-4-5"));
});

test("a steer is a second segment: two summaries with the message between them", () => {
  const { chat } = talkedTo([
    { role: "user", content: "Fix this", timestamp: 1000 },
    step(1100, "first", "CHECKING ONE"),
    { role: "user", content: "And read second.ts too", timestamp: 2000 },
    step(2100, "second", "CHECKING TWO"),
    closing(2300, "Both done."),
  ]);
  const lines = frame(chat);
  const at = (predicate: (line: string) => boolean) => lines.findIndex(predicate);
  const summaries = lines.flatMap((line, index) => (line.includes("took") ? [index] : []));
  assert.equal(summaries.length, 2, lines.join("\n"));
  const asked = at((line) => line.includes("And read second.ts too"));
  assert.ok(summaries[0]! < asked && asked < summaries[1]!, lines.join("\n"));
  assert.ok(!lines.join("\n").includes("CHECKING"), "each summary folds its own process");
  assert.ok(!lines.join("\n").includes("interrupted"), "a steer is not an abort");
  assert.ok(lines.some((line) => line.includes("Both done.")));
  // They fold on their own: opening the first leaves the steer's run closed.
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat);
  const text = opened.join("\n");
  assert.equal(opened.filter((line) => line.includes("▸ took")).length, 1, text);
  assert.ok(opened.some((line) => line.startsWith("▾ took")), text);
  assert.ok(text.includes("CHECKING ONE"), text);
  assert.ok(!text.includes("CHECKING TWO"), `the segment after the steer stays folded:\n${text}`);
});

test("a follow-up leaves the answer it interrupted in view", () => {
  const { chat, store } = talkedTo([
    { role: "user", content: "Fix this", timestamp: 1000 },
    step(1100, "first", "CHECKING"),
    closing(1300, "First answer."),
    { role: "user", content: "And the tests?", timestamp: 2000 },
    closing(2100, "Second answer."),
  ]);
  const lines = frame(chat);
  const at = (predicate: (line: string) => boolean) => lines.findIndex(predicate);
  const summary = at((line) => line.includes("took"));
  const answer = at((line) => line.includes("First answer."));
  const asked = at((line) => line.includes("And the tests?"));
  const second = at((line) => line.includes("Second answer."));
  assert.ok(summary >= 0 && summary < answer, lines.join("\n"));
  assert.ok(answer < asked && asked < second, lines.join("\n"));
  assert.ok(!lines.join("\n").includes("src/first.ts"), "the first segment's call is folded away");
  assert.equal(new Set(store.byMessage.values()).size, 2, "the follow-up opened a second turn");
});

test("a session saved before the split restores as two runs", () => {
  const messages: any[] = [
    { role: "user", content: "Fix this", timestamp: 1000 },
    step(1100, "first", "CHECKING ONE"),
    { role: "user", content: "And read second.ts too", timestamp: 2000 },
    step(2100, "second", "CHECKING TWO"),
    closing(2300, "Both done."),
  ];
  const { chat } = talkedTo(messages);
  // What 0.9.7 saved: one entry for the whole run, the second message included.
  const saved = { keys: messages.map((message) => messageKey(message)!), startedAt: 1000, endedAt: 4000,
    outcome: "completed", toolMs: 20 };
  const restored = new TurnStore();
  restored.restore([...messages.map((message) => ({ type: "message", message })),
    { type: "custom", customType: TURN_ENTRY, data: saved }]);
  turnStore.set(restored);
  const lines = frame(chat);
  const summaries = lines.flatMap((line, index) => (line.includes("took") ? [index] : []));
  assert.equal(summaries.length, 2, lines.join("\n"));
  const asked = lines.findIndex((line) => line.includes("And read second.ts too"));
  assert.ok(summaries[0]! < asked && asked < summaries[1]!, lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("Both done.")));
  assert.ok(!lines.join("\n").includes("CHECKING"), lines.join("\n"));
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat).join("\n");
  assert.ok(opened.includes("CHECKING ONE"), opened);
  assert.ok(!opened.includes("CHECKING TWO"), opened);
});

test("the final reply frame never carries the message's thinking", () => {
  const { chat } = fixture();
  click(chat, (line) => line.includes("took"));
  const opened = frame(chat).join("\n");
  assert.ok(opened.includes("Fixed the result"));
  assert.ok(!opened.includes("Verify the final result carefully"), "the answer frame holds only the answer");
  assert.ok(opened.includes("Inspect the source carefully"), "process thinking still shows outside it");
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
    turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: true });
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
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "off", frameFinalReply: false, icons: true });
  const lines = chat.render(W).map(visibleText);
  const y = lines.findIndex((line) => line.includes("Fixed the result"));
  const x = lines[y].indexOf("Fixed");
  const result = chat.handleMouse({ type: "press", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false });
  assert.equal(result?.target?.component, markdown);
  assert.equal(events.at(-1)?.width, W);
  assert.equal(events.at(-1)?.x, x, "turn features off must remove the frame's mouse transform too");
});

test("caught nested failures remain visible, and final framing can be disabled independently", () => {
  const { chat, store } = fixture();
  // A calling tool may succeed while one of its nested calls fails.
  const turn = store.byTool.get("a")!;
  turn.tools.get("a")!.nestedFailed = 1;
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: false, icons: true });
  const lines = frame(chat).join("\n");
  assert.ok(lines.includes("1 nested failed"));
  assert.ok(lines.includes("Fixed the result"));
  assert.ok(!lines.includes("claude-sonnet-4-5"));
  assert.ok(!lines.includes("╭"));
});

test("OSC 133 zones stay at the frame's row edges, never inside it", () => {
  const { chat } = fixture();
  const raw = chat.render(W);
  const start = raw.find((line) => line.includes("\x1b]133;A\x07") && line.includes("Fixed the result"));
  assert.ok(start, "the first body row carries zone A");
  assert.ok(start.startsWith("\x1b]133;A\x07"), "zone A must open the row, before the border");
  assert.ok(start.indexOf("│") > 0, "the border follows the marker");
  // The reply's own last row: a folded turn's hidden rows carry their markers too.
  let end: string | undefined;
  for (let row = raw.length - 1; row >= 0; row--) if (raw[row]!.includes("\x1b]133;B\x07")) { end = raw[row]; break; }
  assert.ok(end, "the last body row carries zone B/C");
  assert.ok(end.endsWith("\x1b]133;B\x07\x1b]133;C\x07"), "zone B/C must close the row, after the border");
});

test("the turn summary lights up and takes the hand like a group row", () => {
  enableHoverForTests();
  resetHover();
  const { chat } = fixture();
  const y = frame(chat).findIndex((line) => line.includes("took"));
  assert.ok(y >= 0);
  const move = (row: number) => chat.handleMouse({ type: "move", button: "none", x: 4, y: row, screenX: 4, screenY: row, width: W, height: 40, shift: false, alt: false, ctrl: false });
  move(y);
  const hot = chat.render(W).find((line) => line.includes("took"))!;
  assert.ok(hot.includes("▶"), "the marker turns solid under the pointer");
  assert.ok(/\x1b\[48;/.test(hot), "the row wears the selected background");
  move(y + 1);
  const cold = chat.render(W).find((line) => line.includes("took"))!;
  assert.ok(cold.includes("▸"));
  assert.ok(!/\x1b\[48;/.test(cold), "the band goes away with the pointer");
  resetHover();
  disableHoverForTests();
});

test("the clock is local and gains a date when it is not today", () => {
  const at = new Date(2026, 10, 1, 9, 5).getTime();
  assert.equal(formatMessageTime(at, "auto", new Date(2026, 10, 1, 23, 0).getTime()), "09:05");
  assert.equal(formatMessageTime(at, "auto", new Date(2026, 10, 2, 1, 0).getTime()), "11-01 09:05");
});

test("a time pattern reads tokens and leaves literal text alone", () => {
  const at = new Date(2026, 10, 5, 13, 9, 32).getTime();
  assert.equal(formatMessageTime(at, "M月D日 HH:mm:ss"), "11月5日 13:09:32");
  assert.equal(formatMessageTime(at, "YYYY-MM-DD H:mm"), "2026-11-05 13:09");
  assert.equal(formatMessageTime(new Date(2026, 0, 2, 3, 4).getTime(), "M/D H MM DD HH"), "1/2 3 01 02 03");
});

test("the final frame takes the assistant color and the time format", () => {
  const { chat } = fixture();
  const options = turnOptions.get();
  turnOptions.set({ ...options, assistantColor: "#cfd1a6", timeFormat: "YYYY" });
  try {
    const rows = chat.render(W);
    const top = rows.find((line) => line.includes("claude-sonnet-4-5"));
    // Truecolor, or the nearest 256-color entry on a terminal without it.
    assert.match(top ?? "", /\x1b\[38;(?:2;207;209;166|5;\d+)m/, "the border is the configured hex");
    assert.ok(top?.includes(String(new Date(final.timestamp).getFullYear())));
  } finally {
    turnOptions.set(options);
  }
});

test("a rail reply is its frame without sides or corners, and copies as its text", () => {
  const { chat } = fixture();
  const options = turnOptions.get();
  try {
    turnOptions.set({ ...options, replyStyle: "frame" });
    const framed = chat.render(W).map(visibleText);
    turnOptions.set({ ...options, replyStyle: "rail" });
    const rows = chat.render(W);
    const plain = rows.map(visibleText);
    const top = plain.findIndex((line) => line.includes("claude-sonnet-4-5"));
    // The label sits in the same cells as on the frame's top edge.
    assert.equal(plain[top], framed[framed.findIndex((line) => line.includes("claude-sonnet-4-5"))]!.replace(/[╭╮]/g, "─"));
    assert.equal(visibleWidth(rows[top]!), W);
    const bottom = plain.findIndex((line, row) => row > top && /^─+$/.test(line));
    assert.ok(bottom > top + 1);
    assert.equal(visibleWidth(rows[bottom]!), W);
    for (const line of plain.slice(top + 1, bottom)) assert.doesNotMatch(line, /[│├┤╭╮╰╯]/, line);
    const text = plain.find((line) => line.includes("Fixed the result"))!;
    assert.equal(text.indexOf("Fixed"), framed.find((line) => line.includes("Fixed the result"))!.indexOf("Fixed"), "the text keeps its column");
    const cleaned = cleanTranscriptRows(rows, top, bottom).rows;
    assert.equal(cleaned[0], null);
    assert.equal(cleaned.at(-1), null);
    assert.ok(cleaned.some((row) => row?.text.startsWith("Fixed the result")), cleaned.map((row) => (row ? row.text : "NULL")).join("\n"));
    assert.ok(cleaned.some((row) => row?.text.trim() === "const value = 2;"), "the code is still what copies");
  } finally {
    turnOptions.set(options);
  }
});

test("the final frame carries the message's clock next to the model", () => {
  const { chat } = fixture();
  const top = chat.render(W).find((line) => line.includes("claude-sonnet-4-5"));
  assert.ok(top);
  assert.ok(top.includes(formatMessageTime(final.timestamp)));
});

test("deepseek's glyph keeps the final frame at the terminal width", () => {
  const { provider, model } = final;
  final.provider = "deepseek";
  final.model = "deepseek-v4-pro";
  try {
    const { chat } = fixture();
    const lines = frame(chat);
    const top = lines.find((line) => line.includes("deepseek-v4-pro"));
    assert.ok(top);
    assert.ok(top.includes("\u{f18b4} deepseek-v4-pro"), "one cell, one colour: md-dolphin, not the whale emoji");
    assert.equal(visibleWidth(top), W);
  } finally {
    final.provider = provider;
    final.model = model;
  }
});

test("pure chat gets no empty process summary; the final frame names the model, not the provider", () => {
  const { chat } = fixture("off");
  const plainChat = frame(chat).join("\n");
  assert.ok(!plainChat.includes("took"));
  assert.ok(plainChat.includes("claude-sonnet-4-5"), "the model is the name on the border");
  assert.ok(!plainChat.includes("anthropic"), "the vendor is the glyph's job");
  assert.equal(replyLabel("unknown-provider", "some-model", true), "\u{f06a9} some-model");
  assert.equal(replyLabel("deepseek", "deepseek-chat", true), "\u{f18b4} deepseek-chat");
  assert.equal(replyLabel("deepseek", "deepseek-chat", false), "deepseek-chat");
  assert.equal(replyLabel("openai-codex", "gpt-6.1-sol", true), "\uec81 gpt-6.1-sol");
  assert.equal(replyLabel("anthropic", undefined, false), "anthropic", "no model recorded: the provider is the best name left");
  assert.equal(replyLabel(undefined, undefined, true), "\u{f06a9} agent");
  assert.ok(frame(chat).every((line) => visibleWidth(line) <= W));
  const store = new TurnStore(); turnStore.set(store);
  const plain = { ...final, content: [{ type: "text", text: "Just chatting" }] };
  store.begin(1000); store.note(user); store.note(plain); store.settle(false, 1800);
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: true });
  const only = new Container(); only.addChild(new AssistantMessageComponent(plain, true));
  const rendered = frame(only).join("\n");
  const raw = only.render(W).join("\n");
  for (const marker of ["A", "B", "C"]) assert.equal((raw.match(new RegExp(`\\x1b\\]133;${marker}\\x07`, "g")) ?? []).length, 1);
  assert.ok(rendered.includes("claude-sonnet-4-5"));
  assert.ok(!rendered.includes("took"));
});

test("rhythm: a row after your message, none between a folded summary and the reply, and a closed frame breathes inside", () => {
  const { chat } = fixture();
  turnOptions.set({ ...turnOptions.get(), replyStyle: "frame" });
  const rows = frame(chat);
  const summary = rows.findIndex((line) => line.includes("took"));
  const reply = rows.findIndex((line) => line.includes("claude-sonnet-4-5"));
  assert.equal(rows[summary - 1], "", `one blank between your message and the run:\n${rows.join("\n")}`);
  assert.equal(reply, summary + 1, `the reply's top edge is the separation:\n${rows.join("\n")}`);
  assert.match(rows[reply + 1]!, /^│ +│$/, "a row clear under the top edge");
  assert.ok(rows[reply + 2]!.includes("Fixed the result"), rows.join("\n"));
  const bottom = rows.findIndex((line, index) => index > reply && line.startsWith("╰"));
  assert.match(rows[bottom - 1]!, /^│ +│$/, "and over the bottom one");
  const rule = rows.findIndex((line) => line.startsWith("├─ ts "));
  assert.ok(rule > reply && rows[rule]!.endsWith("┤"), `a code block still meets both edges:\n${rows.join("\n")}`);
});

test("rhythm: a run nothing of yours started stands two rows clear of the one before", () => {
  const { chat } = fixture("afterRun", true, false, true, false);
  const rows = frame(chat);
  const summary = rows.findIndex((line) => line.includes("took"));
  assert.equal(summary, 2, rows.join("\n"));
  assert.deepEqual(rows.slice(0, 2), ["", ""]);
});

test("an open run's line comes down through the reply's own gap into its corner, and on to its bottom one", () => {
  for (const replyStyle of ["frame", "rail"] as const) {
    const { chat } = fixture();
    turnOptions.set({ ...turnOptions.get(), replyStyle });
    click(chat, (line) => line.includes("took"));
    const rows = frame(chat);
    const reply = rows.findIndex((line) => line.includes("claude-sonnet-4-5"));
    assert.equal(rows[reply - 1]!.trimEnd(), "│", `${replyStyle}: the reply is the last step, one row clear\n${rows.join("\n")}`);
    assert.notEqual(rows[reply - 2]!.trimEnd(), "│", "and only one");
    assert.ok(rows[reply]!.startsWith("├─ "), `${replyStyle}: ${rows[reply]}`);
    assert.equal(visibleWidth(rows[reply]!), W);
    const bottom = rows.findIndex((line, index) => index > reply && line.startsWith("╰"));
    assert.ok(bottom > reply, `${replyStyle}: the line ends in the bottom edge\n${rows.join("\n")}`);
    assert.ok(rows.slice(reply + 1, bottom).every((line) => line.startsWith("│") || line.startsWith("├")), `${replyStyle}\n${rows.join("\n")}`);
    assert.equal(rows[bottom]!.endsWith("╯"), replyStyle === "frame", rows[bottom]);
    // The header row is where it was drawn; the pointer still finds it.
    click(chat, (line) => line.includes("took"));
    assert.ok(!frame(chat).some((line) => line.startsWith("│ ▾")), "folded again through a click on the header");
  }
  turnOptions.set({ ...turnOptions.get(), replyStyle: "frame" });
});

test("rhythm: a step is its thought, its text and its calls; each one that says something stands one row clear", () => {
  for (const mode of ["afterRun", "off"] as const) {
    const { chat } = fixture(mode);
    if (mode === "afterRun") click(chat, (line) => line.includes("took"));
    const rows = frame(chat).map((line) => line.trimEnd());
    const thought = rows.findIndex((line) => line.includes("Inspect the source carefully"));
    assert.ok(rows[thought + 1]!.includes("Checking the implementation."), `${mode}: the thought sits on its text\n${rows.join("\n")}`);
    const next = rows.findIndex((line) => line.includes("Now I will fix the implementation."));
    assert.equal(rows[next - 1], mode === "off" ? "" : "│", `${mode}: one row, carrying the run's line when there is one\n${rows.join("\n")}`);
    assert.notEqual(rows[next - 2]?.trim(), "", "and only one");
    const reply = rows.findIndex((line) => line.includes("claude-sonnet-4-5"));
    assert.equal(rows[reply - 1], mode === "off" ? "" : "│", `${mode}: the reply is the last step, one row clear\n${rows.join("\n")}`);
  }
});

test("rhythm: a step with no text adds no gap: its thought sits in the group it joins", () => {
  const content = middle.content;
  // Thinking, then the call, and nothing said: the step joins the group above it.
  middle.content = [{ type: "thinking", thinking: "Plan the edit" }, content[1]];
  try {
    const { chat } = fixture("afterRun", true, true);
    click(chat, (line) => line.includes("took"));
    const rows = frame(chat).map((line) => line.trimEnd());
    const read = rows.findIndex((line) => line.includes("read ✓"));
    assert.ok(rows[read + 1]!.includes("Plan the edit"), `no gap inside the group\n${rows.join("\n")}`);
  } finally {
    middle.content = content;
  }
});

test("rhythm: a rail reply has no inner padding", () => {
  const { chat } = fixture();
  turnOptions.set({ ...turnOptions.get(), replyStyle: "rail" });
  const rows = frame(chat);
  const reply = rows.findIndex((line) => line.includes("claude-sonnet-4-5"));
  assert.ok(rows[reply + 1]!.includes("Fixed the result"), rows.join("\n"));
  turnOptions.set({ ...turnOptions.get(), replyStyle: "frame" });
});

test("open, a run's summary leaves its failures to the groups they happened in", () => {
  const { store } = fixture("afterRun", false);
  const turn = store.current!;
  store.note({ role: "toolResult", toolCallId: "a", toolName: "read", isError: true, content: [], timestamp: 1650 } as any);
  const theme = getTheme()!;
  turn.open = true;
  assert.ok(!visibleText(summaryLine(turn, theme, W, false, 4000)).includes("failed"), "the group line says it");
  turn.open = false;
  assert.ok(visibleText(summaryLine(turn, theme, W, false, 4000)).includes("1 failed"), "folded, nothing else would");
});

test("the reply's name is the one accent, and its edges are the chrome grey", () => {
  const { chat } = fixture();
  turnOptions.set({ ...turnOptions.get(), replyStyle: "frame", assistantColor: "border" });
  const theme = getTheme()!;
  let rows: readonly string[] = [];
  for (let pass = 0; pass < 4; pass++) rows = chat.render(W);
  const top = rows.find((row) => visibleText(row).includes("claude-sonnet-4-5"))!;
  assert.ok(top.includes(theme.fg("accent", replyLabel("anthropic", "claude-sonnet-4-5", true))), JSON.stringify(top));
  const sgr = (text: string) => /^\x1b\[[0-9;]*m/.exec(text)?.[0];
  assert.equal(sgr(top), sgr(paint(theme, "border", "╭")), "the corner is grey");
  // The summary's words are grey; an icon may wear its tool's colour, and with no colour
  // set for a tool that is the accent its box wears too.
  const summary = rows.find((row) => visibleText(row).includes("took"))!;
  const accent = sgr(theme.fg("accent", "x"))!;
  const painted = summary.split(accent).slice(1).map((part) => visibleText(part.split("\x1b[")[0]!));
  assert.ok(painted.every((text) => /^[\uE000-\uF8FF\u{F0000}-\u{FFFFF}]+$/u.test(text)), JSON.stringify(painted));
});

