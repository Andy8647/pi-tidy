/**
 * The README / package cover, as SVG on stdout.
 *
 *   node scripts/gen-cover.mts > assets/cover.svg
 *   rsvg-convert -z 2 assets/cover.svg -o assets/cover.png
 *
 * The transcript is an opened run in the default style (rail). Its rows are written
 * out here with the theme's colours, except the edit's panes: those are the real
 * renderSplitDiff() rows, so their columns are what tidy draws. Colours come from
 * catppuccin-mocha when pi can find it (PI_CODING_AGENT_DIR/themes), else pi's dark.
 */

import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { renderSplitDiff } from "../src/tools/split-diff.ts";
import { TOOL_ICONS } from "../src/draw/icons.ts";

try {
  initTheme("catppuccin-mocha");
} catch {
  initTheme("dark");
}
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];

// catppuccin mocha
const C = {
  crust: "#11111b",
  base: "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  border: "#585b70",
  muted: "#7f849c",
  dim: "#6c7086",
  subtext: "#a6adc8",
  text: "#cdd6f4",
  accent: "#89dceb",
  blue: "#89b4fa",
  teal: "#94e2d5",
  peach: "#fab387",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
};

const FONT = "Maple Mono NF, Menlo, monospace";
const SIZE = 16;
const ADV = 9.6; // a cell at 16px
const X0 = 548;
const TOP = 176;
const STEP = 24;
/** Cells across the window's body. */
const COLS = 67;

type Seg = { t: string; fill: string; italic?: boolean; bold?: boolean };
type Row = { segs: Seg[]; bg?: Array<{ col: number; cells: number; fill: string }> };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const s = (t: string, fill: string, extra: Partial<Seg> = {}): Seg => ({ t, fill, ...extra });
const cells = (segs: Seg[]) => segs.reduce((n, seg) => n + [...seg.t].length, 0);

const ICON = {
  bash: TOOL_ICONS.bash!,
  read: TOOL_ICONS.read!,
  edit: TOOL_ICONS.edit!,
  process: "\u{f0ad}",
  thought: "\u{f09d1}",
  dolphin: "\u{f18b4}",
  ts: "\u{f06e6}",
  copy: "\u{f0192}",
};

const line = s("│", C.border);
const on = (...segs: Seg[]): Row => ({ segs: [line, s(" ", C.text), ...segs] });
const thought = (text: string): Row => on(s(`${ICON.thought} `, C.yellow), s("thinking", C.yellow, { italic: true }), s(`  ${text}`, C.muted, { italic: true }));
/** A rule from `used` cells on to the window's edge. */
const fill = (used: number, color: string) => s("─".repeat(Math.max(0, COLS - used)), color);

/** The real panes, ANSI runs turned into segments and background cells. */
function panes(width: number, lead: Seg[]): Row[] {
  // Short enough that no line is cut at the pane's edge, and no `=>`: Maple Mono draws
  // one as an arrow, and rsvg cannot turn its ligatures off.
  const before = "export function retry(fn) {\n  const retries = 3;\n  return run(fn, retries);\n}\n";
  const { diff } = generateDiffString(before, before.replace("retries = 3", "retries = 5"));
  const out = renderSplitDiff({ diff, width, theme, filePath: "src/retry.ts" })!;
  const leadCells = cells(lead);
  return out.lines.map((text) => {
    const segs: Seg[] = [...lead];
    const bg: NonNullable<Row["bg"]> = [];
    let fg = C.text;
    let back: string | undefined;
    let col = leadCells;
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const push = (chunk: string) => {
      if (!chunk) return;
      segs.push(s(chunk, fg));
      const n = [...chunk].length;
      if (back) bg.push({ col, cells: n, fill: back });
      col += n;
    };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      const p = m[1]!.split(";").map(Number);
      for (let i = 0; i < p.length; i++) {
        if (p[i] === 0) { fg = C.text; back = undefined; }
        else if (p[i] === 39) fg = C.text;
        else if (p[i] === 49) back = undefined;
        else if ((p[i] === 38 || p[i] === 48) && p[i + 1] === 2) {
          const hex = `#${[p[i + 2], p[i + 3], p[i + 4]].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
          if (p[i] === 38) fg = hex;
          else back = hex;
          i += 4;
        }
      }
      last = m.index + m[0].length;
    }
    push(text.slice(last));
    return { segs, bg };
  });
}

// The box hangs on the run's line: `│ ` then the box, whose blank side is one cell.
const boxCells = COLS - 2;
const top = [s("── ", C.teal), s(`${ICON.edit} `, C.teal), s(`${ICON.ts} `, C.blue), s("src/retry.ts", C.text, { bold: true }), s(` ${ICON.copy} `, C.muted)];
const rows: Row[] = [
  { segs: [s("▾ took 46s · ", C.muted), s(`${ICON.dolphin} `, C.muted), s("LLM 38s · tools 8s", C.muted)] },
  thought("The retry test flakes on CI…"),
  on(s("Checking the build first.", C.text)),
  on(
    s("▸ 4 calls · ", C.muted), s(`${ICON.bash} `, C.peach), s("bash×3  ", C.muted), s(`${ICON.read} `, C.blue), s("read×1", C.muted),
    s(" · ", C.muted), s("1 failed", C.red), s(" · 2.4s", C.muted),
  ),
  { segs: [line] },
  thought("Raise the budget, then rerun."),
  on(s("Raising the retry budget:", C.text)),
  on(...top, fill(2 + cells(top), C.teal)),
  ...panes(boxCells - 2, [line, s("  ", C.text)]),
  on(s("─".repeat(boxCells), C.teal)),
  on(
    s("▸ 2 calls · ", C.muted), s(`${ICON.bash} `, C.peach), s("bash×1  ", C.muted), s(`${ICON.process} `, C.accent), s("process×1", C.muted),
    s(" · ", C.muted), s("◐ 1 running", C.accent),
  ),
  // The reply is the last step: one row clear of the process, on the run's line.
  { segs: [line] },
  (() => {
    const head = [s("├─ ", C.border), s(`${ICON.dolphin} deepseek-flash`, C.accent), s(" 14:07", C.dim, { italic: true }), s(" ", C.border)];
    return { segs: [...head, fill(cells(head), C.border)] };
  })(),
  on(s("Server is up. Tests pass.", C.text)),
  { segs: [s(`╰${"─".repeat(COLS - 1)}`, C.border)] },
];

const svgRows = rows.map((row, index) => {
  const y = TOP + index * STEP;
  const rects = (row.bg ?? []).map((cell) => `<rect x="${(X0 + cell.col * ADV).toFixed(1)}" y="${y - 18}" width="${(cell.cells * ADV).toFixed(1)}" height="${STEP}" fill="${cell.fill}"/>`).join("");
  const spans = row.segs.map((seg) => {
    const style = `${seg.italic ? ' font-style="italic"' : ""}${seg.bold ? ' font-weight="700"' : ""}`;
    return `<tspan fill="${seg.fill}"${style}>${esc(seg.t)}</tspan>`;
  }).join("");
  return `${rects ? `    ${rects}\n` : ""}    <text x="${X0}" y="${y}">${spans}</text>`;
});

const bottom = TOP + (rows.length - 1) * STEP;
if (bottom > 616) throw new Error(`the transcript runs to y=${bottom}, past the window`);

const bullets: Array<[string, string, string]> = [
  ["▸", C.accent, "one summary line per run"],
  ["│", C.border, "rails or frames: one style for all"],
  ["✗", C.red, "failures and edits stay in view"],
  ["◐", C.accent, "background jobs tracked live"],
];

console.log(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <!-- pi-tidy cover — generated by scripts/gen-cover.mts; edit that, not this. -->
  <rect width="1280" height="720" fill="${C.crust}"/>

  <g font-family="${FONT}">
    <text x="72" y="250" font-size="78" font-weight="700" fill="${C.text}">pi-tidy</text>
    <rect x="74" y="274" width="64" height="5" rx="2.5" fill="${C.accent}"/>
    <text x="72" y="330" font-size="25" fill="${C.text}">A run's tool calls</text>
    <text x="72" y="364" font-size="25" fill="${C.text}">fold into one line</text>
    <g font-size="18" fill="${C.subtext}">
${bullets.map(([glyph, color, text], i) => `      <text x="72" y="${430 + i * 32}"><tspan fill="${color}">${glyph}</tspan>  ${esc(text)}</text>`).join("\n")}
    </g>
    <rect x="72" y="574" width="300" height="44" rx="10" fill="${C.base}" stroke="${C.surface0}"/>
    <text x="92" y="602" font-size="18" fill="${C.dim}">$ <tspan fill="${C.text}">pi install npm:pi-tidy</tspan></text>
  </g>

  <rect x="520" y="92" width="700" height="546" rx="16" fill="${C.base}" stroke="${C.surface0}" stroke-width="1.5"/>
  <line x1="520" y1="134" x2="1220" y2="134" stroke="${C.surface0}" stroke-width="1.5"/>
  <circle cx="548" cy="113" r="6" fill="${C.surface1}"/>
  <circle cx="570" cy="113" r="6" fill="${C.surface1}"/>
  <circle cx="592" cy="113" r="6" fill="${C.surface1}"/>
  <text x="870" y="119" font-family="${FONT}" font-size="14" fill="${C.dim}" text-anchor="middle">~/app — pi</text>

  <g font-family="${FONT}" font-size="${SIZE}" xml:space="preserve">
${svgRows.join("\n")}
  </g>
</svg>`);
