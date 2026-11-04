import { Box, Container, MouseRegion, Text, sliceByColumn, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { clipToWidth, formatMessageTime, italicDim, labeledTopBorder, sameLines, visibleText } from "../draw/frame-draw.ts";
import { tidyEnabled } from "../live.ts";
import { claimHover, hoverBand, isRowHovered, requestHoverRender } from "../tools/tool-group-view.ts";
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
export function replyLabel(provider: string | undefined, model: string | undefined, icons: boolean): string {
  // The glyph still says which provider answered; the word next to it is what
  // the reader is comparing across replies — the model, not the vendor.
  return `${icons ? `${PROVIDER_ICONS[provider ?? ""] ?? "\u{f06a9}"} ` : ""}${model || provider || "agent"}`;
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
  const cached = summaryCache.get(turn);
  if (cached && cached.version === turn.version && cached.tick === tick && cached.width === width && cached.hovered === hovered && cached.folded === isFolded) {
    return cached.line;
  }
  const line = buildSummaryLine(turn, theme, width, hovered, now);
  summaryCache.set(turn, { version: turn.version, tick, width, hovered, folded: isFolded, line });
  return line;
}
const summaryCache = new WeakMap<Turn, { version: number | undefined; tick: number; width: number; hovered: boolean; folded: boolean; line: string }>();
function buildSummaryLine(turn: Turn, theme: ThemeLike, width: number, hovered: boolean, now = Date.now()): string {
  const store = turnStore.get();
  const total = turn.startedAt === undefined ? undefined : (turn.endedAt ?? now) - turn.startedAt;
  const state = turn.outcome;
  const marker = folded(turn) ? hovered ? "▶" : "▸" : "▾";
  const parts = [theme.fg("accent", `${marker} ${state === "running" ? "running" : "took"} ${duration(total)}`)];
  if (!["completed", "running", "unknown"].includes(state)) parts.push(theme.fg("error", state));
  const llmFailures = [...turn.messages.values()].filter((message) => message.role === "assistant" && message.stopReason === "error").length;
  if (llmFailures) parts.push(theme.fg("error", `${llmFailures} LLM failed`));
  const failed = [...turn.tools.values()].filter((tool) => tool.failed).length;
  if (failed) parts.push(theme.fg("error", `${failed} failed`));
  const nestedFailed = [...turn.tools.values()].reduce((sum, tool) => sum + (tool.nestedFailed ?? 0), 0);
  if (nestedFailed) parts.push(theme.fg("error", `${nestedFailed} nested failed`));
  parts.push(theme.fg("muted", `LLM ${duration(store.llmTime(turn, now))}`));
  parts.push(theme.fg("muted", `tools ${duration(store.toolTime(turn, now))}`));
  // Open, the group headers below already count the calls.
  if (folded(turn)) {
    parts.push(theme.fg("toolTitle", `${turn.tools.size} calls`));
    const counts = new Map<string, number>();
    for (const { name } of turn.tools.values()) {
      const kind = name.startsWith("mcp__") ? "mcp" : name;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const [name, count] of counts) parts.push(theme.fg("muted", `${name}×${count}`));
  }
  return clipToWidth(parts.join(theme.fg("muted", " · ")), width, "…");
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
  const rail = `${theme.fg("accent", "│")}${pad}`;
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
  constructor(theme: ThemeLike) { super(1, 0); this.theme = theme; }
  override render(width: number): string[] {
    const border = this.theme.fg("accent", "│");
    return super.render(width).map((line) => {
      // pi's OSC 133 zones belong at the row's edges. The frame used to leave
      // them inside: zone A landed after the left border, and B/C before the
      // right one. Terminals that cache semantic prompts then misrender the
      // marked rows, so keep A before the border and B/C after it.
      const markers = line.match(ZONE_MARKERS) ?? [];
      const clean = markers.length ? line.replace(ZONE_MARKERS, "") : line;
      const start = markers.filter((marker) => marker === ZONE_A).join("");
      const end = markers.filter((marker) => marker !== ZONE_A).join("");
      return start + border + sliceByColumn(clean, 1, width - 2) + border + end;
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
  const body = closed && key !== visible
    ? []
    : railed
      ? railRows(draw(Math.max(1, width - TURN_RAIL_CELLS)), theme)
      : draw(framed ? width - 2 : width, framed);
  if (!header && !framed) return body;
  const hovered = header && isRowHovered(component, "turn-header");
  const line = header ? (hovered ? hoverBand(summaryLine(turn, theme, width, true), width, theme) : summaryLine(turn, theme, width)) : "";
  const label = framed
    ? clipToWidth(
        theme.fg("accent", replyLabel(component.lastMessage.provider, component.lastMessage.model, options.icons)) +
          (typeof component.lastMessage.timestamp === "number" ? ` ${italicDim(theme, formatMessageTime(component.lastMessage.timestamp))}` : ""),
        // The border needs `╭─ ` and ` ─╮` around the label; a longer model id
        // (one with its release date in it) has to lose cells, not the whole row.
        Math.max(1, width - 6),
        "…",
      )
    : "";
  const cache = component[CACHE];
  if (cache && cache.turn === turn && cache.width === width && cache.line === line && cache.label === label && cache.framed === framed && cache.railOpen === railOpen && sameLines(cache.body, body)) {
    component[LAYOUT] = cache.layout;
    installMouse(component);
    return cache.out;
  }
  const view = new Container();
  if (header) view.addChild(new MouseRegion(new Text(line, 0, 0), (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    turn.open = folded(turn);
    return { handled: true, render: true };
  }));
  const source = { render: () => body, invalidate() {}, handleMouse: (event: TuiMouseEvent) => {
    if (component[NATIVE_VIEW]) return component[NATIVE_VIEW].handleMouse(event);
    const layout = component[LAYOUT];
    component[LAYOUT] = undefined;
    try { return component[BASE_MOUSE]?.call(component, event); }
    finally { component[LAYOUT] = layout; }
  } };
  if (framed) {
    // The rail comes down into the reply's corner and carries on as its left border.
    const top = labeledTopBorder(width, theme, "accent", label);
    view.addChild(new Text(railOpen ? top.replace("╭", "├") : top, 0, 0));
    const box = new ReplyBody(theme);
    box.addChild(source);
    view.addChild(box);
    view.addChild(new Text(theme.fg("accent", `╰${"─".repeat(width - 2)}╯`), 0, 0));
  } else view.addChild(source);
  const out = view.render(width);
  const layout = { view, header };
  component[LAYOUT] = layout;
  component[CACHE] = { turn, width, line, label, framed, railOpen, body, out, layout };
  installMouse(component);
  return out;
}
