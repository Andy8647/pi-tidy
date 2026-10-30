/**
 * User messages as a rail: a full-width rule above and below, an accent `│`
 * in front of every content row, and — with `icons` — the user icon in front
 * of the text, the way tidy's other boxes lead with their kind's icon. Rows
 * after the first hang under the text, not under the icon.
 *
 * pi's UserMessageComponent is one Markdown child that already carries the
 * markdown theme, pi's markdown options and the registered markdown
 * transformers (pi-ide-context's selection references among them). The rail
 * renders that child one cell narrower and replaces only its chrome — the
 * background fill and the blank padding rows — so the text pipeline stays
 * pi's own.
 *
 * `userMessageStyle: "frame"` is drawn by message-frame.ts instead; this patch
 * passes through for every style but "rail", so the two stack in either order.
 */

import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { sameLines, stripBackgroundFills, trimBlankEdges } from "./frame-draw.ts";
import { MESSAGE_ICONS } from "./icons.ts";
import { liveSlot, tidyEnabled } from "./live.ts";
import { paint } from "./paint.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";

export type UserMessageStyle = "rail" | "frame" | "off";

export interface UserMessageOptions {
  style: UserMessageStyle;
  /** Theme color name or `#rrggbb`. */
  railColor: string;
  /** Theme color name or `#rrggbb`. */
  ruleColor: string;
  /** Rail-only rows between each rule and the text. */
  paddingY: number;
  /** The user icon in front of the text (`tidy.icons`). */
  icons: boolean;
}

/**
 * The rail glyph is fixed: pi-starline's clean copy recognises user message
 * rows by it and strips it from the clipboard.
 */
export const USER_RAIL_GLYPH = "│";

// OSC 133 zone markers pi puts on the first/last line — terminals use them for
// prompt navigation, so the rail keeps them in the same positions.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface UserMessageInternals {
  children: Array<{ render(width: number): string[] }>;
  /** Horizontal padding pi gives the Markdown child (1 by default). */
  outputPad?: number;
  render(width: number): string[];
  __tidyRailCache?: { width: number; sample: string; paddingY: number; icons: boolean; raw: string[]; out: string[] };
}

const userMessageOptions = liveSlot<UserMessageOptions | undefined>("user-message-options", undefined);

function renderRail(
  component: UserMessageInternals,
  width: number,
  theme: ThemeLike,
  options: UserMessageOptions,
): string[] | undefined {
  // Row layout: rail, a space, [icon, a space], text. The child pads its text
  // by `outputPad` on both sides; one cell of that on the left is taken off
  // again, so it renders that much wider than the text it holds.
  const childPad = (component.outputPad ?? 1) > 0;
  const iconCells = options.icons ? 2 : 0;
  const textWidth = width - 2 - iconCells;
  const raw: string[] = [];
  for (const child of component.children) raw.push(...child.render(textWidth + (childPad ? 1 : 0)));

  const rail = paint(theme, options.railColor, USER_RAIL_GLYPH);
  const icon = options.icons ? `${paint(theme, options.railColor, MESSAGE_ICONS.user)} ` : "";
  const hang = " ".repeat(iconCells);
  const rule = paint(theme, options.ruleColor, "─".repeat(width));
  // The painted cells double as a theme sample: a theme switch with identical
  // content must not hit the cache.
  const sample = rail + rule;
  const cache = component.__tidyRailCache;
  if (
    cache &&
    cache.width === width &&
    cache.sample === sample &&
    cache.paddingY === options.paddingY &&
    cache.icons === options.icons &&
    sameLines(cache.raw, raw)
  )
    return cache.out;

  const content = trimBlankEdges(raw.map(stripBackgroundFills));
  if (content.length === 0) return undefined;

  const padRows = Array.from({ length: options.paddingY }, () => rail);
  const rows = content.map((line, index) => {
    const text = childPad && line.startsWith(" ") ? line.slice(1) : line;
    return `${rail} ${index === 0 ? icon : hang}${text}`;
  });
  const out = [rule, ...padRows, ...rows, ...padRows, rule];
  out[0] = OSC133_ZONE_START + out[0];
  out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
  component.__tidyRailCache = { width, sample, paddingY: options.paddingY, icons: options.icons, raw, out };
  return out;
}

/**
 * Install the rail patch once; later calls (a `/reload`) only update the
 * options it reads. Any style but "rail", `tidy.enabled: false`, a missing
 * theme or a render error falls through to the render underneath.
 */
export function patchUserMessages(options: UserMessageOptions): void {
  userMessageOptions.set(options);
  const proto = UserMessageComponent.prototype as unknown as UserMessageInternals & { __tidyUserRail?: boolean };
  if (proto.__tidyUserRail) return;
  proto.__tidyUserRail = true;

  const originalRender = proto.render;
  proto.render = function (this: UserMessageInternals, width: number): string[] {
    const live = userMessageOptions.get();
    const theme = getTheme();
    if (!theme || live?.style !== "rail" || !tidyEnabled.get() || width < 6) {
      return originalRender.call(this, width);
    }
    try {
      return renderRail(this, width, theme, live) ?? originalRender.call(this, width);
    } catch {
      return originalRender.call(this, width);
    }
  };
}
