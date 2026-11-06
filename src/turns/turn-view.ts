import { Box, Container, Markdown, MouseRegion, Text, sliceByColumn, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { clipToWidth, formatMessageTime, italicDim, labeledRule, labeledTopBorder, messageHeader, sameLines, visibleText } from "../draw/frame-draw.ts";
import { toolKindIcon } from "../draw/icons.ts";
import { canCopyText, copyText } from "../clipboard.ts";
import { COPIED_MS, chipAsCopied, chipSpans, decorateCodeToken, type CodeBlockOptions, type CodeBlocks } from "./code-blocks.ts";
import { paint } from "../draw/paint.ts";
import { tidyEnabled } from "../live.ts";
import { claimHover, hoverBand, isRowHovered, requestHoverRender } from "../hover.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { folded, messageKey, turnFor, turnOptions, turnStore, type Turn } from "./turn-state.ts";

const NATIVE_VIEW = Symbol.for("pi-toolbox:message-view");
export const TURN_LAYOUT = Symbol.for("pi-tidy:turn-layout");
const LAYOUT = TURN_LAYOUT;
const MOUSE = Symbol.for("pi-tidy:turn-mouse");
const BASE_MOUSE = Symbol.for("pi-tidy:turn-base-mouse");
const HOVER = Symbol.for("pi-tidy:turn-hover");
const CACHE = Symbol.for("pi-tidy:turn-cache");
// Nerd Fonts glyphnames.json: cod-openai, cod-claude, md-google; deepseek has no brand
// glyph in Nerd Fonts, so it uses the whale emoji; all others use md-robot.
const PROVIDER_ICONS: Record<string, string> = {
  openai: "\uec81", "openai-codex": "\uec81", anthropic: "\uec82",
  deepseek: "\u{1f433}",
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
  const cached = summaryCache.get(turn);
  if (cached && cached.version === turn.version && cached.tick === tick && cached.width === width && cached.hovered === hovered && cached.folded === isFolded && cached.color === color) {
    return cached.line;
  }
  const line = buildSummaryLine(turn, theme, width, hovered, now);
  summaryCache.set(turn, { version: turn.version, tick, width, hovered, folded: isFolded, color, line });
  return line;
}
const summaryCache = new WeakMap<Turn, { version: number | undefined; tick: number; width: number; hovered: boolean; folded: boolean; color: string; line: string }>();
function buildSummaryLine(turn: Turn, theme: ThemeLike, width: number, hovered: boolean, now = Date.now()): string {
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
  add(paint(theme, turnOptions.get().assistantColor, `${marker} ${state === "running" ? "running" : "took"} ${duration(total)}`));
  if (!["completed", "running", "unknown"].includes(state)) add(theme.fg("error", state));
  const llmFailures = [...turn.messages.values()].filter((message) => message.role === "assistant" && message.stopReason === "error").length;
  if (llmFailures) add(theme.fg("error", `${llmFailures} LLM failed`));
  const failed = [...turn.tools.values()].filter((tool) => tool.failed).length;
  if (failed) add(theme.fg("error", `${failed} failed`));
  const nestedFailed = [...turn.tools.values()].reduce((sum, tool) => sum + (tool.nestedFailed ?? 0), 0);
  if (nestedFailed) add(theme.fg("error", `${nestedFailed} nested failed`));
  // The glyph is the one the reply's border uses, so both lines name the same vendor.
  const answer = turn.messages.get(turn.final ?? turn.lastAssistant ?? "");
  const llm = `LLM ${duration(store.llmTime(turn, now))}`;
  add(theme.fg("muted", llm), theme.fg("muted", `${providerIcon(answer?.provider)} ${llm}`));
  add(theme.fg("muted", `tools ${duration(store.toolTime(turn, now))}`));
  // Open, the group headers below already count the calls.
  if (folded(turn)) {
    add(theme.fg("toolTitle", `${turn.tools.size} calls`));
    const counts = new Map<string, number>();
    for (const { name } of turn.tools.values()) {
      const kind = name.startsWith("mcp__") ? "mcp" : name;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const [name, count] of counts) add(theme.fg("muted", `${name}×${count}`), theme.fg("muted", `${toolKindIcon(name)} ${name}×${count}`));
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

/** Box owns the horizontal mouse transform; its padding cells become border glyphs. */
const ZONE_A = "\x1b]133;A\x07";
const ZONE_MARKERS = /\x1b\]133;[ABC]\x07/g;
class ReplyBody extends Box {
  private theme: ThemeLike;
  private color: string;
  private closed: boolean;
  /** `closed` draws the right border too; a rail has only the left one. */
  constructor(theme: ThemeLike, color: string, closed: boolean) { super(1, 0); this.theme = theme; this.color = color; this.closed = closed; }
  override render(width: number): string[] {
    const border = paint(this.theme, this.color, "│");
    return super.render(width).map((line) => {
      // pi's OSC 133 zones belong at the row's edges. The frame used to leave
      // them inside: zone A landed after the left border, and B/C before the
      // right one. Terminals that cache semantic prompts then misrender the
      // marked rows, so keep A before the border and B/C after it.
      const markers = line.match(ZONE_MARKERS) ?? [];
      const clean = markers.length ? line.replace(ZONE_MARKERS, "") : line;
      const start = markers.filter((marker) => marker === ZONE_A).join("");
      const end = markers.filter((marker) => marker !== ZONE_A).join("");
      return start + border + sliceByColumn(clean, 1, width - 2) + (this.closed ? border : "") + end;
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
    const hot = event.type === "move" && layout.header && event.y === 0;
    const changed = event.type === "move" && !!this[HOVER] !== !!hot;
    if (event.type === "move") {
      this[HOVER] = !!hot;
      const stateChanged = hot ? claimHover(this, "turn-header") : claimHover(null, null);
      if (changed || stateChanged) requestHoverRender();
    }
    const result = layout.view.handleMouse(event);
    return changed ? { ...result, handled: true, render: true } : result;
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
  const hook: CodeHook = { blocks: [], markdown, options };
  const renderToken = markdown.renderToken;
  const render = markdown.render;
  markdown.renderToken = function (this: unknown, token: any, width: number, next: unknown, context: unknown) {
    const lines = renderToken.call(this, token, width, next, context);
    if (token?.type !== "code" || !Array.isArray(lines)) return lines;
    const railed = decorateCodeToken(lines, token, width, hook.options);
    if (!railed) return lines;
    hook.blocks.push(railed.block);
    return railed.lines;
  };
  markdown.render = function (this: unknown, width: number) {
    const before = hook.blocks;
    hook.blocks = [];
    const rows = render.call(this, width);
    // pi answers from its own cache once text and width settle, and then
    // `renderToken` never ran: the blocks from the pass that filled it still
    // describe the rows it just handed back.
    if (!hook.blocks.length) hook.blocks = before;
    return rows;
  };
  component[CODE] = hook;
  return hook;
}

/** Decorate the existing message view, never a second markdown renderer. */
export function presentTurn(component: any, width: number, draw: (width: number, hideThinking?: boolean) => string[]): string[] {
  component[LAYOUT] = undefined;
  const options = turnOptions.get();
  if (!tidyEnabled.get() || (options.collapseTurns === "off" && !options.frameFinalReply)) return draw(width);
  const turn = turnFor(component.lastMessage);
  const theme = getTheme();
  if (!turn || !theme) return draw(width);
  const key = messageKey(component.lastMessage);
  const closed = options.collapseTurns !== "off" && folded(turn);
  const visible = turn.outcome === "running" ? turn.latestText : turn.final ?? failedLast(turn);
  const header = options.collapseTurns !== "off" && key === turn.firstAssistant && hasProcess(turn);
  if (closed && key !== visible && !header) return [];
  const framed = options.frameFinalReply && turn.outcome !== "running" && key === turn.final && width >= 4;
  const railOpen = options.collapseTurns !== "off" && !closed && hasProcess(turn);
  const railed = messageOnRail(component);
  // Code blocks first: the hook has to be in place before the rows are drawn.
  const code = codeBlocksFor(component, {
    theme,
    enabled: options.codeBlocks,
    splitDiff: options.splitDiff,
    splitDiffMinWidth: options.splitDiffMinWidth,
    canCopy: canCopyText(),
  });
  let body = closed && key !== visible
    ? []
    : railed
      ? railRows(draw(Math.max(1, width - TURN_RAIL_CELLS)), theme)
      : draw(framed && options.replyStyle !== "rules" ? width - 2 : width, framed);
  const spans = code ? chipSpans(body, code.blocks) : [];
  const flash = code?.flash;
  if (flash && Date.now() < flash.until) {
    const span = spans.find((entry) => entry.index === flash.index);
    if (span) body = chipAsCopied(body, span, theme);
  }
  if (!header && !framed) return body;
  const hovered = header && isRowHovered(component, "turn-header");
  const line = header ? (hovered ? hoverBand(summaryLine(turn, theme, width, true), width, theme) : summaryLine(turn, theme, width)) : "";
  const color = options.assistantColor;
  const replyHeader = framed
    ? messageHeader(
        theme,
        color,
        paint(theme, color, replyLabel(component.lastMessage.provider, component.lastMessage.model, options.icons)),
        typeof component.lastMessage.timestamp === "number" ? italicDim(theme, formatMessageTime(component.lastMessage.timestamp, options.timeFormat)) : "",
        options.headerStyle,
        width,
      )
    : undefined;
  // The border needs `╭─ ` and ` ─╮` around the label; a longer model id
  // (one with its release date in it) has to lose cells, not the whole row.
  const label = replyHeader ? clipToWidth(replyHeader.label, Math.max(1, width - 6), "…") : "";
  const lead = replyHeader?.lead ?? 1;
  const cache = component[CACHE];
  if (cache && cache.turn === turn && cache.width === width && cache.line === line && cache.label === label && cache.lead === lead && cache.color === color && cache.replyStyle === options.replyStyle && cache.framed === framed && cache.railOpen === railOpen && sameLines(cache.body, body)) {
    component[LAYOUT] = cache.layout;
    installMouse(component);
    return cache.out;
  }
  // A click on the chip copies the block it labels; every other click keeps going
  // to pi's own selection, because the chip is chrome the block's text never had.
  const copyClick = (event: TuiMouseEvent): boolean => {
    if (!code || event.type !== "click" || event.button !== "left") return false;
    const span = spans.find((entry) => entry.row === event.y && event.x >= entry.x && event.x < entry.end);
    if (!span) return false;
    const text = code.blocks[span.index]!.text;
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
  if (header) view.addChild(new MouseRegion(new Text(line, 0, 0), (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    turn.open = folded(turn);
    return { handled: true, render: true };
  }));
  const source = { render: () => body, invalidate() {}, handleMouse: (event: TuiMouseEvent) => {
    if (copyClick(event)) return { handled: true, render: true };
    if (component[NATIVE_VIEW]) return component[NATIVE_VIEW].handleMouse(event);
    const layout = component[LAYOUT];
    component[LAYOUT] = undefined;
    try { return component[BASE_MOUSE]?.call(component, event); }
    finally { component[LAYOUT] = layout; }
  } };
  if (framed) {
    // The rail comes down into the reply's corner and carries on as its left border.
    const flat = options.replyStyle !== "frame";
    const top = flat
      ? labeledRule(width, theme, color, label, "left", lead).replace("─", railOpen ? "├" : "─")
      : labeledTopBorder(width, theme, color, label, "left", lead).replace("╭", railOpen ? "├" : "╭");
    view.addChild(new Text(top, 0, 0));
    if (options.replyStyle === "rules") view.addChild(source);
    else {
      const box = new ReplyBody(theme, color, !flat);
      box.addChild(source);
      view.addChild(box);
    }
    view.addChild(new Text(paint(theme, color, flat ? "─".repeat(width) : `╰${"─".repeat(width - 2)}╯`), 0, 0));
  } else view.addChild(source);
  const out = view.render(width);
  const layout = { view, header };
  component[LAYOUT] = layout;
  component[CACHE] = { turn, width, line, label, lead, color, replyStyle: options.replyStyle, framed, railOpen, body, out, layout };
  installMouse(component);
  return out;
}
