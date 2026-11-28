import { Box, Container, Markdown, MouseRegion, Text, sliceByColumn, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { clipToWidth, formatMessageTime, italicDim, labeledTopBorder, messageHeader, sameLines, visibleText } from "../draw/frame-draw.ts";
import { toolKindIcon } from "../draw/icons.ts";
import { canCopyText, copyText } from "../clipboard.ts";
import { COPIED_MS, chipLabels, quoteChip, repaintChip, ruleCodeToken, ruleRows, RULE_GLYPH, spliceQuoteChips, type ChipSpan, type CodeBlock, type CodeBlockOptions, type CodeBlocks, type QuoteChip } from "./code-blocks.ts";
import { paint } from "../draw/paint.ts";
import { FRAME_PADDING_Y, GAP_PART, GAP_RUN } from "../draw/rhythm.ts";
import { optionsRevision, tidyEnabled } from "../live.ts";
import { claimHover, hoverBand, isRowHovered, requestHoverRender } from "../hover.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { jobNoteCount } from "../tools/background-jobs.ts";
import { toolKindName } from "../tools/tool-groups.ts";
import { folded, messageKey, turnFor, turnOptions, turnStore, type Turn, type TurnLlmMetrics } from "./turn-state.ts";
import { closeThinking } from "../tools/tool-group-view.ts";
import { toolColor } from "../tools/tool-lines.ts";
import { delegateCounts, delegateRevision } from "./delegate-notices.ts";

const NATIVE_VIEW = Symbol.for("pi-toolbox:message-view");
export const TURN_LAYOUT = Symbol.for("pi-tidy:turn-layout");
const LAYOUT = TURN_LAYOUT;
const MOUSE = Symbol.for("pi-tidy:turn-mouse");
const BASE_MOUSE = Symbol.for("pi-tidy:turn-base-mouse");
const HOVER = Symbol.for("pi-tidy:turn-hover");
const CACHE = Symbol.for("pi-tidy:turn-cache");
// Nerd Fonts glyphnames.json: cod-openai, cod-claude, md-google; deepseek has no brand
// glyph in Nerd Fonts, so it gets md-dolphin, the nearest to its whale. Not the whale
// emoji: a colour picture two cells wide was the loudest thing on a quiet screen. All
// others use md-robot.
const PROVIDER_ICONS: Record<string, string> = {
  openai: "\uec81", "openai-codex": "\uec81", anthropic: "\uec82",
  deepseek: "\u{f18b4}",
  google: "\u{f02ad}", "google-gemini-cli": "\u{f02ad}", "google-vertex": "\u{f02ad}",
};
const ROBOT_ICON = "\u{f06a9}"; // md-robot
/** The provider that answered, as one glyph: the reply header and the summary share it. */
function providerIcon(provider: string | undefined): string {
  return PROVIDER_ICONS[provider ?? ""] ?? ROBOT_ICON;
}
export function replyLabel(provider: string | undefined, model: string | undefined, icons: boolean): string {
  // The glyph still says which provider answered; the word next to it is what
  // the reader is comparing across replies — the model, not the vendor.
  return `${icons ? `${providerIcon(provider)} ` : ""}${model || provider || "agent"}`;
}
function duration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
function formatTtft(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
function formatTps(tps: number): string {
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}
/** `TTFT 1.2s · 48.5 tok/s`, or the empty string when the turn has no live metrics. */
export function formatTurnMetrics(metrics: TurnLlmMetrics): string {
  const parts: string[] = [];
  if (typeof metrics.ttftMs === "number" && Number.isFinite(metrics.ttftMs) && metrics.ttftMs >= 0) {
    parts.push(`TTFT ${formatTtft(metrics.ttftMs)}`);
  }
  if (typeof metrics.tps === "number" && Number.isFinite(metrics.tps) && metrics.tps > 0) {
    parts.push(formatTps(metrics.tps));
  }
  return parts.join(" · ");
}
/**
 * What follows the model's name on the reply's top edge: the time, then the run's
 * metrics when `replyMetrics` is on. Only a framed reply has an edge to put it on,
 * and every other step of a turn passes here on every frame, so it is built there.
 */
function replyTail(message: any, turn: Turn, theme: ThemeLike, options: { timeFormat: string; replyMetrics: boolean }): string {
  const time = typeof message.timestamp === "number" ? italicDim(theme, formatMessageTime(message.timestamp, options.timeFormat)) : "";
  const metrics = options.replyMetrics ? formatTurnMetrics(turnStore.get().llmMetrics(turn)) : "";
  return metrics ? [time, theme.fg("muted", metrics)].filter(Boolean).join(theme.fg("muted", " · ")) : time;
}
export function hasProcess(turn: Turn): boolean {
  const cached = processCache.get(turn);
  if (cached && cached.version === turn.version) return cached.value;
  const value = hasProcessUncached(turn);
  processCache.set(turn, { version: turn.version, value });
  return value;
}
const processCache = new WeakMap<Turn, { version: number | undefined; value: boolean }>();
function hasProcessUncached(turn: Turn): boolean {
  if (["error", "interrupted", "incomplete"].includes(turn.outcome) || turn.tools.size > 0) return true;
  let texts = 0;
  for (const message of turn.messages.values()) if (message.role === "assistant") {
    if (["error", "aborted", "length"].includes(message.stopReason ?? "")) return true;
    if (message.content?.some((block: any) => block.type === "thinking" && block.thinking?.trim())) return true;
    if (message.content?.some((block: any) => block.type === "text" && block.text?.trim()) && ++texts > 1) return true;
  }
  return false;
}
export function summaryLine(turn: Turn, theme: ThemeLike, width: number, hovered = false, now = Date.now()): string {
  // Every frame asks for this once per turn, and the line is long enough that
  // measuring it (CJK-safe truncation over ~25 escapes) costs more than drawing
  // the rows it replaces. Rebuild it only when the turn moved or a second passed.
  // A running turn's line is second-granular, so half a second of staleness is
  // invisible; a settled one never changes again.
  const tick = turn.outcome === "running" ? Math.floor(now / 500) : 0;
  const isFolded = folded(turn);
  const color = turnOptions.get().assistantColor;
  // A job's notifications hang on rows inside its group. Folded, those rows are
  // not drawn at all, so the count is the only sign they arrived.
  const notes = isFolded ? noteTotal(turn) : 0;
  // A sub-agent's notice arrives long after its turn settled, without touching it.
  const delegates = delegateRevision();
  const cached = summaryCache.get(turn);
  // The tool colours the icons wear arrive with a reload, and every reload bumps this.
  const revision = optionsRevision();
  if (cached && cached.version === turn.version && cached.tick === tick && cached.width === width && cached.hovered === hovered && cached.folded === isFolded && cached.color === color && cached.notes === notes && cached.delegates === delegates && cached.revision === revision) {
    return cached.line;
  }
  const line = buildSummaryLine(turn, theme, width, hovered, now, notes);
  summaryCache.set(turn, { version: turn.version, tick, width, hovered, folded: isFolded, color, notes, delegates, revision, line });
  return line;
}
const summaryCache = new WeakMap<Turn, { version: number | undefined; tick: number; width: number; hovered: boolean; folded: boolean; color: string; notes: number; delegates: number; revision: number; line: string }>();

/** Everything the turn's own calls' jobs have reported, as one number. */
function noteTotal(turn: Turn): number {
  let total = 0;
  for (const id of turn.tools.keys()) total += jobNoteCount(id);
  return total;
}

function buildSummaryLine(turn: Turn, theme: ThemeLike, width: number, hovered: boolean, now = Date.now(), notes = 0): string {
  const store = turnStore.get();
  const total = turn.startedAt === undefined ? undefined : (turn.endedAt ?? now) - turn.startedAt;
  const state = turn.outcome;
  const marker = folded(turn) ? hovered ? "▶" : "▸" : "▾";
  // Every part exists twice: plain, and wearing the glyph that names it. A row too
  // narrow for the glyphs falls back to the plain list, so the truncation below
  // never gets to eat a count.
  const parts: string[] = [];
  const glyphed: string[] = [];
  const add = (plain: string, icon = plain) => { parts.push(plain); glyphed.push(icon); };
  // Grey like the rest of the process; a run still going is the one thing here
  // that wants the eye, so it keeps the accent.
  add(theme.fg(state === "running" ? "accent" : "muted", `${marker} ${state === "running" ? "running" : "took"} ${duration(total)}`));
  if (!["completed", "running", "unknown"].includes(state)) add(theme.fg("error", state));
  const llmFailures = [...turn.messages.values()].filter((message) => message.role === "assistant" && message.stopReason === "error").length;
  if (llmFailures) add(theme.fg("error", `${llmFailures} LLM failed`));
  // Open, the group a failed call sits in says so on its own line, and a failed box is
  // red: the count here would be the same news twice. Folded, it is the only report.
  if (folded(turn)) {
    const failed = [...turn.tools.values()].filter((tool) => tool.failed).length;
    if (failed) add(theme.fg("error", `${failed} failed`));
    const nestedFailed = [...turn.tools.values()].reduce((sum, tool) => sum + (tool.nestedFailed ?? 0), 0);
    if (nestedFailed) add(theme.fg("error", `${nestedFailed} nested failed`));
  }
  // Background sub-agents this turn launched, as their notices reported them
  // (delegate-notices.ts). A failure goes with the other failures: early on the
  // line, so a narrow row clips the counts after it first.
  const delegates = delegateCounts(turn);
  if (delegates.failed) add(theme.fg("error", `${delegates.failed} sub-agent${delegates.failed === 1 ? "" : "s"} failed`));
  // The glyph is the one the reply's border uses, so both lines name the same vendor.
  const answer = turn.messages.get(turn.final ?? turn.lastAssistant ?? "");
  const llm = `LLM ${duration(store.llmTime(turn, now))}`;
  add(theme.fg("muted", llm), theme.fg("muted", `${providerIcon(answer?.provider)} ${llm}`));
  add(theme.fg("muted", `tools ${duration(store.toolTime(turn, now))}`));
  const ended = [
    delegates.completed ? `${delegates.completed} completed` : "",
    delegates.other ? `${delegates.other} cancelled` : "",
  ].filter(Boolean);
  if (ended.length) add(theme.fg("muted", `sub-agents ${ended.join(", ")}`));
  // Open, the group headers below already count the calls.
  if (folded(turn)) {
    add(theme.fg("muted", `${turn.tools.size} calls`));
    const counts = new Map<string, number>();
    const nested = new Map<string, Map<string, number>>();
    for (const tool of turn.tools.values()) {
      const kind = toolKindName(tool.name);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (!tool.nested?.length) continue;
      const own = nested.get(kind) ?? new Map<string, number>();
      for (const entry of tool.nested) own.set(entry.name, (own.get(entry.name) ?? 0) + entry.count);
      nested.set(kind, own);
    }
    for (const [name, count] of counts) {
      // A program's own calls hang on the entry that ran them: the count still
      // says how many calls the run made, this says what those calls did.
      const own = nested.get(name);
      const inside = own ? ` (${[...own].map(([kind, times]) => `${kind}×${times}`).join(" ")})` : "";
      // Grey words; the icon wears its tool's colour, as the tool's own box does.
      const words = theme.fg("muted", `${name}×${count}${inside}`);
      add(words, `${paint(theme, toolColor(name), toolKindIcon(name))} ${words}`);
    }
    if (notes) add(theme.fg("muted", `${notes} matched`));
  }
  const separator = theme.fg("muted", " · ");
  const plain = parts.join(separator);
  if (!turnOptions.get().icons) return clipToWidth(plain, width, "…");
  const withGlyphs = glyphed.join(separator);
  return visibleWidth(withGlyphs) <= width ? withGlyphs : clipToWidth(plain, width, "…");
}

/**
 * Cells an open turn's rail takes from what hangs on it. The rail runs down column 0,
 * under the summary's `▾` and on into the reply's left border. Rows bring their own
 * lead; a box starts at its corner and needs one more so it does not touch the rail.
 */
export const TURN_RAIL_CELLS = 1;
export const TURN_RAIL_BOX_CELLS = 2;

const railedRows = new WeakMap<readonly string[], { rail: string; out: string[] }>();
const joinedRows = new WeakMap<readonly string[], { above: boolean; below: boolean; out: readonly string[] }>();

/** Turn a box's corners into joints where a rail meets them. Other rows are left alone. */
export function joinBoxCorners(rows: readonly string[], above: boolean, below: boolean): readonly string[] {
  if (!above && !below) return rows;
  const cached = joinedRows.get(rows);
  if (cached?.above === above && cached.below === below) return cached.out;
  const out = [...rows];
  if (above) {
    const top = out.findIndex((row) => visibleText(row).startsWith("╭"));
    if (top >= 0) out[top] = out[top]!.replace("╭", "├");
  }
  if (below) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (!visibleText(out[i]!).startsWith("╰")) continue;
      out[i] = out[i]!.replace("╰", "├");
      break;
    }
  }
  joinedRows.set(rows, { above, below, out });
  return out;
}

/**
 * Hang rows on an open turn's rail. A row's opening OSC 133 marker stays first:
 * terminals misrender a zone that starts after a border. Rows usually come back as
 * the same array, and then so does this.
 */
export function railRows(rows: readonly string[], theme: ThemeLike, pad = ""): string[] {
  // The colour of the summary's marker above it and the reply's border below it.
  const rail = `${paint(theme, turnOptions.get().assistantColor, "│")}${pad}`;
  const cached = railedRows.get(rows);
  if (cached?.rail === rail) return cached.out;
  const out = rows.map((row) => (row.startsWith(ZONE_A) ? `${ZONE_A}${rail}${row.slice(ZONE_A.length)}` : `${rail}${row}`));
  railedRows.set(rows, { rail, out });
  return out;
}

/** `count` rows of `row` (blank by default), as a child a Container can lay out and hit-test. */
function blankRows(count: number, row = ""): { render(width: number): string[]; invalidate(): void } {
  const rows = Array.from({ length: count }, () => row);
  return { render: () => rows, invalidate() {} };
}

/** Box owns the horizontal mouse transform; its padding cells become border glyphs. */
const ZONE_A = "\x1b]133;A\x07";
const ZONE_MARKERS = /\x1b\]133;[ABC]\x07/g;
class ReplyBody extends Box {
  private theme: ThemeLike;
  private color: string;
  private closed: boolean;
  /** What stands in the left cell: the frame's side, the run's line through a rail, or nothing. */
  private side: string;
  /** Rows of the child that are a code block's rule, by index. */
  private rules: ReadonlySet<number>;
  /** Blank rows inside the top and bottom edges: the child's rows start this far down. */
  private padY: number;
  /**
   * `closed` is a frame: both sides, and its code blocks' rules joined to them. A rail
   * has no sides, so its rules join nothing and keep to the text's column; its left cell
   * holds the open run's line, or is blank. A frame keeps a row clear inside each edge:
   * text pressed against a border is the cramped look, and a rail, with no border beside
   * the text, never has it.
   */
  constructor(theme: ThemeLike, color: string, closed: boolean, side: string, rules: ReadonlySet<number> = new Set()) {
    super(1, closed ? FRAME_PADDING_Y : 0);
    this.padY = closed ? FRAME_PADDING_Y : 0;
    this.theme = theme;
    this.color = color;
    this.closed = closed;
    this.side = side;
    this.rules = rules;
  }
  override render(width: number): string[] {
    const border = paint(this.theme, this.color, "│");
    const joint = paint(this.theme, this.color, "┤");
    const rule = paint(this.theme, this.color, RULE_GLYPH);
    return super.render(width).map((line, row) => {
      // pi's OSC 133 zones belong at the row's edges. The frame used to leave
      // them inside: zone A landed after the left border, and B/C before the
      // right one. Terminals that cache semantic prompts then misrender the
      // marked rows, so keep A before the border and B/C after it.
      const markers = line.match(ZONE_MARKERS) ?? [];
      const clean = markers.length ? line.replace(ZONE_MARKERS, "") : line;
      const start = markers.filter((marker) => marker === ZONE_A).join("");
      const end = markers.filter((marker) => marker !== ZONE_A).join("");
      // A rule joins the frame: the border cell becomes a corner and the padding
      // cell beside it turns into rule, so the line is unbroken edge to edge.
      if (this.rules.has(row - this.padY)) {
        if (!this.closed) return start + this.side + leadRule(sliceByColumn(clean, 1, width - 2), 1, rule) + end;
        return start + paint(this.theme, this.color, "├") + rule + sliceByColumn(clean, 2, Math.max(0, width - 4)) + rule + joint + end;
      }
      return start + this.side + sliceByColumn(clean, 1, width - 2) + (this.closed ? border : "") + end;
    });
  }
}

function installMouse(component: any): void {
  if (component.handleMouse?.[MOUSE]) return;
  const previous = component.handleMouse;
  component[BASE_MOUSE] = previous;
  const wrapped = function (this: any, event: TuiMouseEvent) {
    const layout = this[LAYOUT];
    if (!layout || !tidyEnabled.get()) return previous?.call(this, event);
    // The chip is the one place a click means something narrower than a row, so the
    // pointer gets the hand and the light for it while it is over those four cells.
    const code: CodeBlocks | undefined = this[CODE];
    // `spans` are body rows; the component's own rows start with the frame's top edge.
    const shift = layout.chipShift ?? 0;
    const chip = event.type === "move" ? (layout.spans as ChipSpan[] | undefined)?.find((span: ChipSpan) => span.row + layout.bodyTop === event.y && event.x - shift >= span.x && event.x - shift < span.end) : undefined;
    const hot = event.type === "move" && !chip && layout.header && event.y === layout.headerRow;
    const moved = event.type === "move" && ((code?.hover ?? -1) !== (chip?.index ?? -1) || !!this[HOVER] !== !!hot);
    if (event.type === "move") {
      this[HOVER] = !!hot;
      if (code) code.hover = chip?.index;
      const stateChanged = chip ? claimHover(this, "row") : hot ? claimHover(this, "turn-header") : claimHover(null, null);
      if (moved || stateChanged) requestHoverRender();
    }
    const result = layout.view.handleMouse(event);
    return moved ? { ...result, handled: true, render: true } : result;
  };
  (wrapped as any)[MOUSE] = true;
  component.handleMouse = wrapped;
}

/**
 * A run that ended in a failure with no text has no reply to keep. What the failure
 * said stays out of the fold instead: a summary's `error` cannot say what went wrong.
 */
function failedLast(turn: Turn): string | undefined {
  const last = turn.lastAssistant ? turn.messages.get(turn.lastAssistant) : undefined;
  return last && ["error", "aborted", "length"].includes(last.stopReason ?? "") ? turn.lastAssistant : undefined;
}

/**
 * Whether this message's process hangs on its open turn's rail. The reply it led to
 * stands clear of it at full width; until the turn ends, nothing is the reply yet.
 */
export function messageOnRail(component: any): boolean {
  if (!tidyEnabled.get() || turnOptions.get().collapseTurns === "off") return false;
  const turn = turnFor(component.lastMessage);
  if (!turn || folded(turn) || !hasProcess(turn)) return false;
  return turn.outcome === "running" || messageKey(component.lastMessage) !== turn.final;
}

/**
 * Whether this message's Markdown has the private method the rail hooks into.
 * False means replies keep pi's own code blocks, and nothing else changes.
 */
export function codeBlocksAvailable(): boolean {
  return typeof (Markdown.prototype as unknown as { renderToken?: unknown }).renderToken === "function";
}

const CODE = Symbol.for("pi-tidy:code-blocks");

interface CodeHook extends CodeBlocks {
  markdown: any;
  options: CodeBlockOptions;
  /** How each fenced token was drawn, by language and text: pi reuses a block it has already drawn. */
  built: Map<string, CodeBlock>;
  /** The rows `blocks` describes, so a render pi answered from its own cache is recognised. */
  rows?: readonly string[];
  /** The same rows with the quotes' chips on them, which is what the caller draws. */
  out?: string[];
  /** The quotes this pass drew, waiting for `render` to say which rows they took. */
  quotes: QuoteChip[];
  /** The blocks this pass drew, in row order: the fallback when the tokens cannot be read. */
  drawn: CodeBlock[];
}

const tokenKey = (token: { lang?: string; text: string }): string => `${token.lang ?? ""}\0${token.text}`;

/** Every fenced token in row order, with the ones inside a quote or a list item marked. */
function codeTokens(tokens: readonly any[] | undefined, nested = false, out: Array<{ token: any; nested: boolean }> = []): Array<{ token: any; nested: boolean }> {
  for (const token of tokens ?? []) {
    if (token.type === "code") out.push({ token, nested });
    else if (token.type === "blockquote") codeTokens(token.tokens, true, out);
    else if (token.type === "list") for (const item of token.items ?? []) codeTokens(item.tokens, true, out);
  }
  return out;
}

/**
 * Wrap this message's Markdown so its `code` tokens come back railed. Once per
 * component and per Markdown child, and only while tidy is drawing the reply.
 * Undefined means this pi has no `renderToken` to wrap.
 */
function codeBlocksFor(component: any, options: CodeBlockOptions): CodeBlocks | undefined {
  const markdown: any = ((component.contentContainer?.children ?? []) as any[]).find((child) => child instanceof Markdown);
  if (!markdown || typeof markdown.renderToken !== "function") return undefined;
  const installed: CodeHook | undefined = component[CODE];
  if (installed && installed.markdown === markdown) {
    installed.options = options;
    return installed;
  }
  const hook: CodeHook = { blocks: [], quoteSpans: [], quotes: [], built: new Map(), drawn: [], markdown, options };
  const renderToken = markdown.renderToken;
  const render = markdown.render;
  markdown.renderToken = function (this: unknown, token: any, width: number, next: unknown, context: unknown) {
    const lines = renderToken.call(this, token, width, next, context);
    if (!Array.isArray(lines)) return lines;
    if (token?.type === "code") {
      const railed = ruleCodeToken(lines, token, width, hook.options);
      if (!railed) return lines;
      hook.built.set(tokenKey(token), railed.block);
      hook.drawn.push(railed.block);
      return railed.lines;
    }
    // A quote is left as pi drew it; its chip goes in the cell in front of the border,
    // which only `render` can see, since Markdown adds that cell itself.
    if (token?.type === "blockquote") {
      const quote = quoteChip(lines, token, hook.options);
      if (quote) hook.quotes.push(quote);
    }
    return lines;
  };
  markdown.render = function (this: any, width: number) {
    const before = hook.blocks;
    hook.drawn = [];
    hook.quotes = [];
    const rows = render.call(this, width);
    // pi answers from its own cache once text and width settle: the same array comes
    // back, and the pass that filled it already put the chips on the rows.
    if (rows === hook.rows) {
      hook.blocks = before;
      return hook.out ?? rows;
    }
    hook.rows = rows;
    // pi-tui 1.5 reuses a block it has already drawn, so `renderToken` may not run for
    // a token that is on the rows. The tokens say what is there and in which order;
    // `built` says how each one was drawn.
    const tokens = codeTokens(markdown.cachedTokens?.deref()?.tokens);
    const walked: CodeBlock[] = [];
    for (const { token, nested } of tokens) {
      const block = hook.built.get(tokenKey(token));
      if (block) walked.push({ ...block, nested });
    }
    hook.blocks = walked.length === tokens.length && tokens.length ? walked : hook.drawn.length ? hook.drawn : before;
    const spliced = spliceQuoteChips(rows, hook.quotes, hook.options.theme);
    hook.quoteSpans = spliced.spans;
    hook.out = spliced.rows;
    return hook.out;
  };
  component[CODE] = hook;
  return hook;
}

/**
 * A code block's rule where nothing meets it. A frame's joint is the lead in front of the
 * language; without one, the label would start where the closing rule does (` fish ───`
 * over `──────`). A rule cell goes in at `at` and the row gives up its last rule cell, so
 * the block opens in the column it closes in: `─ fish ───`. Everything after `at` moves
 * one cell right, the chip with it (`RAIL_CHIP_SHIFT`).
 */
function leadRule(row: string, at: number, rule: string): string {
  const width = visibleWidth(row);
  return sliceByColumn(row, 0, at) + rule + sliceByColumn(row, at, Math.max(0, width - at - 2)) + sliceByColumn(row, width - 1, 1);
}
const RAIL_CHIP_SHIFT = 1;

/**
 * A rule in a message hanging on an open run joins the run's line on its left and runs
 * on to the row's end: `├─ fish ─── copy ──────`. Frames only: on a rail it keeps to
 * the text's column. The rows come back in place, so indexes still match.
 */
function railRules(body: readonly string[], rules: ReadonlySet<number>, theme: ThemeLike, color: string): string[] {
  const out = [...body];
  const glyph = paint(theme, color, RULE_GLYPH);
  for (const row of rules) {
    const line = out[row];
    if (line === undefined) continue;
    const lead = line.startsWith(ZONE_A) ? ZONE_A : "";
    const clean = lead ? line.slice(ZONE_A.length) : line;
    const width = visibleWidth(clean);
    // The rail and the Markdown's padding become `├─`; the rule keeps its own leading
    // space and the cells that are left.
    const content = sliceByColumn(clean, 2, Math.max(0, width - 3));
    const rest = Math.max(0, width - 2 - visibleWidth(content));
    out[row] = `${lead}${paint(theme, color, "├")}${glyph}${content}${glyph.repeat(rest)}`;
  }
  return out;
}

/** Whether a message has text to show: what cuts a group, and so starts a step of its own. */
function saysSomething(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
}

/** Decorate the existing message view, never a second markdown renderer. */
export function presentTurn(component: any, width: number, draw: (width: number, hideThinking?: boolean) => readonly string[]): readonly string[] {
  component[LAYOUT] = undefined;
  const options = turnOptions.get();
  if (!tidyEnabled.get() || (options.collapseTurns === "off" && !options.frameFinalReply)) return draw(width);
  const turn = turnFor(component.lastMessage);
  const theme = getTheme();
  if (!turn || !theme) return draw(width);
  const key = messageKey(component.lastMessage);
  const closed = options.collapseTurns !== "off" && folded(turn);
  // A folded turn forgets what was open inside it: the calls (see the tool frame)
  // and the thinking runs, so reopening it starts from the rows it opened with.
  if (closed) closeThinking(component);
  const visible = turn.outcome === "running" ? turn.latestText : turn.final ?? failedLast(turn);
  const header = options.collapseTurns !== "off" && key === turn.firstAssistant && hasProcess(turn);
  if (closed && key !== visible && !header) return [];
  const framed = options.frameFinalReply && turn.outcome !== "running" && key === turn.final && width >= 4;
  const railOpen = options.collapseTurns !== "off" && !closed && hasProcess(turn);
  const railed = messageOnRail(component);
  // Code blocks first: the hook has to be in place before the rows are drawn.
  const code = codeBlocksFor(component, {
    theme,
    icons: options.icons,
    enabled: options.codeBlocks,
    splitDiff: options.splitDiff,
    splitDiffMinWidth: options.splitDiffMinWidth,
    canCopy: canCopyText(),
    ruleColor: options.assistantColor,
  });
  const drawn = closed && key !== visible
    ? []
    : railed
      ? draw(Math.max(1, width - TURN_RAIL_CELLS))
      : draw(framed ? width - 2 : width, framed);
  const frame = options.replyStyle === "frame";
  // Measured before a rail goes on: once it is there, its `│` and a quote's border read alike.
  const ruled = code ? ruleRows(drawn, code.blocks) : { rules: [], spans: [], opens: new Map<number, number>() };
  const rules = new Set(ruled.rules);
  // On the run's line the chip moves past the line, and on a rail one cell more (`leadRule`).
  const shift = TURN_RAIL_CELLS + (frame ? 0 : RAIL_CHIP_SHIFT);
  const ruleSpans = railed ? ruled.spans.map((span) => ({ ...span, x: span.x + shift, end: span.end + shift })) : ruled.spans;
  // A quote's chip sits in the cell in front of its border, which no rule put anything
  // in front of: on a rail it lands one cell left of where a rule's chip does, so the
  // cell the pointer gives up for that (`RAIL_CHIP_SHIFT`) is handed back here.
  const quoteShift = (railed ? TURN_RAIL_CELLS : 0) - (framed && !frame ? RAIL_CHIP_SHIFT : 0);
  const quoteSpans = (code?.quoteSpans ?? []).map((span) => ({ ...span, x: span.x + quoteShift, end: span.end + quoteShift }));
  const spans = [...ruleSpans, ...quoteSpans];
  let body = railed ? railRows(drawn, theme) : drawn;
  // A message on the run's line has no box to turn into corners, so the joints are drawn here.
  if (railed && rules.size) {
    if (frame) body = railRules(body, rules, theme, options.assistantColor);
    else {
      const rule = paint(theme, options.assistantColor, RULE_GLYPH);
      body = body.map((row, index) => {
        if (!rules.has(index)) return row;
        const lead = row.startsWith(ZONE_A) ? ZONE_A : "";
        // The run's line, the text's inset, then the cell the lead goes in.
        return lead + leadRule(lead ? row.slice(ZONE_A.length) : row, TURN_RAIL_CELLS + 1, rule);
      });
    }
  }
  const flash = code?.flash;
  const labels = chipLabels(options.icons);
  // A chip is repainted where it is, so the rule around it keeps its cells.
  const hotIndex = code && isRowHovered(component, "row") ? code.hover : undefined;
  for (const span of spans) {
    const copied = Boolean(flash && Date.now() < flash.until && flash.index === span.index);
    if (!copied && hotIndex !== span.index) continue;
    body = repaintChip(body, span, theme, copied ? labels.copied : labels.copy, hotIndex === span.index);
  }
  // A run's first rows stand clear of your message, or, when nothing of yours started
  // it (a job's notification did), of the run before.
  const runGap = key === turn.firstAssistant ? (turn.root ? GAP_PART : GAP_RUN) : 0;
  // Inside the process, a step that says something — its thinking, its text, then the
  // calls it makes — stands one row clear of the step before it. A step with no text
  // has its thought inside the group of its calls, so it adds no gap of its own. The
  // reply is the last step and stands clear the same way; folded, there is no process
  // above it, and it sits right under the summary.
  const stepGap = !closed && key !== turn.firstAssistant && body.length > 0 && (framed ? hasProcess(turn) : saysSomething(component.lastMessage)) ? GAP_PART : 0;
  // A chip needs the layout and the handler below it; a message without one keeps the
  // fast path, since most rows in a transcript carry neither.
  if (!header && !framed && !spans.length && !runGap && !stepGap) return body;
  const hovered = header && isRowHovered(component, "turn-header");
  const line = header ? (hovered ? hoverBand(summaryLine(turn, theme, width, true), width, theme) : summaryLine(turn, theme, width)) : "";
  const color = options.assistantColor;
  const replyHeader = framed
    ? messageHeader(
        theme,
        color,
        // The one accent on a settled screen: whose answer this is, where the eye should land.
        theme.fg("accent", replyLabel(component.lastMessage.provider, component.lastMessage.model, options.icons)),
        replyTail(component.lastMessage, turn, theme, options),
        options.headerStyle,
        width,
      )
    : undefined;
  // The border needs `╭─ ` and ` ─╮` around the label; a longer model id
  // (one with its release date in it) has to lose cells, not the whole row.
  const label = replyHeader ? clipToWidth(replyHeader.label, Math.max(1, width - 6), "…") : "";
  const lead = replyHeader?.lead ?? 1;
  const cache = component[CACHE];
  const revision = optionsRevision();
  if (cache && cache.turn === turn && cache.width === width && cache.line === line && cache.label === label && cache.lead === lead && cache.color === color && cache.revision === revision && cache.framed === framed && cache.railOpen === railOpen && cache.runGap === runGap && cache.stepGap === stepGap && sameLines(cache.body, body)) {
    component[LAYOUT] = cache.layout;
    installMouse(component);
    return cache.out;
  }
  // A click on the chip copies the block it labels; every other click keeps going
  // to pi's own selection, because the chip is chrome the block's text never had.
  const copyClick = (event: TuiMouseEvent): boolean => {
    if (!code || event.type !== "click" || event.button !== "left") return false;
    // The click comes through `ReplyBody`'s padding already, but not through the cell a
    // rail's rule put in front of the chip (`leadRule`).
    const x = framed && !frame ? event.x - RAIL_CHIP_SHIFT : event.x;
    const span = spans.find((entry) => entry.row === event.y && x >= entry.x && x < entry.end);
    if (!span) return false;
    // A quote carries its own text; a code block is read back by its index.
    const text = span.text ?? code.blocks[span.index]?.text;
    if (text === undefined) return false;
    // Mark it now, not when the write settles: the click's own repaint is the one
    // that has to show `copied`, and a hover renderer may not exist in this mode.
    code.flash = { index: span.index, until: Date.now() + COPIED_MS };
    void copyText(text).catch(() => {
      if (code.flash?.index === span.index) code.flash = undefined;
    });
    setTimeout(() => {
      if (code.flash?.index !== span.index) return;
      code.flash = undefined;
      requestHoverRender();
    }, COPIED_MS).unref?.();
    return true;
  };
  const view = new Container();
  if (runGap) view.addChild(blankRows(runGap));
  if (header) view.addChild(new MouseRegion(new Text(line, 0, 0), (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    turn.open = folded(turn);
    return { handled: true, render: true };
  }));
  // On the run's line the gap carries the line, as every row of the process does.
  if (stepGap) view.addChild(blankRows(stepGap, railed || railOpen ? paint(theme, color, "│") : ""));
  const source = { render: () => body, invalidate() {}, handleMouse: (event: TuiMouseEvent) => {
    if (copyClick(event)) return { handled: true, render: true };
    if (component[NATIVE_VIEW]) return component[NATIVE_VIEW].handleMouse(event);
    const layout = component[LAYOUT];
    component[LAYOUT] = undefined;
    try { return component[BASE_MOUSE]?.call(component, event); }
    finally { component[LAYOUT] = layout; }
  } };
  if (framed) {
    // An open run's line comes down into the reply's corner and carries on down its
    // left edge to the bottom one: a frame's side, or the only vertical a rail has.
    const top = labeledTopBorder(width, theme, color, label, "left", lead, undefined, !frame);
    view.addChild(new Text(railOpen ? top.replace(frame ? "╭" : RULE_GLYPH, "├") : top, 0, 0));
    const box = new ReplyBody(theme, color, frame, frame || railOpen ? paint(theme, color, "│") : " ", rules);
    box.addChild(source);
    view.addChild(box);
    const bottom = frame ? `╰${"─".repeat(width - 2)}╯` : `${railOpen ? "╰" : RULE_GLYPH}${RULE_GLYPH.repeat(width - 1)}`;
    view.addChild(new Text(paint(theme, color, bottom), 0, 0));
  } else view.addChild(source);
  const out = view.render(width);
  // A body inside `ReplyBody` sits one cell right of the row: the pointer's column has
  // to come back through that padding before it is compared with a chip's. A rail's rule
  // moved its chip one cell more (`leadRule`).
  const chipShift = framed ? 1 + (frame ? 0 : RAIL_CHIP_SHIFT) : 0;
  const padding = framed && frame ? FRAME_PADDING_Y : 0;
  const bodyTop = runGap + (header ? 1 : 0) + stepGap + (framed ? 1 : 0) + padding;
  const layout = { view, header, headerRow: runGap, spans, bodyTop, chipShift };
  component[LAYOUT] = layout;
  component[CACHE] = { turn, width, line, label, lead, color, revision, framed, railOpen, runGap, stepGap, body, out, layout };
  installMouse(component);
  return out;
}
