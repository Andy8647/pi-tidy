/**
 * Interactive `/tidy settings` popup.
 *
 * Previews changes against a copy of `settings.tidy` so cycling an option
 * updates the transcript behind the overlay right away, while `Esc` restores
 * the pre-popup configuration without touching `settings.json`. Only keys the
 * user actually changed are merged into `settings.tidy` on save.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  getSelectPageIndex,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  parseConfig,
  readRawTidySettings,
  saveTidySettings,
  settingsPath,
  type TidyConfig,
} from "./config.ts";
import { clipToWidth, drawFrame, labeledTopBorder, shortenPath } from "./draw/frame-draw.ts";
import type { ThemeLike } from "./theme-access.ts";

/** Sentinel for surface styles (`userMessageStyle`, `finalReplyStyle`) when unset in `settings.tidy`. */
export const FOLLOW_STYLE = "__follow_style__";

export type SettingValue = boolean | number | string;

export interface TidySettingSpec {
  id: keyof TidyConfig;
  description: string;
  choices(current: SettingValue): SettingValue[];
  readInitial(raw: Record<string, unknown>, config: TidyConfig): SettingValue;
  applyToRaw(raw: Record<string, unknown>, value: SettingValue): void;
  writePatch(patch: Record<string, unknown>, value: SettingValue): void;
  format(value: SettingValue, config: TidyConfig): string;
}

function booleanSpec(id: keyof TidyConfig, description: string): TidySettingSpec {
  return {
    id,
    description,
    choices: () => [true, false],
    readInitial: (_raw, config) => Boolean(config[id]),
    applyToRaw: (raw, value) => {
      raw[id] = Boolean(value);
    },
    writePatch: (patch, value) => {
      patch[id] = Boolean(value);
    },
    format: (value) => String(value),
  };
}

function enumSpec(id: keyof TidyConfig, values: readonly string[], description: string): TidySettingSpec {
  return {
    id,
    description,
    choices: () => [...values],
    readInitial: (_raw, config) => String(config[id]),
    applyToRaw: (raw, value) => {
      raw[id] = String(value);
    },
    writePatch: (patch, value) => {
      patch[id] = String(value);
    },
    format: (value) => String(value),
  };
}

function numberSpec(id: keyof TidyConfig, presets: readonly number[], description: string): TidySettingSpec {
  return {
    id,
    description,
    choices: (current) => {
      const num = typeof current === "number" && Number.isFinite(current) ? current : undefined;
      const merged = num !== undefined && !presets.includes(num) ? [...presets, num].sort((a, b) => a - b) : [...presets];
      return merged;
    },
    readInitial: (_raw, config) => Number(config[id]),
    applyToRaw: (raw, value) => {
      raw[id] = Number(value);
    },
    writePatch: (patch, value) => {
      patch[id] = Number(value);
    },
    format: (value) => String(value),
  };
}

function surfaceStyleValue(rawValue: unknown): "rail" | "frame" | "off" | undefined {
  if (rawValue === "rules") return "rail";
  return rawValue === "rail" || rawValue === "frame" || rawValue === "off" ? rawValue : undefined;
}

function surfaceSpec(id: "userMessageStyle" | "finalReplyStyle", description: string): TidySettingSpec {
  return {
    id,
    description,
    choices: () => [FOLLOW_STYLE, "rail", "frame", "off"],
    readInitial: (raw) => {
      const explicit = surfaceStyleValue(raw[id]);
      if (explicit) return explicit;
      if (id === "finalReplyStyle" && typeof raw.frameFinalReply === "boolean") {
        return raw.frameFinalReply ? "frame" : "off";
      }
      return FOLLOW_STYLE;
    },
    applyToRaw: (raw, value) => {
      if (value === FOLLOW_STYLE) {
        delete raw[id];
      } else {
        raw[id] = value;
      }
      if (id === "finalReplyStyle") delete raw.frameFinalReply;
    },
    writePatch: (patch, value) => {
      patch[id] = value === FOLLOW_STYLE ? undefined : value;
      if (id === "finalReplyStyle") patch.frameFinalReply = undefined;
    },
    format: (value, config) => (value === FOLLOW_STYLE ? `follow style (${config.style})` : String(value)),
  };
}

export const TIDY_SETTINGS: readonly TidySettingSpec[] = [
  enumSpec("collapseTurns", ["afterRun", "live", "off"], "Fold a run's process to one summary line (afterRun, live while streaming, or off)"),
  booleanSpec("groupTools", "Fold consecutive tool calls within a step into one summary line"),
  enumSpec("style", ["rail", "frame"], "How surfaces are edged: rail (top and bottom rules) or frame (rounded box)"),
  numberSpec("bashResultLines", [0, 1, 2, 3, 5, 10], "Collapsed bash output preview height in visual lines (0 hides output until expanded)"),
  booleanSpec("groupOpen", "Start each new tool group open (one row per call) instead of folded"),
  numberSpec("toolRowLines", [1, 2], "Rows a call in an open tool group may occupy before truncating"),
  numberSpec("writeLines", [0, 2, 5, 10, 20], "Collapsed write file preview height in visual lines (0 keeps header only)"),
  booleanSpec("splitDiff", "Render edit diffs and fenced diff blocks as side-by-side panes"),
  numberSpec("diffLines", [0, 3, 5, 10, 20, 40], "Collapsed split-diff body height in rows"),
  numberSpec("diffContext", [0, 1, 2, 3, 4], "Unchanged context lines kept on each side of an edit change (0–4)"),
  surfaceSpec("finalReplyStyle", "Final assistant reply edge style (follows style when unset, or off for pi's default)"),
  surfaceSpec("userMessageStyle", "Your message edge style (follows style when unset, or off for pi's default)"),
  booleanSpec("userMessageFill", "Extend user message edges across the full width instead of hugging text"),
  enumSpec("userMessageAlign", ["left", "right"], "Horizontal alignment of framed or railed user messages"),
  booleanSpec("userMessageTime", "Show message timestamp next to the user icon"),
  enumSpec("messageHeaderStyle", ["inline", "split"], "Message top edge label layout: inline or split with a rule before time"),
  booleanSpec("replyMetrics", "Show mean TTFT and output tok/s next to the time in the final reply's top edge"),
  booleanSpec("icons", "Show Nerd Font icons on boxes, rows, message labels, and copy chips"),
  booleanSpec("highlightBash", "Syntax-highlight bash commands and inline shell, Python, or Node payloads"),
  booleanSpec("codeBlocks", "Draw fenced code blocks in replies with labelled rules and a copy chip"),
  booleanSpec("renderMarkdown", "Render Markdown files in write previews and expanded read results"),
  booleanSpec("renderLatex", "Highlight LaTeX files and render bare display-math environments"),
  booleanSpec("hexSwatches", "Paint a colored dot in front of hex, rgb(), and hsl() colors in messages"),
  booleanSpec("frameMessages", "Style compaction, branch, custom extension messages, and ! bash runs"),
  booleanSpec("dedupeErrors", "Fold repeated retry error rows into one framed row with ×N"),
  booleanSpec("cleanCopy", "Strip tidy frames and rails when copying fullscreen selections"),
  booleanSpec("backgroundJobs", "Show live pi-processes job status on the tool row that started it"),
  booleanSpec("hideJobNotifications", "Fold background job notification messages into their tool row"),
  booleanSpec("enabled", "Enable pi-tidy across the transcript"),
];

export interface SettingsPopupCallbacks {
  onPreview(config: TidyConfig): void;
  needsReload(config: TidyConfig): boolean;
  save?(patch: Record<string, unknown>): TidyConfig;
}

export type SettingsPopupResult =
  | { action: "saved"; changedKeys: string[]; config: TidyConfig; reloadNeeded: boolean }
  | { action: "cancelled" }
  | { action: "error"; message: string };

interface SettingRowState {
  spec: TidySettingSpec;
  initial: SettingValue;
  current: SettingValue;
  choices: SettingValue[];
}

export class TidySettingsPopup implements Component {
  readonly capturesViewportInput = true;
  private readonly tui: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
  private readonly theme: ThemeLike;
  private readonly callbacks: SettingsPopupCallbacks;
  private readonly done: (result: SettingsPopupResult) => void;
  private readonly initialConfig: TidyConfig;
  private readonly draftRaw: Record<string, unknown>;
  private readonly rows: SettingRowState[];
  private filteredRows: SettingRowState[];
  private selectedIndex = 0;
  private pressedRowIndex: number | undefined;
  private query = "";
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private listStartRow = 1;
  private visibleStartIndex = 0;
  private visibleEndIndex = 0;

  constructor(
    rawTidy: Record<string, unknown>,
    tui: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } },
    theme: ThemeLike,
    callbacks: SettingsPopupCallbacks,
    done: (result: SettingsPopupResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.done = done;
    this.draftRaw = { ...rawTidy };
    this.initialConfig = parseConfig(this.draftRaw);
    this.rows = TIDY_SETTINGS.map((spec) => {
      const initial = spec.readInitial(rawTidy, this.initialConfig);
      return {
        spec,
        initial,
        current: initial,
        choices: spec.choices(initial),
      };
    });
    this.filteredRows = [...this.rows];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const row of this.rows) {
      if (row.current !== row.initial) {
        row.spec.writePatch(patch, row.current);
      }
    }
    return patch;
  }

  changedKeys(): string[] {
    return this.rows.filter((row) => row.current !== row.initial).map((row) => String(row.spec.id));
  }

  private draftConfig(): TidyConfig {
    return parseConfig(this.draftRaw);
  }

  private maxVisibleItems(): number {
    const termRows = this.tui.terminal?.rows ?? 30;
    // Borders (2) + optional filter (2) + scroll/description/footer (~6) + margin (2).
    return Math.max(4, Math.min(12, termRows - 11));
  }

  private updateFilter(nextQuery: string): void {
    this.query = nextQuery;
    this.filteredRows = nextQuery
      ? fuzzyFilter(this.rows, nextQuery, (row) => `${String(row.spec.id)} ${row.spec.description}`)
      : [...this.rows];
    this.selectedIndex = 0;
  }

  private cycleRow(row: SettingRowState | undefined, delta: 1 | -1): void {
    if (!row || row.choices.length === 0) return;
    const index = row.choices.indexOf(row.current);
    const nextIndex = index < 0 ? 0 : (index + delta + row.choices.length) % row.choices.length;
    const nextValue = row.choices[nextIndex]!;
    if (nextValue === row.current) return;
    row.current = nextValue;
    row.spec.applyToRaw(this.draftRaw, nextValue);
    this.callbacks.onPreview(this.draftConfig());
  }

  private finishCancel(): void {
    this.callbacks.onPreview(this.initialConfig);
    this.done({ action: "cancelled" });
  }

  private finishSave(): void {
    const patch = this.buildPatch();
    const changedKeys = this.changedKeys();
    if (changedKeys.length === 0) {
      this.done({
        action: "saved",
        changedKeys: [],
        config: this.initialConfig,
        reloadNeeded: false,
      });
      return;
    }
    try {
      const saveFn = this.callbacks.save ?? saveTidySettings;
      const savedConfig = saveFn(patch);
      this.callbacks.onPreview(savedConfig);
      this.done({
        action: "saved",
        changedKeys,
        config: savedConfig,
        reloadNeeded: this.callbacks.needsReload(savedConfig),
      });
    } catch (error) {
      this.callbacks.onPreview(this.initialConfig);
      const detail = error instanceof Error ? error.message : String(error);
      this.done({ action: "error", message: detail });
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (matchesKey(data, "ctrl+c") || kb.matches(data, "tui.select.cancel")) {
      this.finishCancel();
      return;
    }
    if (matchesKey(data, "ctrl+s") || kb.matches(data, "tui.select.confirm")) {
      this.finishSave();
      return;
    }

    const items = this.filteredRows;
    const maxVisible = this.maxVisibleItems();
    const pageIndex = getSelectPageIndex(kb, data, this.selectedIndex, items.length, maxVisible);

    if (kb.matches(data, "tui.select.up")) {
      if (items.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? items.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      if (items.length === 0) return;
      this.selectedIndex = this.selectedIndex === items.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (pageIndex !== undefined) {
      if (items.length === 0) return;
      this.selectedIndex = pageIndex;
    } else if (matchesKey(data, "left")) {
      this.cycleRow(items[this.selectedIndex], -1);
    } else if (matchesKey(data, "right") || data === " ") {
      this.cycleRow(items[this.selectedIndex], 1);
    } else if (matchesKey(data, "backspace")) {
      if (this.query.length === 0) return;
      const chars = [...this.query];
      chars.pop();
      this.updateFilter(chars.join(""));
    } else if (isPrintableSearchText(data)) {
      this.updateFilter(this.query + data);
    } else {
      return;
    }

    this.invalidate();
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const items = this.filteredRows;
    if (items.length === 0) return undefined;

    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      const previous = this.selectedIndex;
      this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + delta));
      if (this.selectedIndex !== previous) this.invalidate();
      return { handled: true, render: this.selectedIndex !== previous };
    }

    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
      return undefined;
    }

    const visibleCount = this.visibleEndIndex - this.visibleStartIndex;
    const localRow = event.y - this.listStartRow;
    if (localRow < 0 || localRow >= visibleCount) return undefined;
    const itemIndex = this.visibleStartIndex + localRow;

    if (event.type === "press") {
      const changed = this.selectedIndex !== itemIndex;
      this.pressedRowIndex = itemIndex;
      this.selectedIndex = itemIndex;
      if (changed) this.invalidate();
      return { handled: true, focus: true, render: changed };
    }

    const targetIndex = this.pressedRowIndex ?? itemIndex;
    this.pressedRowIndex = undefined;
    this.selectedIndex = targetIndex;
    this.cycleRow(items[targetIndex], 1);
    this.invalidate();
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const w = Math.max(24, width);
    if (this.cachedLines && this.cachedWidth === w) return this.cachedLines;

    const inner = Math.max(20, w - 2);
    const config = this.draftConfig();
    const changed = this.changedKeys();
    const reload = changed.length > 0 && this.callbacks.needsReload(config);
    const body: string[] = [];

    if (this.query.length > 0) {
      body.push(clipToWidth(`  ${this.theme.fg("muted", "filter:")} ${this.theme.fg("accent", this.query)}`, inner));
      body.push("");
    }

    // Top border occupies row 0, so body index `body.length` sits at rendered row `1 + body.length`.
    this.listStartRow = 1 + body.length;

    const items = this.filteredRows;
    const maxVisible = this.maxVisibleItems();
    if (items.length === 0) {
      this.visibleStartIndex = 0;
      this.visibleEndIndex = 0;
      body.push(clipToWidth(`  ${this.theme.fg("muted", "No matching settings — Backspace to clear filter")}`, inner));
    } else {
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
      const end = Math.min(start + maxVisible, items.length);
      this.visibleStartIndex = start;
      this.visibleEndIndex = end;

      const labelWidth = Math.min(22, Math.max(...this.rows.map((row) => visibleWidth(String(row.spec.id)))));

      for (let i = start; i < end; i++) {
        const row = items[i]!;
        const selected = i === this.selectedIndex;
        const dirty = row.current !== row.initial;
        const cursor = selected ? this.theme.fg("accent", "▸ ") : "  ";
        const name = String(row.spec.id);
        const paddedName = name + " ".repeat(Math.max(0, labelWidth - visibleWidth(name)));
        const styledName = selected
          ? this.theme.fg("accent", this.theme.bold(paddedName))
          : dirty
            ? this.theme.fg("text", paddedName)
            : this.theme.fg("muted", paddedName);
        const formattedValue = row.spec.format(row.current, config);
        const valueBudget = Math.max(4, inner - 2 - labelWidth - 2 - (selected ? 4 : 0) - (dirty ? 2 : 0));
        const clippedValue = clipToWidth(formattedValue, valueBudget);
        const styledValue = selected
          ? `${this.theme.fg("dim", "◂ ")}${this.theme.fg("accent", this.theme.bold(clippedValue))}${this.theme.fg("dim", " ▸")}`
          : dirty
            ? this.theme.fg("warning", clippedValue)
            : this.theme.fg("toolOutput", clippedValue);
        const dirtyDot = dirty ? ` ${this.theme.fg("warning", "●")}` : "";
        body.push(clipToWidth(`${cursor}${styledName}  ${styledValue}${dirtyDot}`, inner));
      }

      if (start > 0 || end < items.length) {
        body.push(clipToWidth(`  ${this.theme.fg("dim", `(${this.selectedIndex + 1}/${items.length})`)}`, inner));
      }

      const active = items[this.selectedIndex];
      if (active) {
        body.push("");
        const wrapped = wrapTextWithAnsi(active.spec.description, Math.max(10, inner - 4));
        for (const line of wrapped.slice(0, 2)) {
          body.push(clipToWidth(`  ${this.theme.fg("muted", line)}`, inner));
        }
      }
    }

    body.push("");
    const statusParts: string[] = [];
    if (changed.length > 0) {
      statusParts.push(this.theme.fg("warning", `${changed.length} changed`));
      if (reload) statusParts.push(this.theme.fg("warning", "needs /reload"));
      else statusParts.push(this.theme.fg("success", "live"));
    } else {
      statusParts.push(this.theme.fg("dim", shortenPath(settingsPath())));
    }
    body.push(clipToWidth(`  ${statusParts.join(this.theme.fg("dim", " · "))}`, inner));
    body.push(
      clipToWidth(
        `  ${this.theme.fg("dim", "↑↓ move · ←→/Space change · type filter · Enter save · Esc cancel")}`,
        inner,
      ),
    );

    const framed = drawFrame(body, w, this.theme, "accent", undefined, false);
    const title = `${this.theme.fg("accent", this.theme.bold("tidy settings"))}${
      changed.length > 0 ? ` ${this.theme.fg("warning", `● ${changed.length}`)}` : ""
    }`;
    framed[0] = labeledTopBorder(w, this.theme, "accent", title, "left", 1, visibleWidth(title), false);

    this.cachedWidth = w;
    this.cachedLines = framed;
    return framed;
  }
}

function isPrintableSearchText(data: string): boolean {
  if (!data || data.startsWith("\x1b")) return false;
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export async function openTidySettingsPopup(
  ctx: ExtensionCommandContext,
  callbacks: {
    onApply(config: TidyConfig): void;
    needsReload(config: TidyConfig): boolean;
  },
): Promise<void> {
  if ((ctx as { mode?: string }).mode && (ctx as { mode?: string }).mode !== "tui") {
    ctx.ui.notify("/tidy settings requires interactive mode", "warning");
    return;
  }
  if (typeof ctx.ui?.custom !== "function") {
    ctx.ui.notify("/tidy settings requires interactive mode", "warning");
    return;
  }

  const rawTidy = readRawTidySettings();
  let activeTui: (TUI & { invalidate?: () => void }) | undefined;

  const result = await ctx.ui.custom<SettingsPopupResult>(
    (tui, theme, _kb, done) => {
      activeTui = tui as TUI & { invalidate?: () => void };
      return new TidySettingsPopup(
        rawTidy,
        tui,
        theme as unknown as ThemeLike,
        {
          onPreview: (config) => {
            callbacks.onApply(config);
            activeTui?.invalidate?.();
            activeTui?.requestRender(true);
          },
          needsReload: callbacks.needsReload,
        },
        done,
      );
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 76,
        minWidth: 42,
        margin: 1,
      },
      blocked: {
        kind: "question",
        message: "Configure pi-tidy settings",
      },
    } as any,
  );

  activeTui?.invalidate?.();
  activeTui?.requestRender(true);

  if (!result || result.action === "cancelled") return;
  if (result.action === "error") {
    ctx.ui.notify(`pi-tidy: could not save ${shortenPath(settingsPath())}: ${result.message}`, "error");
    return;
  }
  if (result.changedKeys.length === 0) return;

  if (result.reloadNeeded) {
    ctx.ui.notify("pi-tidy: settings saved — run /reload to finish applying", "info");
  } else {
    ctx.ui.notify(`pi-tidy: saved (${result.changedKeys.join(", ")})`, "info");
  }
}
