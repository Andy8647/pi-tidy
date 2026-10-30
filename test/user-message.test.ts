/**
 * The "rail" user message: rules above and below, an accent `│` in front of
 * every content row, pi's own Markdown child doing the text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
let colorMode = "truecolor";
const fakeTheme = {
  fg: (color: string, text: string) => {
    if (color.startsWith("#")) throw new Error(`Unknown theme color: ${color}`);
    return `<fg:${color}>${text}</fg>`;
  },
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `<b>${text}</b>`,
  getColorMode: () => colorMode,
};
(globalThis as any)[THEME_KEY] = fakeTheme;

const { patchUserMessages, patchContainerBoxes } = await import("../frame.ts");
const { tidyEnabled } = await import("../live.ts");
const { UserMessageComponent } = await import("@earendil-works/pi-coding-agent");

const BG_FILL_RE = /\x1b\[48;[0-9;]*m|\x1b\[(?:4[0-7]|10[0-7])m/;
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
const W = 40;

const RAIL = { style: "rail", railColor: "railCol", ruleColor: "ruleCol", paddingY: 1, icons: false } as const;
const USER_ICON = "\u{f007}";

function plain(line: string): string {
  return line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/<\/?[^>]+>/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

test("a short message: rules, padding rows and the rail, full width and no background", () => {
  patchUserMessages(RAIL);
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);

  assert.equal(lines.length, 5, "rule, pad, text, pad, rule");
  assert.equal(lines[0], `${ZONE_START}<fg:ruleCol>${"─".repeat(W)}</fg>`);
  assert.equal(lines.at(-1), `${ZONE_END}<fg:ruleCol>${"─".repeat(W)}</fg>`);
  assert.equal(lines[1], "<fg:railCol>│</fg>", "padding row is the rail alone");
  assert.equal(plain(lines[2]).trimEnd(), "│ hi");
  assert.ok(lines[2].startsWith("<fg:railCol>│</fg> "), "one space between rail and text");
  assert.ok(!BG_FILL_RE.test(lines.join("\n")), "no background fill escapes");
});

test("paddingY 0 drops the rail-only rows", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.deepEqual(lines.map(plain).map((l) => l.trimEnd()), ["─".repeat(W), "│ hi", "─".repeat(W)]);
});

test("multi-line markdown keeps its rows and every row carries the rail", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  const lines: string[] = new UserMessageComponent("first\n\n- one\n- two" as never).render(W);
  const body = lines.slice(1, -1).map(plain);
  assert.ok(body.every((l) => l.startsWith("│ ")), "rail on every content row");
  assert.ok(body.some((l) => l.includes("first")));
  assert.ok(body.some((l) => l.includes("one")) && body.some((l) => l.includes("two")));
});

test("registered markdown transformers still run", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  // Short: the fake theme's tags count as visible text, so long rows wrap.
  const transformer = (markdown: string) => `${markdown} (t)`;
  const component = new (UserMessageComponent as any)("hi", undefined, 1, [transformer]);
  assert.ok(component.render(W).map(plain).join("\n").includes("hi (t)"));
});

test("with icons, the user icon leads the text in the rail color", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.equal(lines.length, 3, "still one row for one line of text");
  assert.ok(lines[1].startsWith(`<fg:railCol>│</fg> <fg:railCol>${USER_ICON}</fg> `), lines[1]);
  assert.equal(plain(lines[1]).trimEnd(), `│ ${USER_ICON} hi`);
});

test("with icons, later rows hang under the text, not under the icon", () => {
  patchUserMessages({ ...RAIL, paddingY: 1, icons: true });
  const lines: string[] = new UserMessageComponent("first\nsecond" as never).render(W);
  const body = lines.slice(1, -1).map(plain).map((line) => line.trimEnd());
  assert.deepEqual(body, ["│", `│ ${USER_ICON} first`, "│   second", "│"]);
});

test("switching icons on and off re-renders a cached message", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: false });
  const component = new UserMessageComponent("hi" as never);
  assert.ok(!component.render(W).join("").includes(USER_ICON));
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  assert.ok(component.render(W)[1].includes(USER_ICON));
});

test("hex colors paint truecolor, or the nearest 256-color entry in 256-color mode", () => {
  patchUserMessages({ ...RAIL, railColor: "#cba6f7", ruleColor: "#fff", paddingY: 0 });
  const truecolor: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.ok(truecolor[1].startsWith("\x1b[38;2;203;166;247m│\x1b[39m"));
  assert.ok(truecolor[0].includes("\x1b[38;2;255;255;255m─"));

  colorMode = "256color";
  try {
    const indexed: string[] = new UserMessageComponent("hi" as never).render(W);
    assert.ok(indexed[1].startsWith("\x1b[38;5;183m│"), indexed[1]);
    assert.ok(indexed[0].includes("\x1b[38;5;231m─"), "white is the cube's corner");
  } finally {
    colorMode = "truecolor";
  }
});

test("an unknown color name leaves the cell unpainted instead of breaking the render", () => {
  patchUserMessages({ ...RAIL, railColor: "#nothex", paddingY: 0 });
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.equal(plain(lines[1]).trimEnd(), "│ hi");
});

test("an unchanged message hits the cache; new options do not", () => {
  patchUserMessages(RAIL);
  const component = new UserMessageComponent("hi" as never);
  const first = component.render(W);
  assert.strictEqual(component.render(W), first, "same array on a hit");
  patchUserMessages({ ...RAIL, paddingY: 0 });
  assert.equal(component.render(W).length, 3, "padding change re-renders");
  patchUserMessages({ ...RAIL, paddingY: 0, railColor: "otherCol" });
  assert.ok(component.render(W)[1].startsWith("<fg:otherCol>│"), "color change re-renders");
});

test("off, frame and tidy.enabled: false all pass through to the render underneath", () => {
  patchUserMessages({ ...RAIL, style: "off" });
  assert.ok(!new UserMessageComponent("hi" as never).render(W).some((l) => l.includes("railCol")), "off");

  patchUserMessages({ ...RAIL, style: "frame" });
  patchContainerBoxes({ user: "userCol", custom: "customCol" }, { includeUser: true });
  const framed: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.ok(framed.some((l) => l.includes("<fg:userCol>╭")), "frame style draws the rounded frame");
  assert.ok(!framed.some((l) => l.includes("railCol")), "and no rail");

  patchContainerBoxes({ user: "userCol", custom: "customCol" }, { includeUser: false });
  patchUserMessages(RAIL);
  tidyEnabled.set(false);
  try {
    assert.ok(!new UserMessageComponent("hi" as never).render(W).some((l) => l.includes("railCol")), "disabled");
  } finally {
    tidyEnabled.set(true);
  }
  assert.ok(new UserMessageComponent("hi" as never).render(W)[0].includes("ruleCol"), "rail again once re-enabled");
});

test("pi's OSC 133 markers stay on the first and last line only", () => {
  patchUserMessages(RAIL);
  const lines: string[] = new UserMessageComponent("a\n\nb" as never).render(W);
  assert.ok(lines[0].startsWith(ZONE_START) && lines.at(-1)!.startsWith(ZONE_END));
  assert.ok(lines.slice(1, -1).every((l) => !l.includes("\x1b]133;")), "no markers in between");
});
