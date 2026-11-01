import { Box, Container, MouseRegion, Text, sliceByColumn, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { labeledTopBorder, sameLines } from "./frame-draw.ts";
import { tidyEnabled } from "./live.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";
import { folded, messageKey, turnFor, turnOptions, turnStore, type Turn } from "./turn-state.ts";

const NATIVE_VIEW = Symbol.for("pi-toolbox:message-view");
export const TURN_LAYOUT = Symbol.for("pi-tidy:turn-layout");
const LAYOUT = TURN_LAYOUT;
const MOUSE = Symbol.for("pi-tidy:turn-mouse");
const BASE_MOUSE = Symbol.for("pi-tidy:turn-base-mouse");
const HOVER = Symbol.for("pi-tidy:turn-hover");
const CACHE = Symbol.for("pi-tidy:turn-cache");
// Nerd Fonts glyphnames.json: cod-openai, cod-claude, md-google; unknown providers use md-robot.
const PROVIDER_ICONS: Record<string, string> = {
  openai: "\uec81", "openai-codex": "\uec81", anthropic: "\uec82",
  google: "\u{f02ad}", "google-gemini-cli": "\u{f02ad}", "google-vertex": "\u{f02ad}",
};
export function replyLabel(provider: string | undefined, icons: boolean): string {
  return `${icons ? `${PROVIDER_ICONS[provider ?? ""] ?? "\u{f06a9}"} ` : ""}${provider || "agent"}`;
}
function duration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
export function hasProcess(turn: Turn): boolean {
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
  parts.push(theme.fg("toolTitle", `${turn.tools.size} calls`));
  const counts = new Map<string, number>();
  for (const { name } of turn.tools.values()) {
    const kind = name.startsWith("mcp__") ? "mcp" : name;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (const [name, count] of counts) parts.push(theme.fg("muted", `${name}×${count}`));
  return truncateToWidth(` ${parts.join(theme.fg("muted", " · "))}`, width, "…");
}

/** Box owns the horizontal mouse transform; its padding cells become border glyphs. */
class ReplyBody extends Box {
  private theme: ThemeLike;
  constructor(theme: ThemeLike) { super(1, 0); this.theme = theme; }
  override render(width: number): string[] {
    const border = this.theme.fg("accent", "│");
    return super.render(width).map((line) => border + sliceByColumn(line, 1, width - 2) + border);
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
    if (event.type === "move") this[HOVER] = !!hot;
    const result = layout.view.handleMouse(event);
    return changed ? { ...result, handled: true, render: true } : result;
  };
  (wrapped as any)[MOUSE] = true;
  component.handleMouse = wrapped;
}

/** Decorate the existing message view, never a second markdown renderer. */
export function presentTurn(component: any, width: number, draw: (width: number) => string[]): string[] {
  component[LAYOUT] = undefined;
  const options = turnOptions.get();
  if (!tidyEnabled.get() || (options.collapseTurns === "off" && !options.frameFinalReply)) return draw(width);
  const turn = turnFor(component.lastMessage);
  const theme = getTheme();
  if (!turn || !theme) return draw(width);
  const key = messageKey(component.lastMessage);
  const closed = options.collapseTurns !== "off" && folded(turn);
  const visible = turn.outcome === "running" ? turn.latestText : turn.final;
  const anchor = visible ?? turn.lastAssistant;
  const header = options.collapseTurns !== "off" && key === anchor && hasProcess(turn);
  if (closed && key !== visible && !header) return [];
  const framed = options.frameFinalReply && turn.outcome !== "running" && key === turn.final && width >= 4;
  const body = closed && key !== visible ? [] : draw(framed ? width - 2 : width);
  if (!header && !framed) return body;
  const line = header ? summaryLine(turn, theme, width, !!component[HOVER]) : "";
  const label = framed ? theme.fg("accent", replyLabel(component.lastMessage.provider, options.icons)) : "";
  const cache = component[CACHE];
  if (cache && cache.turn === turn && cache.width === width && cache.line === line && cache.label === label && cache.framed === framed && sameLines(cache.body, body)) {
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
    view.addChild(new Text(labeledTopBorder(width, theme, "accent", label), 0, 0));
    const box = new ReplyBody(theme);
    box.addChild(source);
    view.addChild(box);
    view.addChild(new Text(theme.fg("accent", `╰${"─".repeat(width - 2)}╯`), 0, 0));
  } else view.addChild(source);
  const out = view.render(width);
  const layout = { view, header };
  component[LAYOUT] = layout;
  component[CACHE] = { turn, width, line, label, framed, body, out, layout };
  installMouse(component);
  return out;
}
