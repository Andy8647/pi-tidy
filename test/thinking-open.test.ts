/**
 * `thinkingOpen: true`: thinking starts expanded, inside a group and outside
 * one, and a click still folds it. Its own file (node --test isolates files)
 * because the option is process-wide.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { resetGroups } from "../tool-groups.ts";

initTheme("dark");
patchToolBoxFrames({ icons: false, groupTools: true, thinkingOpen: true });

let renders = 0;
const ui = { requestRender: () => renders++ };
const cwd = process.cwd();
const bashDef = createBashToolDefinition(cwd);
const W = 90;

let nextId = 0;
const callBlock = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });

function bash(command: string, output: string) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("bash", id, { command }, {}, bashDef as any, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult({ content: [{ type: "text", text: output }], isError: false, durationMs: 150 } as any, false);
  return { id, component: c };
}

const textStep = (t: string, id: string) =>
  new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }, callBlock(id)], stopReason: "toolUse" } as any);
/** A tool-only step with thinking, pi's own setting hiding it. */
const thinkStep = (id: string, thinking: string) =>
  new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "thinking", thinking }, callBlock(id)], stopReason: "toolUse" } as any,
    true,
  );

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();

function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders;
    lines = chat.render(W);
    if (renders === before) break;
  }
  return lines.map(strip).map((line) => line.replace(/ {2,}/g, "  "));
}

function click(chat: Container, needle: string): void {
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length } as any);
}

const visible = (lines: string[]) => lines.filter((line) => line.trim());
// Longer than a preview row, so only an expanded run shows its tail.
const LONG = "先确认一下这个目录里有什么东西，然后再决定下一步怎么做，最后把结论写进结尾标记里。这一段故意写得很长，用来验证预览行真的会截断。";

test("an opened group shows each step's whole run without a click per row; a click folds one", () => {
  resetGroups();
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("pwd", "/tmp");
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(thinkStep(a.id, LONG));
  chat.addChild(a.component);
  chat.addChild(thinkStep(b.id, "再看工作目录是不是仓库根。"));
  chat.addChild(b.component);

  // The group itself still starts folded.
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 2 calls · bash×2 · 2 thoughts · 0.3s"]);

  click(chat, "2 calls");
  const open = frame(chat);
  assert.ok(open.some((line) => line.includes("结尾标记")), `the first run is expanded:\n${open.join("\n")}`);
  assert.ok(open.some((line) => line.includes("✓ bash pwd")), open.join("\n"));

  // A click on the run's row folds it, and later frames leave it folded.
  click(chat, "thinking  先确认一下这个目录");
  frame(chat);
  const folded = frame(chat);
  assert.ok(!folded.some((line) => line.includes("结尾标记")), `the fold sticks:\n${folded.join("\n")}`);
  assert.ok(folded.some((line) => line.startsWith(" │ thinking  先确认一下这个目录")), folded.join("\n"));
});

test("thinking before a reply starts in its box, and a click folds it for good", () => {
  resetGroups();
  const chat = new Container();
  chat.addChild(
    new AssistantMessageComponent(
      { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "text", text: "Done." }], stopReason: "stop" } as any,
      true,
    ),
  );
  const open = frame(chat);
  assert.ok(open.some((line) => line.includes("结尾标记")), `expanded on the first frame:\n${open.join("\n")}`);
  assert.ok(open.some((line) => line.includes("╭")), `outside a group it gets the box:\n${open.join("\n")}`);

  click(chat, "thinking");
  frame(chat);
  const folded = frame(chat);
  assert.ok(!folded.some((line) => line.includes("结尾标记")), folded.join("\n"));
  assert.ok(folded.some((line) => line.includes("Done.")));
});

test("a step that streams its thinking before its call arrives still opens as a group row", () => {
  resetGroups();
  const chat = new Container();
  const a = bash("ls", "a");
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(a.component);
  const streaming = new AssistantMessageComponent(undefined, true);
  streaming.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: LONG }] } as any, true);
  chat.addChild(streaming);
  frame(chat);

  const b = bash("pwd", "/tmp");
  streaming.updateContent(
    { role: "assistant", content: [{ type: "thinking", thinking: LONG }, callBlock(b.id)], stopReason: "toolUse" } as any,
    false,
  );
  chat.addChild(b.component);
  click(chat, "2 calls");
  const open = frame(chat);
  assert.ok(open.some((line) => line.includes("结尾标记")), open.join("\n"));
});

test("at a turn's start a step first draws as a plain message, then opens as a row once its call arrives", () => {
  resetGroups();
  const chat = new Container();
  const streaming = new AssistantMessageComponent(undefined, true);
  streaming.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: LONG }] } as any, true);
  chat.addChild(streaming);
  // Nothing was called yet: the run draws outside any group, already open.
  assert.ok(frame(chat).some((line) => line.includes("结尾标记")));

  const a = bash("ls", "a");
  streaming.updateContent(
    { role: "assistant", content: [{ type: "thinking", thinking: LONG }, callBlock(a.id)], stopReason: "toolUse" } as any,
    false,
  );
  chat.addChild(a.component);
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as any));
  click(chat, "1 call");
  const open = frame(chat);
  assert.ok(open.some((line) => line.includes("结尾标记")), `still open as a group row:\n${open.join("\n")}`);
});

test("a fold made while the step drew as a plain message survives its call arriving", () => {
  resetGroups();
  const chat = new Container();
  const streaming = new AssistantMessageComponent(undefined, true);
  streaming.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: LONG }] } as any, true);
  chat.addChild(streaming);
  assert.ok(frame(chat).some((line) => line.includes("结尾标记")));
  click(chat, "thinking");
  assert.ok(!frame(chat).some((line) => line.includes("结尾标记")), "folded before the call");

  const a = bash("ls", "a");
  streaming.updateContent(
    { role: "assistant", content: [{ type: "thinking", thinking: LONG }, callBlock(a.id)], stopReason: "toolUse" } as any,
    false,
  );
  chat.addChild(a.component);
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as any));
  click(chat, "1 call");
  const open = frame(chat);
  assert.ok(!open.some((line) => line.includes("结尾标记")), `the fold survives:\n${open.join("\n")}`);
  assert.ok(open.some((line) => line.includes("thinking  先确认一下这个目录")), open.join("\n"));
});

test("pi's hide-thinking toggle folds every run, opened or not", () => {
  resetGroups();
  const chat = new Container();
  const a = bash("ls", "a");
  const step = thinkStep(a.id, LONG);
  const reply = new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "text", text: "Done." }], stopReason: "stop" } as any,
    true,
  );
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(step);
  chat.addChild(a.component);
  chat.addChild(reply);
  click(chat, "1 call");
  assert.equal(frame(chat).filter((line) => line.includes("结尾标记")).length, 2);

  // ctrl+t calls setHideThinkingBlock on every message; it clears the per-run map.
  step.setHideThinkingBlock(false);
  reply.setHideThinkingBlock(false);
  const folded = frame(chat);
  assert.ok(!folded.some((line) => line.includes("结尾标记")), folded.join("\n"));
});

// Last: re-patching is process-wide.
test("with groupTools off pi draws thinking itself, so thinkingOpen changes nothing", () => {
  patchToolBoxFrames({ icons: false, groupTools: false, thinkingOpen: true });
  resetGroups();
  const chat = new Container();
  chat.addChild(
    new AssistantMessageComponent(
      { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "text", text: "Done." }], stopReason: "stop" } as any,
      true,
    ),
  );
  const lines = frame(chat);
  assert.ok(!lines.some((line) => line.includes("结尾标记")), `pi's hideThinkingBlock applies:\n${lines.join("\n")}`);
  assert.ok(lines.some((line) => line.includes("Done.")));
});
