/**
 * pi's own error rows — the ones that are not a tool result: a failed request,
 * an extension that threw, a provider that dropped blocks. It builds each as a
 * plain `ThemedText` (`Error: 429: {…}`) and appends it straight to the chat
 * container, once per retry attempt.
 *
 * Two things are wrong with that: the attempt count never changes the text, so
 * a retry storm leaves three identical rows carrying the provider's raw body;
 * and the row has no frame, unlike every other box in the transcript.
 *
 * So exactly one row survives: a repeat of the same text folds into it with a
 * `×N`, and that row wears the frame the rest of tidy's boxes wear. The rows
 * are transport state, not conversation, but they are also the only record
 * that a turn failed — dropping them all would leave the failure invisible.
 *
 * `ThemedText` is not exported and never reaches a class tidy could patch, so
 * the hook is the container: after `InteractiveMode.init`, the chat container
 * gets its own `addChild`. Rows not painted in the error colour (warnings,
 * notes, dim asides) pass through untouched — a billing notice is information,
 * and repeating one is a real event, not a retry.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type Component, Spacer, Text } from "@earendil-works/pi-tui";
import { drawFrame, labeledTopBorder, stripBackgroundFills, trimBlankEdges, visibleText } from "./frame-draw.ts";
import { liveSlot, tidyEnabled } from "./live.ts";
import { getTheme } from "./theme-access.ts";

export interface ErrorLineOptions {
  /** Fold a repeated error row into the first one as `×N`, and frame it. */
  enabled: boolean;
}

const errorLineOptions = liveSlot<ErrorLineOptions>("error-line-options", { enabled: true });

/** Marks a container already watching, so a second install can't double-wrap. */
const INSTALLED = Symbol.for("pi-tidy:error-lines");
const INIT_PATCH = Symbol.for("pi-tidy:error-lines-init");

export interface ChatContainerLike {
  children: Component[];
  addChild(child: Component): void;
}

/** Wide enough that a probe render says what the row holds, not how it wraps. */
const PROBE_WIDTH = 400;

/** The escape `theme.fg(color, …)` opens with, for prefix matching. */
function opener(color: string): string {
  const probe = getTheme()?.fg(color, "\u0000") ?? "";
  return probe.split("\u0000")[0] ?? "";
}

function rowsOf(component: Component): string[] {
  try {
    return component.render(PROBE_WIDTH).map(stripBackgroundFills);
  } catch {
    return [];
  }
}

/**
 * The colour a row is painted in, when it is one of pi's status rows: pi wraps
 * the whole line in a single `fg`, so the first visible row opens with it.
 */
function rowColor(rows: string[]): string | undefined {
  const row = rows.find((line) => visibleText(line).trim() !== "");
  if (!row) return undefined;
  const painted = row.trimStart();
  for (const color of ["error", "warning"]) {
    const prefix = opener(color);
    if (prefix && painted.startsWith(prefix)) return color;
  }
  return undefined;
}

function blankRows(rows: string[]): boolean {
  return rows.every((line) => visibleText(line).trim() === "");
}

/**
 * Watch one chat container. `addChild` is the only seam, and the rows keep
 * their identity: pi holds references to some of them (`removeChild` on the
 * previous status line), so a repeat is simply not added and the survivor gets
 * its own `render`.
 */
export function installErrorLines(container: ChatContainerLike): void {
  const target = container as ChatContainerLike & { [INSTALLED]?: boolean };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;

  const addChild = container.addChild.bind(container);
  let kept: Component | undefined;
  let keptText = "";
  let keptCount = 0;

  const reset = () => {
    kept = undefined;
    keptText = "";
    keptCount = 0;
  };

  const adopt = (child: Component, text: string) => {
    kept = child;
    keptText = text;
    keptCount = 1;
    const unpainted = child.render.bind(child);
    child.render = (width: number): string[] => {
      const theme = getTheme();
      const w = Math.max(4, width);
      const rows = trimBlankEdges(unpainted(Math.max(2, w - 2)).map(stripBackgroundFills));
      if (rows.length === 0) return [];
      // No theme yet: pi's shell hasn't painted anything either, so keep the
      // rows exactly as pi drew them rather than inventing colours.
      if (!theme) return rows;
      const framed = drawFrame(rows, w, theme, "error");
      const name = keptCount > 1 ? `error ×${keptCount}` : "error";
      framed[0] = labeledTopBorder(w, theme, "error", theme.fg("error", name));
      return framed;
    };
  };

  container.addChild = (child: Component) => {
    // Only pi's status rows (a `Text`) and the spacers between them can take
    // part, so nothing else is probed. A probe is a render outside the frame's
    // top-to-bottom pass, and the tool grouping reads that order: a probed tool
    // joined its group before the step that issued it (the step's thinking row
    // then hung above the summary line), and a probed message, not filled in
    // yet, read as a group boundary.
    if (!(child instanceof Text) && !(child instanceof Spacer)) {
      reset();
      addChild(child);
      return;
    }
    const rows = rowsOf(child);
    // Separators neither repeat nor break a repeat: pi may space two attempts
    // apart, and that should still read as one failure.
    if (rows.length > 0 && blankRows(rows)) {
      addChild(child);
      return;
    }
    const isErrorRow =
      tidyEnabled.get() && errorLineOptions.get().enabled && child instanceof Text && rowColor(rows) === "error";
    if (!isErrorRow) {
      reset();
      addChild(child);
      return;
    }
    const text = rows.map(visibleText).join("\n").trim();
    if (kept && keptText === text && container.children.includes(kept)) {
      keptCount++;
      return;
    }
    adopt(child, text);
    addChild(child);
  };
}

/**
 * pi's interactive mode owns the chat container and hands it to nobody, so the
 * instance is reached through `init`. A pi that renames that method leaves the
 * hook uninstalled: rows then render as pi draws them, which is the behaviour
 * before this patch and not a crash.
 */
export function patchErrorLines(options: ErrorLineOptions): void {
  errorLineOptions.set(options);
  const proto = (InteractiveMode as unknown as { prototype?: Record<string | symbol, unknown> }).prototype;
  if (!proto || proto[INIT_PATCH]) return;
  const original = proto.init;
  if (typeof original !== "function") return;
  const init = original as (...args: unknown[]) => unknown;
  proto[INIT_PATCH] = true;
  proto.init = function (this: { chatContainer?: ChatContainerLike }, ...args: unknown[]) {
    const install = () => {
      const chat = this?.chatContainer;
      if (chat && typeof chat.addChild === "function") installErrorLines(chat);
    };
    const result = init.apply(this, args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then((value) => {
        install();
        return value;
      });
    }
    install();
    return result;
  };
}
