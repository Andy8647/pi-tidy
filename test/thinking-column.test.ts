/**
 * An opened thinking run inside a group hangs its text on the row's own text
 * column, the way an opened call's body hangs on its command: the row above and
 * the reasoning under it share one left edge. Real pi components throughout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { tidyEnabled } from "../src/live.ts";

initTheme("dark");
const ui = { requestRender: () => {} };
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();

const THOUGHT = "The listing shows three files. I should read the config next, then check whether the loader handles a missing key.\n\n- first, the loader\n- then the tests";

function tool(name: string, id: string, args: unknown) {
  const c = new ToolExecutionComponent(name, id, args, {}, undefined, ui as any, process.cwd());
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 300 } as any, false);
  return c;
}

function transcript() {
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Go." }, { type: "toolCall", id: "b1", name: "bash", arguments: {} }], stopReason: "toolUse" } as any));
  chat.addChild(tool("bash", "b1", { command: "ls" }));
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: THOUGHT }, { type: "toolCall", id: "r1", name: "read", arguments: {} }], stopReason: "toolUse" } as any));
  chat.addChild(tool("read", "r1", { path: "/tmp/config.ts" }));
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as any));
  return chat;
}

function opened(icons: boolean, width: number): { rows: string[]; raw: string[] } {
  patchToolBoxFrames({ icons, groupTools: true });
  tidyEnabled.set(true);
  resetGroups();
  const chat = transcript();
  const frame = () => {
    let lines: string[] = [];
    for (let i = 0; i < 3; i++) lines = chat.render(width);
    return lines;
  };
  const click = (pattern: RegExp, needle: string) => {
    const lines = frame().map(strip);
    const y = lines.findIndex((line) => pattern.test(line));
    assert.ok(y >= 0, `no row for ${pattern}:\n${lines.join("\n")}`);
    const x = lines[y]!.indexOf(needle);
    chat.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: lines.length, shift: false, alt: false, ctrl: false } as any);
  };
  click(/calls/, "calls");
  click(/thinking/, "thinking");
  const raw = frame();
  return { rows: raw.map(strip), raw };
}

for (const icons of [false, true]) {
  test(`an opened thought's text starts where its row's text does, icons ${icons ? "on" : "off"}`, () => {
    const { rows } = opened(icons, 100);
    const row = rows.findIndex((line) => line.includes("thinking") && line.includes("The listing"));
    assert.ok(row >= 0, rows.join("\n"));
    // Cells, not string indices: a Nerd Font glyph is two UTF-16 units and one cell.
    const cellOf = (line: string, needle: string) => visibleWidth(line.slice(0, line.indexOf(needle)));
    const column = cellOf(rows[row]!, "The listing");
    const body = rows.findIndex((line, i) => i > row && line.includes("The listing"));
    assert.ok(body > row, rows.join("\n"));
    assert.equal(cellOf(rows[body]!, "The listing"), column, rows.join("\n"));
    // A list item keeps the bullet it was drawn with, on the same edge.
    const item = rows.find((line, i) => i > row && line.includes("first, the loader"))!;
    assert.equal(cellOf(item, "-"), column, item);
  });
}

test("an opened thought stays inside the width, however narrow", () => {
  for (const width of [40, 60, 100]) {
    const { raw } = opened(true, width);
    for (const line of raw) assert.ok(visibleWidth(line) <= width, `${width}: ${strip(line)}`);
  }
});
