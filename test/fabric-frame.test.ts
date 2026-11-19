/**
 * A grouped `fabric_exec` end to end: pi's real ToolExecutionComponent, a tool
 * definition that draws its own card the way pi-fabric does, and clicks
 * dispatched through pi-tui's Container the way a terminal click arrives.
 *
 * fabric records the calls its program made (`details.audits`), and tidy reads
 * them through the same nested-calls protocol codemode goes through: the
 * summary hangs them on the call that ran them (`fabric_exec×1 (bash×1 edit×1)`),
 * and opening the call lists them, an edit's diff under its own row, with the
 * program and the output folded to one row each.
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

test("a program's calls hang on its entry, the way a codemode script's do", () => {
  resetGroups();
  const lines = frame(transcript());
  const line = lines.find((row) => row.includes("fabric_exec"))!;
  assert.ok(line, lines.join("\n"));
  assert.match(line, /\b1 call\b/, "the model made one call: " + line);
  assert.match(line, /fabric_exec×1 \(bash×1 edit×1 read×1\)/, line);
  assert.ok(!line.includes("load"), "fabric's own plumbing is not counted");
  assert.ok(!lines.join("\n").includes("world2"), "folded, nothing of the program hangs below");
});

test("an opened fabric_exec lists its calls, an edit's diff under its own row", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  assert.ok(body.includes("▸ script · 3 lines"), body);
  assert.ok(body.includes("▸ output · 1 line"), body);
  assert.ok(body.includes("echo hi"), `the call's own arguments:\n${body}`);
  assert.ok(!body.includes("await pi.bash"), "the program is folded away");
  assert.ok(!body.includes("three calls, all good"), "the output is folded away");
  assert.ok(!body.includes("> load"), "fabric's card is not what these rows came from");
  const edit = lines.findIndex((line) => line.includes("✓ edit") && line.includes("/tmp/a.ts"));
  const diff = lines.findIndex((line) => line.includes("world2"));
  assert.ok(edit >= 0 && diff > edit, `the diff hangs under the edit's row:\n${body}`);
  assert.ok(!lines.slice(diff).some((line) => line.startsWith("╭─")), "no box of its own below the list");
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

test("with grouping off, the list sits in a frame of its own", () => {
  patchToolBoxFrames({ icons: false, groupTools: false });
  try {
    const chat = new Container();
    const call = fabric();
    chat.addChild(call.component);
    const lines = frame(chat);
    const body = lines.join("\n");
    assert.match(lines[0]!, /^╭─ ✓ fabric_exec\s+bash×1 edit×1 read×1\s+0\.4s ─+╮$/, body);
    assert.ok(body.includes("▸ script · 3 lines"), body);
    assert.ok(body.includes("echo hi"), body);
    assert.ok(body.includes("world2"), "the diff is in the list:\n" + body);
    assert.equal(lines.filter((line) => line.startsWith("╭─")).length, 1, "one box:\n" + body);

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

test("a failure inside the program reads in the folded group, and under its row when open", () => {
  resetGroups();
  const failed = [
    { ref: "pi.bash", tool: "bash", provider: "pi", success: false, error: "no such file", args: { command: "cat /nope" }, startedAt: 1, endedAt: 2 },
    { ref: "pi.edit", tool: "edit", provider: "pi", success: false, error: "oldText not found", args: { path: "/tmp/a.ts" }, startedAt: 2, endedAt: 3 },
  ];
  const chat = transcript({ audits: failed, text: "failed" });
  const folded = frame(chat).join("\n");
  assert.match(folded, /2 nested failed/, "a fold never hides a failure:\n" + folded);
  openBox(chat);
  const lines = frame(chat);
  const body = lines.join("\n");
  const bash = lines.findIndex((line) => line.includes("cat /nope"));
  assert.ok(bash >= 0 && lines[bash + 1]!.includes("no such file"), body);
  const edit = lines.findIndex((line) => line.includes("✗ edit"));
  assert.ok(edit >= 0 && lines[edit + 1]!.includes("oldText not found"), body);
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
  const chat = transcript({ audits: big, text: "done" });
  openBox(chat);
  const body = frame(chat).join("\n");
  assert.match(body, /\(\d+ more lines, \d+ total\)/, body);
  // A nested diff opens no further: a keybinding that does nothing is worse than none.
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

test("a nested diff keeps its tint inside the list", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  const rows = chat.render(W);
  assert.ok(tint(rows) > 0, "the changed rows keep their fill:\n" + rows.map(strip).join("\n"));
});

test("a settled list comes from the cache, not a rebuild", () => {
  resetGroups();
  const chat = transcript();
  openBox(chat);
  frame(chat);
  const before = (chat as any).children?.[1]?.__nestedComposed?.value;
  assert.ok(before, "the call cached its composed list");
  chat.render(W);
  chat.render(W);
  assert.equal((chat as any).children?.[1]?.__nestedComposed?.value, before, "the same value: a settled list costs one key check");
});

test("a progress tick keeps the sections the reader opened", () => {
  resetGroups();
  const chat = new Container();
  const call = fabric();
  chat.addChild(call.component);
  patchToolBoxFrames({ icons: false, groupTools: false });
  try {
    click(chat, "▸ script");
    assert.ok(frame(chat).join("\n").includes("await pi.bash"));
    // fabric re-creates the details object on every tick.
    (call.component as any).updateResult(
      { content: [{ type: "text", text: "more" }], isError: false, durationMs: 500, details: details() } as any,
      false,
    );
    assert.ok(frame(chat).join("\n").includes("await pi.bash"), "the script stays open across the tick");
  } finally {
    patchToolBoxFrames({ icons: false, groupTools: true });
    resetGroups();
  }
});
