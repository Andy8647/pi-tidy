import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { setClipboardWriter } from "../src/clipboard.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../src/hover.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";
import { codeBlocksAvailable } from "../src/turns/turn-view.ts";

initTheme("dark");
const W = 100;
const FISH = ["set -l x 1", "if test -n \"$x\"", "  echo \"hi\" # note", "end"].join("\n");
const DIFF = ["-const a = 1;", "+const a = 2;", " const b = 3;"].join("\n");
const user = { role: "user", content: "show me", timestamp: 1000 } as const;

interface FixtureOptions {
  width?: number;
  codeBlocks?: boolean;
  splitDiff?: boolean;
  replyStyle?: "frame" | "rail" | "rules";
}

function fixture(text: string, options: FixtureOptions = {}) {
  const width = options.width ?? W;
  resetGroups();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: options.replyStyle ?? "frame",
    icons: true,
    codeBlocks: options.codeBlocks ?? true,
    splitDiff: options.splitDiff ?? true,
    splitDiffMinWidth: 72,
  });
  const message: any = { role: "assistant", provider: "deepseek", model: "x", timestamp: 1100, durationMs: 10, stopReason: "stop", content: [{ type: "text", text }] };
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note(user as any);
  store.note(message);
  store.settle(false, 1800);
  const answer = new AssistantMessageComponent(message, true);
  const chat = new Container();
  chat.addChild(answer);
  let rows: string[] = [];
  for (let pass = 0; pass < 3; pass++) rows = chat.render(width);
  return { chat, answer, width, rows, plain: rows.map(visibleText) };
}

/** The `│ … │` cells come off so a row reads as the body's own text. */
function inner(line: string): string {
  return line.replace(/^│ /, "").replace(/ +│$/, "");
}

function click(chat: Container, x: number, y: number, width = W, height = 30) {
  return chat.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });
}

/** Distinct foreground colours: one means pi had no grammar and painted the block flat. */
function foregrounds(rows: readonly string[]): number {
  return new Set(rows.flatMap((row) => row.match(/\x1b\[38;[0-9;]*m/g) ?? [])).size;
}

test("both fences become rules that join the reply's frame", () => {
  const { plain } = fixture(`Before.\n\n\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes("copy"));
  assert.ok(open >= 0, plain.join("\n"));
  assert.match(plain[open]!, /^├─ fish copy ─+┤$/, "the language and chip sit on the rule");
  const close = plain.findIndex((line, row) => row > open && /^├─+┤$/.test(line));
  assert.ok(close > open, plain.join("\n"));
  assert.ok(!plain.some((line) => line.includes("```")), "no fence rows left");
  assert.deepEqual(plain.slice(open + 1, close).map(inner), FISH.split("\n").map((line) => `  ${line}`));
});

test("the chip copies the block's own text and says so for a moment", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const { chat, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
    const y = plain.findIndex((line) => line.includes(" fish "));
    click(chat, plain[y]!.indexOf("copy"), y, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [FISH], "pi's indent and colours are not part of the code");
    const after = chat.render(W).map(visibleText);
    assert.ok(after[y]!.includes("copied"), after[y]);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("a click off the chip copies nothing and stays pi's selection", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const { chat, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
    const y = plain.findIndex((line) => line.includes(" fish "));
    const onLabel = click(chat, plain[y]!.indexOf("fish"), y, W, plain.length);
    const onCode = click(chat, plain[y + 1]!.indexOf("set"), y + 1, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, []);
    assert.notEqual(onLabel?.handled, true);
    assert.notEqual(onCode?.handled, true);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("the chip lights up and takes the hand while the pointer is on it", () => {
  enableHoverForTests();
  resetHover();
  const { chat, plain } = fixture("```fish\n" + FISH + "\n```\n");
  const y = plain.findIndex((line) => line.includes(" fish copy "));
  assert.ok(y >= 0, plain.join("\n"));
  const x = plain[y]!.indexOf("copy");
  const move = (cx: number, cy: number) => chat.handleMouse({ type: "move", button: "none", x: cx, y: cy, screenX: cx, screenY: cy, width: W, height: plain.length, shift: false, alt: false, ctrl: false });
  move(x, y);
  const hot = chat.render(W).find((row) => row.includes("copy"))!;
  assert.ok(/\x1b\[48;/.test(hot), "the chip wears the selected background under the pointer");
  move(x, y + 1);
  const cold = chat.render(W).find((row) => row.includes("copy"))!;
  assert.ok(!/\x1b\[48;/.test(cold), "and gives it back when the pointer leaves");
  resetHover();
  disableHoverForTests();
});

test("codeBlocks off leaves pi's own fences and code rows", () => {
  const { plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  assert.ok(!plain.some((line) => line.includes("copy")), plain.join("\n"));
  assert.ok(plain.some((line) => line.includes("```fish")), "the fences are pi's");
  assert.ok(plain.some((line) => inner(line) === `  ${FISH.split("\n")[0]}`), "and so is the indent");
});

test("fish gets a grammar, so its rows are not one flat colour", () => {
  const off = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  const on = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const body = ({ rows, plain }: { rows: string[]; plain: string[] }) => {
    const start = plain.findIndex((line) => line.includes("fish")) + 1;
    return rows.slice(start, start + FISH.split("\n").length);
  };
  assert.equal(foregrounds(body(off)), 2, "pi has no fish grammar: the border and one flat colour");
  assert.ok(foregrounds(body(on)) > 2, "bash's grammar colours keywords, strings and comments");
});

test("a diff block goes side by side through the same switch as an edit", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" diff ") && line.includes("copy"));
  assert.ok(open >= 0, plain.join("\n"));
  const panes = plain.slice(open + 1, open + 5).join("\n");
  assert.match(panes, /old\s+│\s+new/, `two labelled panes:\n${panes}`);
  assert.match(panes, /const a = 2;/, panes);
});

test("a narrow row keeps the unified body between the same rules", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { width: 60 });
  const open = plain.findIndex((line) => line.includes(" diff "));
  assert.ok(open >= 0, plain.join("\n"));
  assert.deepEqual(plain.slice(open + 1, open + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("splitDiff off keeps the unified body", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { splitDiff: false });
  const open = plain.findIndex((line) => line.includes(" diff "));
  assert.ok(!plain.slice(open + 1).join("\n").includes("old"));
  assert.deepEqual(plain.slice(open + 1, open + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("an info string shows only its language, and a bare fence says code", () => {
  const withInfo = fixture(`\`\`\`ts title="a.ts"\nconst a = 1;\n\`\`\`\n`);
  const open = withInfo.plain.findIndex((line) => line.includes(" ts "));
  assert.ok(open >= 0, withInfo.plain.join("\n"));
  assert.ok(!withInfo.plain[open]!.includes("title"), "the whole info string is not the label");
  const bare = fixture("```\nplain text\n```\n");
  assert.ok(bare.plain.some((line) => /^├─ code copy ─+┤$/.test(line)), bare.plain.join("\n"));
});

test("a railed reply joins the rules to its rail", () => {
  const { plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { replyStyle: "rail" });
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes("copy"));
  assert.ok(open >= 0, plain.join("\n"));
  assert.match(plain[open]!, /^├─ fish copy ─+$/, "no right corner: a rail has no right edge");
  assert.ok(plain[open]!.endsWith("─"), plain[open]);
});

test("every rule row is exactly the terminal width", () => {
  const { rows } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n\n\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  assert.ok(rows.every((row) => visibleWidth(row) === W), rows.map((row) => `${visibleWidth(row)}:${visibleText(row).slice(0, 12)}`).join("\n"));
});

test("a pi whose Markdown has no renderToken reports no code blocks", () => {
  const proto = Markdown.prototype as unknown as { renderToken?: unknown };
  const original = proto.renderToken;
  assert.equal(codeBlocksAvailable(), true);
  proto.renderToken = undefined;
  try {
    assert.equal(codeBlocksAvailable(), false, "the hook is gone, and the warning path is what runs");
  } finally {
    proto.renderToken = original;
  }
  assert.equal(codeBlocksAvailable(), true);
});

test("copying across a block takes the rules out and keeps the code", () => {
  const { rows, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const open = plain.findIndex((line) => line.includes(" fish ") && line.includes("copy"));
  const close = plain.findIndex((line, row) => row > open && /^├─+┤$/.test(line));
  const cleaned = cleanTranscriptRows(rows, open, close);
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.rows[0], null, "the opening rule is chrome");
  assert.equal(cleaned.rows.at(-1), null, "and so is the closing one");
  const text = cleaned.rows.slice(1, -1).filter((row) => row).map((row) => row!.text.trimEnd()).join("\n");
  assert.ok(text.includes("set -l x 1"), text);
  assert.ok(!text.includes("─") && !text.includes("copy"), text);
});
