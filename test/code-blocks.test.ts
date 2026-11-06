import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { cleanTranscriptRows } from "../src/clean-copy.ts";
import { setClipboardWriter } from "../src/clipboard.ts";
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
}

function fixture(text: string, options: FixtureOptions = {}) {
  const width = options.width ?? W;
  resetGroups();
  patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: false, splitDiff: true });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: "frame",
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

/**
 * Distinct foreground colours in a run of rows. The reply frame's border colour is
 * always one of them, so a block pi could not parse shows exactly two.
 */
function foregrounds(rows: readonly string[]): number {
  return new Set(rows.flatMap((row) => row.match(/\x1b\[38;[0-9;]*m/g) ?? [])).size;
}

test("a fenced block keeps pi's own rows and gains a copy chip on its fence", () => {
  const { plain } = fixture(`Before.\n\n\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const fence = plain.findIndex((line) => line.includes("```fish"));
  assert.ok(fence >= 0, plain.join("\n"));
  assert.match(plain[fence]!, /^│ ```fish {2}copy +│$/, "the chip sits on the opening fence");
  assert.equal(inner(plain[fence + 1]!), `  ${FISH.split("\n")[0]}`, "the code keeps pi's indent");
  assert.equal(inner(plain[fence + FISH.split("\n").length + 1]!), "```", "the closing fence is pi's");
  assert.ok(!plain.some((line) => line.includes("▏")), "no rail anywhere");
});

test("the chip copies the block's own text and says so for a moment", async () => {
  const written: string[] = [];
  setClipboardWriter(async (text) => { written.push(text); });
  try {
    const { chat, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
    const y = plain.findIndex((line) => line.includes("```fish"));
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
    const y = plain.findIndex((line) => line.includes("```fish"));
    const onFence = click(chat, plain[y]!.indexOf("fish"), y, W, plain.length);
    const onCode = click(chat, plain[y + 1]!.indexOf("set"), y + 1, W, plain.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, []);
    assert.notEqual(onFence?.handled, true);
    assert.notEqual(onCode?.handled, true);
  } finally {
    setClipboardWriter(undefined);
  }
});

test("codeBlocks off leaves pi's rows exactly as they were", () => {
  const { plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  assert.ok(!plain.some((line) => line.includes("copy")), plain.join("\n"));
  assert.match(plain.find((line) => line.includes("```fish"))!, /^│ ```fish +│$/);
});

test("fish gets a grammar, so its rows are not one flat colour", () => {
  const flat = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`, { codeBlocks: false });
  const railed = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const fence = (plain: string[]) => plain.findIndex((line) => line.includes("```fish"));
  const body = (rows: string[], plain: string[]) => {
    const start = fence(plain) + 1;
    return rows.slice(start, start + FISH.split("\n").length);
  };
  assert.equal(foregrounds(body(flat.rows, flat.plain)), 2, "pi has no fish grammar: the border and one flat block colour");
  assert.ok(foregrounds(body(railed.rows, railed.plain)) > 1, "bash's grammar colours keywords, strings and comments");
  assert.ok(!flat.plain.some((line) => line.includes("copy")), "only the grammar change, not the chip");
});

test("a diff block goes side by side through the same switch as an edit", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  const fence = plain.findIndex((line) => line.includes("```diff"));
  assert.ok(fence >= 0, plain.join("\n"));
  const panes = plain.slice(fence + 1, fence + 5).join("\n");
  assert.match(panes, /old\s+│\s+new/, `two labelled panes:\n${panes}`);
  assert.match(panes, /const a = 2;/, panes);
});

test("a narrow row keeps the unified body behind the same fence", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { width: 60 });
  const fence = plain.findIndex((line) => line.includes("```diff"));
  assert.ok(fence >= 0, plain.join("\n"));
  assert.deepEqual(plain.slice(fence + 1, fence + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("splitDiff off keeps the unified body", () => {
  const { plain } = fixture(`\`\`\`diff\n${DIFF}\n\`\`\`\n`, { splitDiff: false });
  const fence = plain.findIndex((line) => line.includes("```diff"));
  assert.ok(!plain.slice(fence + 1).join("\n").includes("old"));
  assert.deepEqual(plain.slice(fence + 1, fence + 4).map(inner), DIFF.split("\n").map((line) => `  ${line}`));
});

test("an info string stays whole on the fence, and the chip follows it", () => {
  const { plain } = fixture(`\`\`\`ts title="a.ts"\nconst a = 1;\n\`\`\`\n`);
  const fence = plain.findIndex((line) => line.includes("title="));
  assert.ok(fence >= 0, plain.join("\n"));
  assert.match(plain[fence]!, /```ts title="a\.ts" {2}copy/);
  assert.equal(inner(plain[fence + 1]!), "  const a = 1;");
});

test("a bare fence gets the chip too", () => {
  const { plain } = fixture("```\nplain text\n```\n");
  const fence = plain.findIndex((line) => line.includes("copy"));
  assert.ok(fence >= 0, plain.join("\n"));
  assert.match(plain[fence]!, /^│ ``` {2}copy +│$/);
  assert.equal(inner(plain[fence + 1]!), "  plain text");
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

test("copying a fence takes the chip out and keeps the fence", () => {
  const { rows, plain } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n`);
  const fence = plain.findIndex((line) => line.includes("```fish"));
  const cleaned = cleanTranscriptRows(rows, fence, fence + FISH.split("\n").length + 1);
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.rows[0]?.text.trimEnd(), "```fish", "the chip is chrome");
  assert.equal(cleaned.rows[1]?.text.trimEnd(), `  ${FISH.split("\n")[0]}`, "the code row is untouched");
});

test("every row keeps the terminal width", () => {
  const { rows } = fixture(`\`\`\`fish\n${FISH}\n\`\`\`\n\n\`\`\`diff\n${DIFF}\n\`\`\`\n`);
  assert.ok(rows.every((row) => visibleWidth(row) === W));
});
