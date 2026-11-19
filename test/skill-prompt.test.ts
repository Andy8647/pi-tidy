/**
 * `/skill:<name>` drawn as the prompt it is: one user message, in whatever
 * style user messages have, the typed text with it, the skill's own text one
 * click away. Real pi components.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { patchContainerBoxes } from "../src/frame.ts";
import { tidyEnabled } from "../src/live.ts";
import { adopt, installSkillPrompts } from "../src/messages/skill-prompt.ts";

initTheme("dark");
installSkillPrompts();
patchContainerBoxes({ user: "accent", custom: "warning" }, { icons: false, includeUser: true, userAlign: "right", userMaxWidth: 0.6 });
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();
const W = 80;

const block = (userMessage?: string) => ({
  name: "grill-me",
  location: "/skills/grill-me/SKILL.md",
  content: "# Grill me\n\nAsk one question at a time.",
  ...(userMessage ? { userMessage } : {}),
});

/** The chat as pi builds it for one skill invocation, regrouped the way the hook does. */
function chat(userMessage?: string) {
  const chat = new Container();
  chat.addChild(new Text("earlier", 0, 0));
  const from = chat.children.length;
  chat.addChild(new Spacer(1));
  const skill = new SkillInvocationMessageComponent(block(userMessage) as any);
  chat.addChild(skill);
  if (userMessage) {
    chat.addChild(new Spacer(1));
    chat.addChild(new UserMessageComponent(userMessage));
  }
  adopt(chat as any, from, Date.UTC(2026, 10, 19, 11, 5));
  return { chat, skill };
}

const rows = (container: Container) => container.render(W).map(strip);

test("the invocation is drawn as a user message, with what was typed after it", () => {
  tidyEnabled.set(true);
  const { chat: view } = chat("fix the parser");
  const lines = rows(view);
  const body = lines.join("\n");
  assert.ok(body.includes("/skill:grill-me ▸"), body);
  assert.ok(body.includes("fix the parser"), body);
  assert.ok(!body.includes("[skill]"), "no extension-notice box of its own");
  assert.ok(!body.includes("Ask one question"), "the skill's text waits for a click");
  // One frame, right-aligned like every user message here: not two boxes.
  assert.equal(lines.filter((line) => line.includes("╭")).length, 1, body);
  assert.ok(lines.find((line) => line.includes("╭"))!.startsWith(" "), "right-aligned: " + body);
  assert.equal(view.children.length, 3, "the typed text's own message and its blank row left the chat");
  for (const line of view.render(W)) assert.ok(visibleWidth(line) <= W);
});

test("an invocation with nothing typed after it is the command alone", () => {
  tidyEnabled.set(true);
  const { chat: view } = chat();
  const body = rows(view).join("\n");
  assert.ok(body.includes("/skill:grill-me ▸"), body);
  assert.equal(view.children.length, 3, "nothing to take out");
});

test("a click opens the skill's text inside the prompt, and the next shuts it", () => {
  tidyEnabled.set(true);
  const { chat: view, skill } = chat("fix the parser");
  const lines = rows(view);
  const y = lines.findIndex((line) => line.includes("/skill:grill-me"));
  const x = lines[y]!.indexOf("/skill");
  view.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as any);
  const open = rows(view).join("\n");
  assert.ok(open.includes("/skill:grill-me ▾"), open);
  assert.ok(open.includes("Ask one question at a time."), open);
  assert.ok(open.indexOf("fix the parser") < open.indexOf("Ask one question"), "what was typed stays next to the command");
  // ctrl+o goes through the same switch.
  skill.setExpanded(false);
  assert.ok(!rows(view).join("\n").includes("Ask one question"));
});

test("with tidy off, pi's two components come back in pi's order", () => {
  const { chat: view } = chat("fix the parser");
  tidyEnabled.set(false);
  try {
    const body = rows(view).join("\n");
    assert.ok(body.includes("[skill]"), body);
    assert.ok(body.indexOf("grill-me") < body.indexOf("fix the parser"), body);
  } finally {
    tidyEnabled.set(true);
  }
});
