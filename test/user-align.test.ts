import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { patchContainerBoxes } from "../src/messages/message-frame.ts";
import { visibleText } from "../src/draw/frame-draw.ts";

initTheme("dark");
const colors = { user: "toolTitle", custom: "warning" };
const options = { includeUser: true, icons: true };

test("right-aligned user frame and icon end at the right edge", () => {
  patchContainerBoxes(colors, { ...options, userAlign: "right" });
  const lines = new UserMessageComponent("hello there").render(60);
  const plain = lines.map(visibleText);
  assert.ok(plain.every((line) => visibleWidth(line) === 60));
  assert.match(plain[0], /^ +╭─+ \u{f007} ─╮$/u);
  assert.match(plain[1], /^ +│ hello there │$/);
  assert.ok(lines[0].startsWith("\x1b]133;A\x07"));
  assert.ok(lines.at(-1)!.startsWith("\x1b]133;B\x07\x1b]133;C\x07"));
});

test("changing alignment invalidates an existing message's cache", () => {
  const message = new UserMessageComponent("hello there");
  patchContainerBoxes(colors, options);
  const left = message.render(60);
  assert.ok(visibleText(left[0]).startsWith("╭─ \u{f007} "));
  assert.equal(message.render(60), left);
  patchContainerBoxes(colors, { ...options, userAlign: "right" });
  const right = message.render(60);
  assert.notEqual(right, left);
  assert.equal(message.render(60), right);
  patchContainerBoxes(colors, options);
  assert.deepEqual(message.render(60), left);
});

test("right alignment preserves narrow, wide-character and multiline content", () => {
  for (const width of [12, 30, 90]) {
    const message = new UserMessageComponent("检查中文内容和边界。\n\n" + "word ".repeat(24));
    patchContainerBoxes(colors, { ...options, icons: false });
    const left = message.render(width).map(visibleText);
    patchContainerBoxes(colors, { ...options, icons: false, userAlign: "right" });
    const right = message.render(width).map(visibleText);
    assert.deepEqual(right.map((line) => line.trimStart()), left.map((line) => line.trimStart()));
    assert.ok(right.every((line) => visibleWidth(line) === width));
  }
});

test("a framed user message does not wait on frameMessages", () => {
  // `frameMessages: false` unframes compactions, branches and notices; your messages
  // follow their own style.
  patchContainerBoxes(colors, { ...options, enabled: false });
  const plain = new UserMessageComponent("hello there").render(60).map(visibleText);
  assert.ok(plain[0]!.startsWith("╭─ \u{f007} "), plain.join("\n"));
  assert.match(plain[1]!, /^│ hello there │/);
  patchContainerBoxes(colors, { ...options, includeUser: false, enabled: true });
  assert.ok(!new UserMessageComponent("hello there").render(60).map(visibleText).some((line) => line.includes("╭")), "and not drawn when their style is off");
  patchContainerBoxes(colors, options);
});

/** A frame's rows as a rail draws them: corners into rule, sides into blanks. */
function opened(row: string): string {
  return row.replace(/[╭╮╰╯]/g, "─").replace(/│/g, " ");
}

test("a rail is the frame without its sides and corners: same rows, same cells", () => {
  for (const userAlign of ["left", "right"] as const) {
    for (const icons of [true, false]) {
      const message = new UserMessageComponent("hello there\nsecond line");
      patchContainerBoxes(colors, { ...options, icons, userAlign });
      const frame = message.render(60).map(visibleText);
      patchContainerBoxes(colors, { ...options, icons, userAlign, userOpen: true });
      const rail = message.render(60).map(visibleText);
      assert.deepEqual(rail, frame.map(opened), `${userAlign}, icons ${icons}`);
      assert.ok(!rail.some((row) => /[╭╮╰╯│]/.test(row)), "no side and no corner left");
    }
  }
  patchContainerBoxes(colors, options);
});

test("a rail keeps pi's OSC 133 markers on its first and last rows", () => {
  patchContainerBoxes(colors, { ...options, userOpen: true });
  const lines = new UserMessageComponent("hello there").render(60);
  assert.ok(lines[0]!.startsWith("\x1b]133;A\x07"));
  assert.ok(lines.at(-1)!.startsWith("\x1b]133;B\x07\x1b]133;C\x07"));
  assert.ok(lines.slice(1, -1).every((line) => !line.includes("\x1b]133;")));
  patchContainerBoxes(colors, options);
});
