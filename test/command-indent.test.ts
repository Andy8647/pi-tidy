/**
 * A command's own lines hang under its first word.
 *
 * pi draws a shell command as one `Text`, so line two of a script used to start
 * at the frame's edge: `cd ../project && python3 -c "` and the twelve lines it
 * runs shared one left margin, and the script read as the box's content. The
 * column differs by where the row is drawn (after `$ ` in a box of its own, after
 * the icon and the name under a group row), so the two are tested apart.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { CommandText, type CommandIndent } from "../src/tools/command-text.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import tidy from "../src/index.ts";
import { harness, loadTidy } from "./renderer-harness.ts";

initTheme("dark");

/** Escape-aware, but it keeps every space: the column is the assertion. */
const plain = (text: string) =>
  text.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "");

const rows = (text: CommandText, width = 40) => text.render(width).map((row) => plain(row).trimEnd());

test("a box of its own hangs the command's lines on `$ `", () => {
  const text = new CommandText({});
  text.setText("$ cd src\nmake test");
  assert.deepEqual(rows(text), ["$ cd src", "  make test"]);
});

test("a group's column wins over the prompt's", () => {
  const state: CommandIndent = {};
  const text = new CommandText(state);
  text.setText("$ cd src\nmake test");
  state.tidyCommandIndent = 8;
  const drawn = rows(text);
  assert.equal(drawn[0], "$ cd src", "the command row keeps the frame's edge");
  assert.equal(drawn[1], "        make test");
});

test("a narrow frame gives the column away instead of squeezing the text out", () => {
  const text = new CommandText({ tidyCommandIndent: 30 });
  text.setText(`$ ${"x".repeat(120)}`);
  for (const row of text.render(20)) assert.ok(visibleWidth(row) <= 20, `row is wider than the frame: ${row}`);
});

test("a wide column still leaves the frame room for its text", () => {
  const text = new CommandText({ tidyCommandIndent: 36 });
  text.setText("$ a\nb");
  for (const row of text.render(40)) assert.ok(visibleWidth(row) <= 40);
  assert.equal(rows(text).length, 2, "one row each: the column did not wrap the text");
});

// ─────────────────────────────────────────────────────────────────────────────
// The group path: the row above carries the command, and the body hangs under
// the same column rather than at the rail.
// ─────────────────────────────────────────────────────────────────────────────

const W = 100;
patchToolBoxFrames({ icons: false, groupTools: true });

let renders = 0;
const ui = { requestRender: () => renders++ };
const cwd = process.cwd();
const h = harness();
loadTidy(tidy, h.pi, { highlightBash: true });
const bashDefinition = () => createBashToolDefinition(cwd) as unknown as Record<string, unknown>;
const definition = { ...bashDefinition(), ...h.resolve("bash", bashDefinition() as any)! };

const COMMAND = `cd ../project && python3 -c "\nimport pathlib\np = pathlib.Path('x')\nprint('ok')\n"`;

/** Render until pi stops asking for another frame, keeping every space. */
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders;
    lines = chat.render(W).map((line) => plain(line).trimEnd());
    if (renders === before) break;
  }
  return lines;
}

function click(chat: Container, needle: string): void {
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false } as any);
}

function scene() {
  resetGroups();
  const chat = new Container();
  const call = { type: "toolCall", id: "call-indent", name: "bash", arguments: {} };
  const component = new ToolExecutionComponent("bash", "call-indent", { command: COMMAND }, {}, definition as any, ui as any, cwd);
  component.setExpanded(false);
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(
    { content: [{ type: "text", text: "ok\n7:      Tests  835 passed (835)" }], isError: false, durationMs: 11_900 } as any,
    false,
  );
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Checking." }, call], stopReason: "toolUse" } as any));
  chat.addChild(component);
  return chat;
}

test("under a group row the whole body starts where the command does", () => {
  const chat = scene();
  click(chat, "1 call");
  click(chat, "python3 -c");
  const lines = frame(chat);
  const openRow = lines.find((line) => line.includes("python3 -c") && !line.includes("import"));
  const body = lines.find((line) => line.includes("import pathlib"));
  assert.ok(openRow, `the open row is missing:\n${lines.join("\n")}`);
  assert.ok(body, `the body is missing:\n${lines.join("\n")}`);
  assert.equal(body.indexOf("import"), openRow.indexOf("cd"), `columns differ:\n${lines.join("\n")}`);
  // The output is the call's result, but it hangs under the command it came from.
  const output = lines.find((line) => line.includes("Tests"));
  assert.ok(output, `the output is missing:\n${lines.join("\n")}`);
  assert.equal(output.indexOf("7:"), openRow.indexOf("cd"), `output is not on the command's column:\n${lines.join("\n")}`);
});

test("a box that is shown on its own hangs its lines on `$ `", () => {
  // A tool that never folds into a group draws a frame of its own.
  patchToolBoxFrames({ icons: false, groupTools: true, alwaysShowTools: ["bash"] });
  try {
    const chat = scene();
    click(chat, "python3 -c");
    const lines = frame(chat);
    const command = lines.find((line) => line.includes("$ …/project") || line.includes("$ cd"));
    const body = lines.find((line) => line.includes("import pathlib"));
    assert.ok(command, `the command row is missing:\n${lines.join("\n")}`);
    assert.ok(body, `the body is missing:\n${lines.join("\n")}`);
    assert.equal(body.indexOf("import"), command.indexOf("cd"), `columns differ:\n${lines.join("\n")}`);
  } finally {
    patchToolBoxFrames({ icons: false, groupTools: true });
  }
});
