/**
 * A pi build whose ToolExecutionComponent lacks the private methods tidy reads
 * to find a box's body (Pi-Bolt 1.3 keeps one `shell` field instead, #93).
 * Render already fell back to pi's box when they were missing; the mouse threw
 * from inside pi's input handler and took the session down with it.
 *
 * Its own file: the build is simulated on ToolExecutionComponent's prototype,
 * which every other test shares.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

initTheme("dark");

// The build's own mouse handling, which tidy hands the event to when it can't place it.
const proto = ToolExecutionComponent.prototype as any;
const seen: unknown[] = [];
proto.handleMouse = function (event: unknown) {
  seen.push(event);
  return { handled: true };
};

const { patchToolBoxFrames, toolBodyInternalsAvailable } = await import("../src/tools/tool-frame.ts");
patchToolBoxFrames({ icons: true, groupTools: false });

const W = 100;
const cwd = process.cwd();

function bashBox(): any {
  const c = new ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, createBashToolDefinition(cwd) as any, { requestRender() {} } as any, cwd);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false, durationMs: 5 } as any, false);
  c.setExpanded(true);
  return c;
}

function mouse(type: "move" | "click", y: number): any {
  return { type, button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: 10, shift: false, alt: false, ctrl: false };
}

test("pi's own build has the methods", () => {
  assert.equal(toolBodyInternalsAvailable(), true);
});

test("without them, a pointer over a box goes to pi instead of throwing", () => {
  const box = bashBox();
  const host = new Container();
  host.addChild(box);
  const rows = host.render(W);
  assert.ok(rows.length > 2, "the box drew before the methods went away");

  // The build: the methods are gone from this box.
  box.hasRendererDefinition = undefined;
  box.getRenderShell = undefined;
  assert.equal(toolBodyInternalsAvailable(box), false);

  seen.length = 0;
  for (let y = 0; y < rows.length; y++) {
    assert.doesNotThrow(() => host.handleMouse(mouse("move", y)), `move on row ${y}`);
    assert.doesNotThrow(() => host.handleMouse(mouse("click", y)), `click on row ${y}`);
  }
  assert.ok(seen.length > 0, "the events reached pi's own handler");
});
