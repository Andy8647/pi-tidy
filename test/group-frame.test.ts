/**
 * The grouping end to end on pi's real components: ToolExecutionComponent with
 * pi's own bash/edit definitions, AssistantMessageComponent, and clicks
 * dispatched through pi-tui's Container.handleMouse with screen rows — the same
 * path a terminal click takes.
 *
 * Runs in its own process (node --test isolates files), so the options set
 * here do not leak into the box-rendering tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { toolboxEnabled } from "../live.ts";

initTheme("dark");
const OPTIONS = { icons: false, groupTools: true } as const;
patchToolBoxFrames(OPTIONS);

let renders = 0;
const ui = { requestRender: () => renders++ };
const cwd = process.cwd();
const bashDef = createBashToolDefinition(cwd);
const editDef = createEditToolDefinition(cwd);
const W = 90;

/** `expanded` is private in pi's typings; the tests read it as pi's state. */
type Box = { expanded: boolean } & Pick<ToolExecutionComponent, "render" | "invalidate" | "setExpanded">;

let nextId = 0;
const callBlock = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });

/** A finished bash call, built the way pi builds one. */
function bash(command: string, output: string, extra: { isError?: boolean; partial?: boolean } = {}) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("bash", id, { command }, {}, bashDef as any, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  if (!extra.partial) {
    c.updateResult(
      { content: [{ type: "text", text: output }], isError: extra.isError ?? false, durationMs: 150 } as any,
      false,
    );
  }
  return { id, component: c as unknown as Box };
}

function edit(path: string) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("edit", id, { path, edits: [{ oldText: "a", newText: "b" }] }, {}, editDef as any, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult(
    {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      durationMs: 20,
      details: { diff: "-1 const a = 1;\n+1 const a = 2;", firstChangedLine: 1 },
    } as any,
    false,
  );
  return { id, component: c as unknown as Box };
}

const text = (t: string) => new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" } as any);
/** A model step with text that also calls `id`. */
const textStep = (t: string, id: string, name = "bash") =>
  new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }, callBlock(id, name)], stopReason: "toolUse" } as any);
/** A tool-only model step (thinking hidden, as in `hideThinkingBlock: true`). */
const step = (id: string, name = "bash") =>
  new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "thinking", thinking: "…" }, callBlock(id, name)], stopReason: "toolUse" } as any,
    true,
  );

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();

/** Render until the patch stops asking pi for another frame. */
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders;
    lines = chat.render(W);
    if (renders === before) break;
  }
  return lines.map(strip);
}

/** Click the first row containing `needle`, the way pi-tui dispatches it. */
function click(chat: Container, needle: string, x = 4): unknown {
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  const event = { type: "click", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false };
  return chat.handleMouse(event as any);
}

function threeBash() {
  const chat = new Container();
  const a = bash("ls", "a\nb");
  const b = bash("pwd", "/tmp");
  const c = bash("whoami", "andy");
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  chat.addChild(step(c.id));
  chat.addChild(c.component);
  chat.addChild(text("Done."));
  return { chat, a, b, c };
}

const visible = (lines: string[]) => lines.filter((line) => line.trim());

test("three bash calls across three model steps render as one C line", () => {
  const { chat } = threeBash();
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 0.5s", " Done."]);
});

test("C → ▾ + rows → one box → back to its row → ▾ folds back to C", () => {
  const { chat, b } = threeBash();
  assert.ok(click(chat, "3 calls"));
  assert.deepEqual(visible(frame(chat)), [
    " Checking.",
    " ▾ 3 calls · bash×3 · 0.5s",
    " │ ✓ bash ls  2 lines · 0.2s",
    " │ ✓ bash pwd  1 line · 0.2s",
    " │ ✓ bash whoami  1 line · 0.2s",
    " Done.",
  ]);

  assert.ok(click(chat, "bash pwd"));
  assert.equal(b.component.expanded, true);
  const boxed = frame(chat);
  const top = boxed.findIndex((line) => line.includes("╭"));
  assert.ok(top > 0, "pwd is a full box");
  assert.ok(boxed[top].startsWith(" │ ╭"), "the box sits on the group gutter");

  // A click inside the box goes through pi's own MouseRegion — translated
  // into the box's coordinates — and folds just that box.
  assert.ok(click(chat, "/tmp", 6));
  assert.equal(b.component.expanded, false);
  assert.ok(frame(chat).includes(" │ ✓ bash pwd  1 line · 0.2s"));

  assert.ok(click(chat, "▾ 3 calls"));
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 0.5s", " Done."]);
});

test("folding from ▾ folds the open boxes too, so reopening shows plain rows", () => {
  const { chat, a, c } = threeBash();
  click(chat, "3 calls");
  click(chat, "bash ls");
  click(chat, "bash whoami");
  assert.equal(a.component.expanded && c.component.expanded, true);
  click(chat, "▾ 3 calls");
  assert.equal(a.component.expanded || c.component.expanded, false);
  click(chat, "3 calls");
  assert.equal(frame(chat).filter((line) => line.includes("╭")).length, 0);
});

test("a failed call keeps its row under the folded header and opens on click", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("pnpm test", "boom\n\nCommand exited with code 1", { isError: true });
  chat.addChild(textStep("Testing.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  assert.deepEqual(visible(frame(chat)), [
    " Testing.",
    " ▸ 2 calls · bash×2 · 1 failed · 0.3s",
    " │ ✗ bash pnpm test  exit 1 · 0.2s",
  ]);
  assert.ok(click(chat, "pnpm test"));
  assert.equal(b.component.expanded, true, "straight to the failed call's box");
  assert.ok(frame(chat).some((line) => line.includes("boom")));
});

test("a running call keeps its row under the folded header", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("sleep 30", "", { partial: true });
  chat.addChild(textStep("Waiting.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  const lines = visible(frame(chat));
  assert.equal(lines[1], " ▸ 2 calls · bash×2 · running bash");
  assert.equal(lines[2], " │ ⋯ bash sleep 30");
});

test("edit keeps pi's own box, splits the group, and its box takes clicks", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const e = edit("/tmp/x.ts");
  const b = bash("pnpm test", "ok");
  chat.addChild(textStep("Editing.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(e.id, "edit"));
  chat.addChild(e.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  const lines = frame(chat);
  assert.ok(lines.includes(" ▸ 1 call · bash×1 · 0.2s"));
  assert.ok(lines.some((line) => line.includes("+1 const a = 2;")), "the diff shows without a click");
  assert.equal(lines.filter((line) => line.includes("1 call")).length, 2, "calls after the edit start a new group");

  // edit renders with renderShell "self"; pi's handler for those reads a height
  // only its own render records, so before 0.4.0 these clicks were dropped.
  assert.ok(click(chat, "+1 const a = 2;", 6));
  assert.equal(e.component.expanded, true);
});

test("ctrl+o expands every box and folds back to the C line", () => {
  const { chat } = threeBash();
  frame(chat);
  for (const child of chat.children) (child as any).setExpanded?.(true);
  assert.equal(frame(chat).filter((line) => line.includes("╭")).length, 3);
  for (const child of chat.children) (child as any).setExpanded?.(false);
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 0.5s", " Done."]);
});

test("presses, right clicks and drags are not taken as clicks", () => {
  const { chat, a } = threeBash();
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes("3 calls"));
  for (const event of [
    { type: "press", button: "left" },
    { type: "click", button: "right" },
    { type: "drag", button: "left" },
  ]) {
    const result = chat.handleMouse({ ...event, x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length } as any);
    assert.equal(result, undefined, event.type);
  }
  assert.equal(a.component.expanded, false);
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 0.5s"));
});

test("options are live: a re-patch (what /reload does) and enabled=false take effect", () => {
  const { chat } = threeBash();
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 0.5s"));

  patchToolBoxFrames({ ...OPTIONS, groupTools: false });
  try {
    const lines = frame(chat);
    assert.equal(lines.filter((line) => line.includes("╭")).length, 3, "every call is a box again");
    assert.ok(!lines.some((line) => line.includes("calls")));
    assert.ok(lines.some((line) => line.includes("Thinking...")), "carriers render as pi draws them");

    toolboxEnabled.set(false);
    assert.equal(frame(chat).filter((line) => line.includes("╭")).length, 0, "pi's own unframed boxes");
  } finally {
    toolboxEnabled.set(true);
    patchToolBoxFrames(OPTIONS);
  }
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 0.5s"));
});

test("user-message boundary survives a predecessor-skipping render patch on top", () => {
  // pi-starline replaces UserMessageComponent.prototype.render and only calls
  // the predecessor as a fallback. It loads after toolbox, so it lands on top.
  const proto = UserMessageComponent.prototype as any;
  const previous = proto.render;
  proto.render = function () {
    return ["> user"];
  };
  try {
    const chat = new Container();
    const a = bash("ls", "a");
    const b = bash("pwd", "/tmp");
    // Turn 1 ends with a tool; turn 2 starts with a tool-only step.
    chat.addChild(textStep("Go.", a.id));
    chat.addChild(a.component);
    chat.addChild(new UserMessageComponent("next"));
    chat.addChild(step(b.id));
    chat.addChild(b.component);
    assert.deepEqual(visible(frame(chat)), [" Go.", " ▸ 1 call · bash×1 · 0.2s", "> user", " ▸ 1 call · bash×1 · 0.2s"]);
  } finally {
    proto.render = previous;
  }
});
