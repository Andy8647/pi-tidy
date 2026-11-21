import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, createReadToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { setClipboardWriter } from "../src/clipboard.ts";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";
import { chipLabels } from "../src/turns/code-blocks.ts";

initTheme("dark");
const CHIP = chipLabels(true);
const W = 80;
const user = { role: "user", content: "show me", timestamp: 1000 } as const;
/** Two quotes, the second with no blank line between it and the text before it. */
const QUOTES = ["Before.", "", "> **Note:** the first", "> and its second line", "", "> A second quote"].join("\n");

function fixture(text: string, options: { style?: "frame" | "rail"; open?: boolean; width?: number } = {}) {
  const width = options.width ?? W;
  resetGroups();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: options.style ?? "rail",
    icons: true,
    codeBlocks: true,
  });
  const message: any = { role: "assistant", provider: "deepseek", model: "x", timestamp: 1100, durationMs: 10, stopReason: "stop", content: [{ type: "text", text }] };
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note(user as any);
  store.note(message);
  if (!options.open) store.settle(false, 1800);
  const answer = new AssistantMessageComponent(message, true);
  const chat = new Container();
  chat.addChild(new UserMessageComponent("show me"));
  chat.addChild(answer);
  let rows: string[] = [];
  for (let pass = 0; pass < 3; pass++) rows = chat.render(width);
  return { chat, answer, width, rows, plain: rows.map(visibleText) };
}

function click(chat: Container, x: number, y: number, width: number, height: number) {
  return chat.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });
}

async function clickChip(fx: ReturnType<typeof fixture>, row: number) {
  const x = fx.plain[row]!.indexOf(CHIP.copy);
  assert.ok(x >= 0, fx.plain[row]);
  click(fx.chat, x, row, fx.width, fx.plain.length);
  await new Promise((resolve) => setImmediate(resolve));
}

for (const style of ["rail", "frame"] as const) {
  test(`a quote's chip sits in front of its border (${style})`, () => {
    const fx = fixture(QUOTES, { style });
    const rows = fx.plain.map((line, y) => ({ line, y })).filter(({ line }) => line.includes(CHIP.copy));
    assert.equal(rows.length, 2, fx.plain.join("\n"));
    for (const { line } of rows) {
      const at = line.indexOf(CHIP.copy);
      const after = line.slice(at + CHIP.copy.length);
      assert.ok(after.startsWith("│ "), `the chip is the cell in front of the border: ${JSON.stringify(line)}`);
    }
    // Nothing moved: the quote's second row keeps the border in the column the chip left
    // free.
    const first = rows[0]!;
    assert.equal(fx.plain[first.y + 1]![first.line.indexOf(CHIP.copy) + 1], "│");
  });

  test(`the chip copies the quote's own markdown (${style})`, async () => {
    const written: string[] = [];
    setClipboardWriter(async (text) => { written.push(text); });
    try {
      const fx = fixture(QUOTES, { style });
      const rows = fx.plain.map((line, y) => ({ line, y })).filter(({ line }) => line.includes(CHIP.copy));
      await clickChip(fx, rows[0]!.y);
      assert.deepEqual(written, ["> **Note:** the first\n> and its second line"], "the source, `>`s and all");
      const after = fx.chat.render(fx.width).map(visibleText);
      assert.ok(after[rows[0]!.y]!.includes(CHIP.copied), after[rows[0]!.y]);
      await clickChip(fx, rows[1]!.y);
      assert.deepEqual(written.at(-1), "> A second quote");
    } finally {
      setClipboardWriter(undefined);
    }
  });

  test(`a click anywhere else on the quote is still pi's selection (${style})`, async () => {
    const written: string[] = [];
    setClipboardWriter(async (text) => { written.push(text); });
    try {
      const fx = fixture(QUOTES, { style });
      const y = fx.plain.findIndex((line) => line.includes(CHIP.copy));
      const x = fx.plain[y]!.indexOf(CHIP.copy);
      const onText = click(fx.chat, x + 4, y, fx.width, fx.plain.length);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(written, []);
      assert.notEqual(onText?.handled, true);
    } finally {
      setClipboardWriter(undefined);
    }
  });
}

test("a quote on an open run's rail keeps its chip, one cell past the line", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const cwd = process.cwd();
    const fx = fixture(QUOTES, { style: "rail", open: true });
    // The run is open: the reply hangs on its line, so the chip sits one cell further in.
    const chat = new Container();
    chat.addChild(new UserMessageComponent("show me"));
    const first: any = { role: "assistant", provider: "openai", model: "x", timestamp: 1100, durationMs: 50, stopReason: "toolUse", content: [
      { type: "text", text: "Checking." },
      { type: "toolCall", id: "a", name: "read", arguments: { path: `${cwd}/src/a.ts` } },
    ] };
    const final: any = { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", timestamp: 1500, durationMs: 40, stopReason: "stop", content: [{ type: "text", text: QUOTES }] };
    const store = new TurnStore();
    turnStore.set(store);
    store.begin(1000);
    store.note(user as any);
    store.note(first);
    store.toolStart("a", undefined);
    store.toolEnd("a", undefined);
    store.note(final);
    resetGroups();
    const head = new AssistantMessageComponent(first, true);
    chat.addChild(head);
    const tool = new ToolExecutionComponent("read", "a", first.content[1].arguments, {}, createReadToolDefinition(cwd) as any, { requestRender() {} } as any, cwd);
    tool.setExpanded(false);
    tool.setArgsComplete();
    tool.markExecutionStarted();
    tool.updateResult({ content: [{ type: "text", text: "x" }], isError: false, durationMs: 10 } as any);
    chat.addChild(tool);
    const answer = new AssistantMessageComponent(final, true);
    chat.addChild(answer);
    let rows: string[] = [];
    for (let pass = 0; pass < 3; pass++) rows = chat.render(W);
    const plain = rows.map(visibleText);
    const y = plain.findIndex((line) => line.includes(CHIP.copy));
    assert.ok(y >= 0, plain.join("\n"));
    assert.ok(plain[y]!.startsWith("│"), "the open run's line is still in front of the reply");
    const x = plain[y]!.indexOf(CHIP.copy);
    click(chat, x, y, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, ["> **Note:** the first\n> and its second line"]);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("a quote that opens on a fenced block keeps the block's chip and gets no second one", () => {
  const fx = fixture("> ```fish\n> set -l x 1\n> ```", { style: "frame" });
  const open = fx.plain.findIndex((line) => line.includes(" fish "));
  assert.ok(open >= 0, fx.plain.join("\n"));
  assert.equal(fx.plain[open]!.split(CHIP.copy).length - 1, 1, "one chip on the row");
});

test("a selection keeps the quote's gutter and leaves the chip behind", () => {
  const fx = fixture(QUOTES, { style: "rail" });
  const { rows } = cleanTranscriptRows(fx.rows, 0, fx.rows.length - 1);
  const text = rows.flatMap((row) => (row ? [row.text.trim()] : []));
  assert.ok(!text.some((line) => line.includes(CHIP.copy)), text.join("\n"));
  assert.ok(text.includes("│ Note: the first"), text.join("\n"));
});

test("the quote's chip lights up under the pointer", () => {
  enableHoverForTests();
  resetHover();
  try {
    const fx = fixture(QUOTES, { style: "rail" });
    const y = fx.plain.findIndex((line) => line.includes(CHIP.copy));
    const x = fx.plain[y]!.indexOf(CHIP.copy);
    const move = (cx: number, cy: number) => fx.chat.handleMouse({ type: "move", button: "none", x: cx, y: cy, screenX: cx, screenY: cy, width: W, height: fx.plain.length, shift: false, alt: false, ctrl: false });
    const lit = () => fx.chat.render(W).some((row) => row.includes(CHIP.copy) && /\x1b\[48;/.test(row));
    move(x, y);
    assert.ok(lit(), "the chip wears the selected background");
    move(x, y + 1);
    assert.ok(!lit(), "and gives it back when the pointer leaves");
  } finally {
    resetHover();
    disableHoverForTests();
  }
});
