/**
 * A grouped `fabric_exec` end to end: pi's real ToolExecutionComponent, a tool
 * definition that draws its own card the way pi-fabric does, and clicks
 * dispatched through pi-tui's Container the way a terminal click arrives.
 *
 * fabric records the calls its program made (`details.audits`), and tidy reads
 * them as calls of the run: the summary counts them beside the model's own
 * (`fabric_exec×1 bash×1 edit×1`, no parentheses), an edit or write the program
 * made draws as a box of its own below — folded or open, the change stays
 * visible — and opening the wrapper lists the rest, with the program and the
 * output folded to one row each.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { tidyEnabled } from "../src/live.ts";

initTheme("dark");
patchToolBoxFrames({ icons: false, groupTools: true });
tidyEnabled.set(true);

const W = 100;
const renders = { count: 0 };
const ui = { requestRender: () => renders.count++ };

/** pi-fabric's renderers, reduced to what a test needs: a card, not a call list. */
const fabricDef = {
  name: "fabric_exec",
  renderCall(args: any) {
    return new Text(["fabric", ...String(args?.code ?? "").split("\n")].join("\n"), 0, 0);
  },
  renderResult(result: any) {
    const audits = result.details?.audits ?? [];
    return new Text(audits.map((audit: any) => `> ${audit.tool}`).join("\n"), 0, 0);
  },
};

const CODE = 'const out = await pi.bash({ command: "echo hi" });\nawait pi.read("/tmp/a.ts");\nawait pi.edit("/tmp/a.ts");';

const AUDITS = [
  {
    ref: "native.load",
    tool: "load",
    provider: "fabric",
    success: true,
    args: {},
    result: { ok: true },
    startedAt: 1,
    endedAt: 2,
  },
  {
    ref: "pi.bash",
    tool: "bash",
    provider: "pi",
    success: true,
    args: { command: "echo hi" },
    result: { ok: true, output: "hi" },
    startedAt: 10,
    endedAt: 213,
  },
  {
    ref: "pi.read",
    tool: "read",
    provider: "pi",
    success: true,
    args: { path: "/tmp/a.ts" },
    result: { ok: true, output: "a\nb" },
    startedAt: 213,
    endedAt: 214,
  },
  {
    ref: "pi.edit",
    tool: "edit",
    provider: "pi",
    success: true,
    args: { path: "/tmp/a.ts", edits: [{ oldText: "world", newText: "world2" }] },
    result: { ok: true, output: "replaced", details: { diff: " 1 hello\n-2 world\n+2 world2" } },
    startedAt: 214,
    endedAt: 400,
  },
];

function details(audits = AUDITS, extra: Record<string, unknown> = {}) {
  return { success: true, kernel: "typescript", phases: [], audits, ...extra };
}

let nextId = 0;

function fabric(result: { text?: string; audits?: any[]; extra?: Record<string, unknown> } = {}) {
  const id = `fabric-${++nextId}`;
  const component = new ToolExecutionComponent(
    "fabric_exec",
    id,
    { code: CODE },
    {},
    fabricDef as any,
    ui as any,
    process.cwd(),
  );
  component.setExpanded(false);
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(
    {
      content: [{ type: "text", text: result.text ?? "three calls, all good" }],
      isError: false,
      durationMs: 400,
      details: details(result.audits, result.extra),
    } as any,
    false,
  );
  return { id, component };
}

function transcript(result: Parameters<typeof fabric>[0] = {}) {
  const chat = new Container();
  const call = fabric(result);
  const step = new AssistantMessageComponent({
    role: "assistant",
    content: [{ type: "text", text: "Running." }, { type: "toolCall", id: call.id, name: "fabric_exec", arguments: {} }],
    stopReason: "toolUse",
  } as any);
  chat.addChild(step);
  chat.addChild(call.component);
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as any));
  return chat;
}

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "").trimEnd();

function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders.count;
    lines = chat.render(W);
    if (renders.count === before) break;
  }
  return lines.map(strip);
}

function clickRow(chat: Container, match: (line: string) => boolean, needle: string): unknown {
  const lines = frame(chat);
  const row = lines.findIndex(match);
  assert.ok(row >= 0, `no row for ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  const x = lines[row]!.indexOf(needle);
  return chat.handleMouse({
    type: "click",
    button: "left",
    x,
    y: row,
    screenX: x,
    screenY: row,
    width: W,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  } as any);
}

const click = (chat: Container, needle: string) => clickRow(chat, (line) => line.includes(needle), needle);

/** The header opens the group; the call row under it opens the box. */
function openBox(chat: Container) {
  clickRow(chat, (line) => /\d+ calls?/.test(line), "calls");
  // The header names the tool too (`fabric_exec×1`), so the row is the one that
  // carries its outcome glyph.
  clickRow(chat, (line) => line.includes("fabric_exec") && line.includes("✓"), "fabric_exec");
}

test("a program's calls join the run's counts, beside the model's own", () => {
  resetGroups();
  const lines = frame(transcript());
  const line = lines.find((row) => row.includes("fabric_exec"))!;
  assert.ok(line, lines.join("\n"));
  assert.match(line, /4 calls/, line);
  assert.match(line, /bash×1/, line);
  assert.match(line, /edit×1/, line);
  assert.match(line, /read×1/, line);
  assert.match(line, /fabric_exec×1/, line);
  assert.ok(!line.includes("("), "no nested list on the entry: " + line);
  assert.ok(!line.includes("await pi.bash"), "the program is not the row's argument");
  assert.ok(!line.includes("load"), "fabric's own plumbing is not counted");
});

test("an edit the program made draws as a box of its own, while the group is folded", () => {
  resetGroups();
  const lines = frame(transcript());
  const body = lines.join("\n");
  const title = lines.find((line) => line.startsWith("╭─") && line.includes("edit") && line.includes("/tmp/a.ts"));
  assert.ok(title, "the edit has a box of its own:\n" + body);
  assert.ok(body.includes("world2"), "the change is visible without opening anything:\n" + body);
  assert.ok(body.includes("↳ diff"), body);
});

test("an opened fabric_exec lists its calls, with the program and the output folded", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  assert.ok(body.includes("▸ script · 3 lines"), body);
  assert.ok(body.includes("▸ output · 1 line"), body);
  assert.ok(body.includes("echo hi"), `the call's own arguments:\n${body}`);
  assert.ok(body.includes("/tmp/a.ts"), body);
  assert.ok(!body.includes("await pi.bash"), "the program is folded away");
  assert.ok(!body.includes("three calls, all good"), "the output is folded away");
  assert.ok(!body.includes("> load"), "fabric's card is not what these rows came from");
  // The edit's diff draws once, in its own box — not again inside the list.
  assert.equal(body.split("↳ diff").length - 1, 1, body);
});

test("the fold rows open the program and the output in place", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  click(chat, "▸ script");
  const script = frame(chat).join("\n");
  assert.ok(script.includes("▾ script · 3 lines"), script);
  assert.ok(script.includes("await pi.bash"), script);

  click(chat, "▸ output");
  const output = frame(chat).join("\n");
  assert.ok(output.includes("▾ output · 1 line"), output);
  assert.ok(output.includes("three calls, all good"), output);
  assert.ok(output.includes("await pi.bash"), "the program stays open");
});

test("with grouping off, the list sits in a frame and the edit below it", () => {
  patchToolBoxFrames({ icons: false, groupTools: false });
  try {
    const chat = new Container();
    const call = fabric();
    chat.addChild(call.component);
    const lines = frame(chat);
    const body = lines.join("\n");
    assert.match(lines[0]!, /^╭─ ✓ fabric_exec\s+bash×1 edit×1 read×1\s+0\.4s ─+╮$/, body);
    assert.ok(body.includes("▸ script · 3 lines"), body);
    assert.ok(body.includes("▸ output · 1 line"), body);
    assert.ok(body.includes("echo hi"), body);
    assert.ok(!body.includes("> load"), "the card is not what these rows came from");
    const editBox = lines.find((line) => line.startsWith("╭─") && line.includes("edit") && line.includes("/tmp/a.ts"));
    assert.ok(editBox, "the edit's own box follows:\n" + body);

    // The fold rows are the framed body's own rows, one deeper than the border.
    click(chat, "▸ script");
    const opened = frame(chat).join("\n");
    assert.ok(opened.includes("▾ script · 3 lines"), opened);
    assert.ok(opened.includes("await pi.bash"), opened);
  } finally {
    patchToolBoxFrames({ icons: false, groupTools: true });
    resetGroups();
  }
});

test("a failed call keeps its error under its row, in red", () => {
  resetGroups();
  const failed = [
    { ref: "pi.bash", tool: "bash", provider: "pi", success: false, error: "no such file", args: { command: "cat /nope" }, startedAt: 1, endedAt: 2 },
  ];
  const chat = transcript({ audits: failed, text: "failed" });
  const folded = frame(chat).join("\n");
  assert.match(folded, /1 failed/, folded);
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  const row = lines.findIndex((line) => line.includes("cat /nope"));
  assert.ok(row >= 0, body);
  assert.ok(lines[row + 1]!.includes("no such file"), body);
});

test("a failed edit's box carries its error, in red", () => {
  resetGroups();
  const failed = [
    { ref: "pi.edit", tool: "edit", provider: "pi", success: false, error: "oldText not found", args: { path: "/tmp/a.ts" }, startedAt: 1, endedAt: 2 },
  ];
  const lines = frame(transcript({ audits: failed, text: "failed" }));
  const body = lines.join("\n");
  const at = lines.findIndex((line) => line.startsWith("╭─") && line.includes("edit"));
  assert.ok(at >= 0, body);
  assert.ok(lines.slice(at, at + 4).join("\n").includes("oldText not found"), body);
});

test("a write the program made draws its content as a box of its own", () => {
  resetGroups();
  const wrote = [
    { ref: "pi.write", tool: "write", provider: "pi", success: true, args: { path: "/tmp/n.ts", content: "hello\nworld\n" }, result: { ok: true, output: "wrote" }, startedAt: 1, endedAt: 2 },
  ];
  const lines = frame(transcript({ audits: wrote, text: "done" }));
  const body = lines.join("\n");
  const at = lines.findIndex((line) => line.startsWith("╭─") && line.includes("write") && line.includes("/tmp/n.ts"));
  assert.ok(at >= 0, body);
  assert.ok(lines.slice(at, at + 5).join("\n").includes("hello"), body);
  assert.ok(lines.slice(at, at + 5).join("\n").includes("world"), body);
});

test("a long diff keeps to the diff rows, and says how many it left", () => {
  resetGroups();
  const lines = Array.from({ length: 40 }, (_, i) => `+${i + 2} added ${i}`);
  const big = [
    {
      ref: "pi.edit",
      tool: "edit",
      provider: "pi",
      success: true,
      args: { path: "/tmp/a.ts" },
      result: { ok: true, output: "ok", details: { diff: ` 1 head\n-${2} gone\n${lines.join("\n")}` } },
      startedAt: 1,
      endedAt: 2,
    },
  ];
  const body = frame(transcript({ audits: big, text: "done" })).join("\n");
  assert.match(body, /\(\d+ more lines, \d+ total\)/, body);
  // Nothing here can open the rest, so no keybinding is promised.
  assert.ok(!body.includes("to expand"), body);
});

test("a call's own output keeps a row and counts the rest", () => {
  resetGroups();
  const noisy = [
    {
      ref: "pi.bash",
      tool: "bash",
      provider: "pi",
      success: true,
      args: { command: "list" },
      result: { ok: true, output: "alpha\nbravo\ncharlie\ndelta\necho\n" },
      startedAt: 1,
      endedAt: 2,
    },
  ];
  const chat = transcript({ audits: noisy, text: "done" });
  openBox(chat);
  const body = frame(chat).join("\n");
  assert.ok(body.includes("list"), body);
  assert.ok(body.includes("alpha"), "the first row is kept");
  assert.ok(!body.includes("bravo"), "the tail is not");
  assert.ok(body.includes("4 more lines"), body);
});

test("calls fabric dropped from the record are counted without its own plumbing", () => {
  resetGroups();
  const chat = transcript({ audits: [], text: "done", extra: { omittedCalls: { count: 7, done: 7, failed: 0, internal: 3 } } });
  openBox(chat);
  const body = frame(chat).join("\n");
  assert.ok(body.includes("… 4 more calls"), body);
});

/** Count the background fills a frame keeps: the split diff's tinted rows. */
const tint = (rows: readonly string[]) => rows.reduce((n, row) => n + (row.match(/\x1b\[48;[0-9;]*m/g) ?? []).length, 0);

test("the promoted edit's box keeps the tint of its diff", () => {
  resetGroups();
  const chat = transcript();
  const rows = chat.render(W);
  assert.ok(tint(rows) > 0, "the changed rows keep their fill:\n" + rows.map(strip).join("\n"));
});

test("a settled promoted box comes from the cache, not a rebuild", () => {
  resetGroups();
  const chat = transcript();
  chat.render(W); // settle
  const before = (chat as any).children?.[1]?.__promotedBoxes?.rows;
  assert.ok(before, "the wrapper cached its promoted rows");
  chat.render(W);
  chat.render(W);
  const after = (chat as any).children?.[1]?.__promotedBoxes?.rows;
  assert.equal(after, before, "the same array: a settled box costs one key check");
});

test("clicking a promoted box does not fold the wrapper it belongs to", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const lines = frame(chat);
  const at = lines.findIndex((line) => line.startsWith("╭─") && line.includes("edit"));
  assert.ok(at >= 0, lines.join("\n"));
  chat.handleMouse({ type: "click", button: "left", x: 10, y: at + 2, screenX: 10, screenY: at + 2, width: W, height: lines.length } as any);
  const after = frame(chat).join("\n");
  assert.ok(after.includes("▸ script"), "the wrapper's list stays open:\n" + after);
});

test("on an open turn's rail, the promoted box hangs on the rail too", async () => {
  const { TurnStore, turnOptions, turnStore, expandTurnForTool } = await import("../src/turns/turn-state.ts");
  const { UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
  resetGroups();
  turnOptions.set({ ...turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: false });
  try {
    const store = new TurnStore();
    turnStore.set(store);
    store.begin(1000);
    const user = { role: "user", timestamp: 1000, content: "go" } as any;
    const call = fabric();
    const step = { role: "assistant", timestamp: 1100, provider: "p", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: call.id, name: "fabric_exec", arguments: {} }] } as any;
    const result = { role: "toolResult", toolCallId: call.id, toolName: "fabric_exec", timestamp: 1200, isError: false, content: [{ type: "text", text: "out" }], details: details() } as any;
    const final = { role: "assistant", timestamp: 1300, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "done" }] } as any;
    const chat = new Container();
    chat.addChild(new UserMessageComponent("go"));
    chat.addChild(new AssistantMessageComponent(step, true));
    chat.addChild(call.component);
    chat.addChild(new AssistantMessageComponent(final, true));
    for (const m of [user, step, result, final]) store.note(m, true);
    store.settle(false, 1800);
    expandTurnForTool(call.id, true);
    let rows: string[] = [];
    for (let i = 0; i < 5; i++) rows = frame(chat);
    const at = rows.findIndex((line) => line.includes("╭─") && line.includes("edit"));
    assert.ok(at >= 0, rows.join("\n"));
    assert.ok(rows[at]!.startsWith("│"), "the box hangs on the turn's rail:\n" + rows.join("\n"));
    // Every row of the box, down to its bottom border.
    const end = rows.findIndex((line, i) => i > at && line.includes("╰"));
    for (let i = at; i <= end; i++) assert.ok(rows[i]!.startsWith("│"), rows[i]);
  } finally {
    turnOptions.set({ ...turnOptions.get(), collapseTurns: "off" });
    resetGroups();
  }
});
