/**
 * The hover path end to end, against the real `TuiAltScreen`: a motion packet
 * with no button held (`\x1b[<35;x;yM`, all-motion tracking) reaches a
 * component inside a ScrollView, lights the row under it, and the wrapper over
 * `handleMouseEvent` drops the band as soon as the pointer leaves.
 *
 * This is the assumption the feature rests on and it is pi's code, not ours:
 * `move` is dispatched with no press in progress, at the component's local
 * coordinates, and returns no result of its own — so the repaint has to come
 * from us.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
(globalThis as any)[THEME_KEY] = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => (color === "selectedBg" ? `[band]${text}[/band]` : text),
  bold: (text: string) => text,
};
const theme = (globalThis as any)[THEME_KEY];

const { enableHoverForTests, installHoverTracking, renderGroupedTool, resetHover, routeGroupedMouse } = await import(
  "../tool-group-view.ts"
);
const { noteBoundary, resetGroups } = await import("../tool-groups.ts");

/** The Terminal surface TuiAltScreen touches, minus anything real. */
function fakeTerminal(columns = 200, rows = 20) {
  const state: { input?: (data: string) => void } = {};
  return {
    state,
    columns,
    rows,
    kittyProtocolActive: false,
    isTTY: false,
    start(onInput: (data: string) => void) {
      state.input = onInput;
    },
    stop() {
      state.input = undefined;
    },
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    clearProgress() {},
  };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function groupedComponent(tool: any) {
  return {
    renders: 0,
    render(width: number) {
      this.renders += 1;
      return renderGroupedTool(tool, width, theme, { icons: false, pinned: false }, () => []) ?? [];
    },
    invalidate() {},
    handleMouse(event: any) {
      return routeGroupedMouse(
        tool,
        event,
        { pinned: false, asPointer: <T,>(fn: () => T) => fn(), boxMouse: () => undefined },
      ) as any;
    },
  };
}

test("a motion packet lights the row under it, and leaving drops the band", async () => {
  resetGroups();
  resetHover();
  enableHoverForTests();
  installHoverTracking();
  noteBoundary({});

  const tool: any = {
    toolName: "bash",
    toolCallId: "call-1",
    args: { command: "pnpm test" },
    isPartial: false,
    expanded: false,
    result: { isError: false, durationMs: 100, content: [] },
    setExpanded(next: boolean) {
      tool.expanded = next;
    },
  };
  const grouped = groupedComponent(tool);
  tool.ui = { requestRender: () => grouped.render(200) };
  const plain = { render: () => ["a message row"], invalidate: () => {} };

  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal as any);
  // The tool sits above a plain component, so a pointer moving onto the plain
  // one is "left our rows" — exactly the case the wrapper has to catch.
  tui.addChild(
    new ScrollView(
      {
        render: (width: number) => [...grouped.render(width), ...plain.render()],
        invalidate() {},
        handleMouse(event: any) {
          if (event.y === 0 && event.type === "move") return grouped.handleMouse(event);
          return undefined;
        },
      } as any,
      {} as any,
    ) as any,
  );
  tui.start();
  await tick();

  const send = (seq: string) => terminal.state.input?.(seq);
  send("\x1b[<35;3;1M"); // motion, no button, row 1 → the tool's summary line
  await tick();
  assert.match(grouped.render(200)[0]!, /\[band\]/, "the row under the pointer is lit");

  send("\x1b[<35;3;2M"); // row 2 → the plain component below it
  await tick();
  assert.doesNotMatch(grouped.render(200)[0]!, /\[band\]/, "the band is dropped");

  tui.stop();
});
