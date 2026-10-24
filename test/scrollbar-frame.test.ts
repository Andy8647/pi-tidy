import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  initTheme,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Spacer, sliceByColumn, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "../frame.ts";

initTheme("dark");
const colors = { user: "toolTitle", custom: "warning", compaction: "customMessageLabel", branch: "mdCode", skill: "accent" };
patchMessageBoxes(colors);
patchContainerBoxes(colors, { includeUser: true });
patchToolBoxFrames({ icons: false, groupTools: false });

function bashBox(): ToolExecutionComponent {
  const cwd = process.cwd();
  const tool = new ToolExecutionComponent(
    "bash", "scrollbar-test", { command: "echo hello" }, {}, createBashToolDefinition(cwd),
    { requestRender() {} } as any, cwd,
  );
  tool.setExpanded(false);
  tool.setArgsComplete();
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: "中文输出，检查换行后右侧框线是否完整。" }], isError: false }, false);
  return tool;
}

function assertClearScrollbar(component: Component, width: number): void {
  const height = Math.max(5, component.render(width).length + 1);
  const document = new Container();
  document.addChild(component);
  document.addChild(new Spacer(20));
  const scroll = new ScrollView(document, { scrollbar: "auto" });
  const idle = renderLayoutFrame(scroll, width, height, () => {});
  scroll.setScrollbarActive(true);
  try {
    const active = renderLayoutFrame(scroll, width, height, () => {});
    assert.equal(scroll.scrollbar, "auto", "the scrollbar still auto-hides");
    assert.equal(scroll.isScrollbarVisible, true);
    let borders = 0;
    for (const [row, line] of idle.lines.entries()) {
      const plain = stripTerminalSequences(line).trimEnd();
      const border = plain.at(-1);
      if (border !== "╮" && border !== "│" && border !== "╯") continue;
      borders++;
      const column = visibleWidth(plain) - 1;
      assert.equal(column, width - 2, "the frame leaves the final column for the overlay");
      assert.equal(stripTerminalSequences(sliceByColumn(active.lines[row], column, 1)), border);
      assert.ok(visibleWidth(active.lines[row]) <= width);
    }
    assert.ok(borders >= 3, "top, body and bottom borders were checked");
  } finally {
    scroll.setScrollbar("hidden");
  }
}

const summary = { tokensBefore: 1234, summary: "A summary." };
for (const [name, create] of [
  ["tool", bashBox],
  ["compaction", () => new CompactionSummaryMessageComponent(summary as any)],
  ["branch", () => new BranchSummaryMessageComponent(summary as any)],
  ["skill", () => new SkillInvocationMessageComponent({ name: "demo", location: "demo/SKILL.md", content: "Skill content.", userMessage: undefined })],
  ["custom message", () => new CustomMessageComponent({ customType: "notice", content: "Notice content." } as any)],
  ["opt-in user message", () => new UserMessageComponent("A user message.")],
] as const) {
  test(`${name} frame stays intact under the auto scrollbar and after resize`, () => {
    const component = create();
    for (const width of [24, 90, 24]) assertClearScrollbar(component, width);
  });
}

test("an expanded thinking frame stays clear of the auto scrollbar", () => {
  patchToolBoxFrames({ icons: false, groupTools: true });
  try {
    const message = new AssistantMessageComponent({
      role: "assistant", content: [{ type: "thinking", thinking: "Checking the layout." }], stopReason: "stop",
    } as any, true);
    message.render(90);
    assert.ok(message.handleMouse({
      type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0,
      width: 90, height: 10, shift: false, alt: false, ctrl: false,
    }));
    for (const width of [24, 90, 24]) assertClearScrollbar(message, width);
  } finally {
    patchToolBoxFrames({ icons: false, groupTools: false });
  }
});
