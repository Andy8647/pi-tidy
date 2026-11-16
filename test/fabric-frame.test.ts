/**
 * A grouped `fabric_exec` end to end: pi's real ToolExecutionComponent, a tool
 * definition that draws its own card the way pi-fabric does, and clicks
 * dispatched through pi-tui's Container the way a terminal click arrives.
 *
 * fabric draws its calls itself, so tidy builds these rows from the record the
 * result carries (`details.audits`) instead of from anything it rendered: the
 * program and the output fold to one row each, every call gets a row, and a
 * nested `edit` keeps the diff it wrote under its own row.
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
  click(chat, "1 call");
  // The header names the tool too (`fabric_exec×1`), so the row is the one that
  // carries its outcome glyph.
  clickRow(chat, (line) => line.includes("fabric_exec") && line.includes("✓"), "fabric_exec");
}

test("a folded fabric_exec says what the program ran, not its first line", () => {
  resetGroups();
  const lines = frame(transcript());
  const line = lines.find((row) => row.includes("fabric_exec"))!;
  assert.ok(line, lines.join("\n"));
  assert.ok(line.includes("(bash×1 edit×1 read×1)"), line);
  assert.ok(!line.includes("await pi.bash"), "the program is not the row's argument");
  assert.ok(!line.includes("load"), "fabric's own plumbing is not counted");
});

test("an opened fabric_exec is its call list, with the program and the output folded", () => {
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
});

test("a nested edit keeps the diff it wrote under its own row", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  const row = lines.findIndex((line) => line.includes("edit ") && line.includes("/tmp/a.ts"));
  assert.ok(row >= 0, body);
  const under = lines.slice(row + 1, row + 6).join("\n");
  assert.ok(under.includes("↳ diff"), `the diff hangs under the row:\n${body}`);
  assert.ok(under.includes("world2"), `and carries what it wrote:\n${body}`);
  assert.ok(!body.includes("+2 world2"), "the panes, not the raw unified diff");
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

test("with grouping off, the same list sits in a frame of its own", () => {
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
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  const row = lines.findIndex((line) => line.includes("cat /nope"));
  assert.ok(row >= 0, body);
  assert.ok(lines[row + 1]!.includes("no such file"), body);
});
