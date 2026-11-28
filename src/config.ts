import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HeaderStyle } from "./draw/frame-draw.ts";
import type { Style } from "./live.ts";
import type { UserMessageStyle } from "./messages/user-message.ts";
import type { CollapseTurns, FinalReplyStyle } from "./turns/turn-state.ts";

export interface MessageBorderColors {
  /** The final reply's frame, an open run's rail and its `▾` marker. Also `#rrggbb`. */
  assistant: string;
  user: string;
  compaction: string;
  branch: string;
  custom: string;
}

export interface TidyConfig {
  enabled: boolean;
  highlightBash: boolean;
  /** Give message boxes the same rounded transparent frame as tool boxes. */
  frameMessages: boolean;
  /**
   * How every surface is edged: "frame" (a rounded box) or "rail" (the same box
   * without its sides and corners: only the rules above and below). The lines an
   * open run or group hangs on are drawn either way.
   */
  style: Style;
  /**
   * Your messages: `style` unless set here, or "off" for pi's own. The frame hugs
   * the text (up to `userMessageMaxWidth`) and can sit on the right.
   */
  userMessageStyle: UserMessageStyle;
  /** Alignment of your message and its label. */
  userMessageAlign: "left" | "right";
  /**
   * The widest a framed user message's text renders before it wraps: `"auto"`
   * (the whole width), a fraction of the width (`0.7`), or a column count
   * (`88`). The frame hugs the narrower text.
   */
  userMessageMaxWidth: number | "auto";
  /**
   * Your message's edges reach the whole width, as everything else's do, instead of
   * hugging its text. The text still wraps at `userMessageMaxWidth`.
   */
  userMessageFill: boolean;
  /** Show a user message's time next to its icon. */
  userMessageTime: boolean;
  /** Fold a whole run live or only after settlement. */
  collapseTurns: CollapseTurns;
  /** The settled final reply, full width: `style` unless set here, or "off" for pi's own. */
  finalReplyStyle: FinalReplyStyle;
  /** `auto`, or a pattern of `YYYY M MM D DD H HH mm ss` and literal text. */
  messageTimeFormat: string;
  /** What a message's top edge looks like: `inline` or `split`. */
  messageHeaderStyle: HeaderStyle;
  /**
   * Show the final reply's model metrics — mean TTFT and output tok/s — next to
   * the time in its top edge. Off by default.
   */
  replyMetrics: boolean;
  /** Prepend Nerd Font icons (tool kind / file type / message kind). */
  icons: boolean;
  /**
   * Collapsed bash result preview height, in visual lines (default 1). pi's own
   * bash renderer hard-codes 5 and has no setting; `ctrl+o` still shows everything.
   */
  bashResultLines: number;
  /**
   * Collapsed write preview height, in visual lines (default 10, pi's own
   * number). `0` hides the preview until the box is expanded.
   */
  writeLines: number;
  /**
   * Collapse one assistant segment's tool calls into a single summary line.
   * Click the line for one row per call, click a row for the full box.
   */
  groupTools: boolean;
  /**
   * Start each new tool group open (`▾` header, one row per call) instead of
   * folded to its summary line. Only the group's first level: clicking the
   * header or `ctrl+o`'s collapse-all stays folded.
   */
  groupOpen: boolean;
  /** Rows a group's call may take: 2 lets one that does not fit go on to a second. */
  toolRowLines: 1 | 2;
  /**
   * Tools that never fold into a group and keep pi's own box (edit/write by
   * default: the diff is the point). They also end the group before them.
   */
  alwaysShowTools: string[];
  /** Track background jobs (pi-processes) on the row of the call that started them. */
  backgroundJobs: boolean;
  /** Hide a job's notification messages when its row already shows them. */
  hideJobNotifications: boolean;
  /**
   * pi reports a failed request once per retry attempt, as a plain row with the
   * provider's raw body. Fold the repeats into the first row as `×N` and frame
   * it like any other box. Only error rows: warnings and notes stay as pi
   * drew them.
   */
  dedupeErrors: boolean;
  /** Take tidy's frames and rails out of what pi's fullscreen selection copies. */
  cleanCopy: boolean;
  /**
   * Render an edit's diff as two panes (old | new) with line numbers, a
   * coloured bar and a tinted row per changed line. Also decides whether a
   * reply's `diff` code block gets panes. Falls back to pi's unified diff when
   * the box is too narrow (see `splitDiffMinWidth`).
   */
  splitDiff: boolean;
  /** Box width below which the split becomes unreadable; pi's diff is used. */
  splitDiffMinWidth: number;
  /**
   * Diff body rows shown while the box is collapsed (default 20). The window
   * follows the first changed line, not the top of the file; `ctrl+o` shows all.
   * edit has no such budget of its own — pi draws the whole diff.
   */
  diffLines: number;
  /**
   * Unchanged lines an edit's diff keeps on each side of a change, `0` to `4`. pi
   * writes four and folds the rest into `...`; fewer are cut out of that, in the
   * panes and in pi's unified diff alike, and more cannot be put back.
   */
  diffContext: number;
  /**
   * Put a `copy` chip on a reply's fenced code blocks, and give a language pi's
   * highlighter has no grammar for (fish) the closest one it does. A `diff` block
   * goes side by side instead, per `splitDiff`.
   */
  codeBlocks: boolean;
  /**
   * Paint a dot in front of every hex color a message names (`● #7f849c`).
   * Fenced code blocks and inline code are skipped.
   */
  hexSwatches: boolean;
  /**
   * Render a Markdown file's text as Markdown: in the `write` preview, and in
   * the `read` result once the box is expanded (`ctrl+o`). `.md`, `.markdown`,
   * `.mdx` and `.rmd`. Source code read/write stays exactly as pi draws it.
   */
  renderMarkdown: boolean;
  /**
   * Render LaTeX: `read`/`write` of `.tex`, `.latex`, `.ltx`, `.sty`, `.cls` and
   * `.bib` get syntax highlighting and, where possible, Unicode math; a
   * message's display-math environments (`\begin{equation}` …) become math
   * blocks pi can render. `false` leaves the source alone.
   */
  renderLatex: boolean;
  /** Per-kind theme fg colors for message-box borders (any ThemeColor name). */
  messageBorderColors: MessageBorderColors;
  /**
   * Theme color for thinking: the `🧠` row, the counting entry in the summary
   * line, and the border of an expanded thinking box. Any theme color name or
   * `#rrggbb`.
   */
  thinkingColor: string;
  /**
   * Per-tool border color for successful executions (theme fg color names;
   * pending stays grey, error stays red). When set in settings, the map
   * REPLACES the defaults entirely — `{}` disables per-tool colors.
   */
  toolColors: Record<string, string>;
}

/** pi's own collapsed write preview height; `writeLines` defaults to it. */
export const PI_WRITE_PREVIEW_LINES = 10;
export const DEFAULT_BASH_RESULT_LINES = 1;

const DEFAULT_TOOL_COLORS: Record<string, string> = {
  bash: "bashMode",
  read: "toolTitle",
  edit: "syntaxVariable",
  write: "syntaxVariable",
  grep: "syntaxOperator",
  find: "syntaxOperator",
  ls: "syntaxOperator",
  mcp: "customMessageLabel",
};

const DEFAULTS: TidyConfig = {
  enabled: true,
  highlightBash: true,
  frameMessages: true,
  style: "rail",
  userMessageStyle: "rail",
  userMessageAlign: "left",
  userMessageMaxWidth: "auto",
  userMessageFill: false,
  userMessageTime: true,
  collapseTurns: "afterRun",
  finalReplyStyle: "rail",
  messageTimeFormat: "auto",
  messageHeaderStyle: "inline",
  replyMetrics: false,
  icons: true,
  bashResultLines: DEFAULT_BASH_RESULT_LINES,
  writeLines: PI_WRITE_PREVIEW_LINES,
  groupTools: true,
  groupOpen: false,
  toolRowLines: 1,
  alwaysShowTools: ["edit", "write"],
  backgroundJobs: true,
  hideJobNotifications: true,
  dedupeErrors: true,
  cleanCopy: true,
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 20,
  diffContext: 4,
  codeBlocks: true,
  hexSwatches: true,
  renderMarkdown: true,
  renderLatex: true,
  thinkingColor: "warning",
  messageBorderColors: {
    assistant: "border",
    user: "border",
    compaction: "customMessageLabel",
    branch: "mdCode",
    custom: "warning",
  },
  toolColors: DEFAULT_TOOL_COLORS,
};

const STYLES: readonly Style[] = ["frame", "rail"];

/**
 * A surface's own key, when it says something: a style, or "off". `rules` is what a
 * rail was called before 0.11 (rules with no `│`), so it reads as one.
 */
function surfaceStyle(value: unknown): UserMessageStyle | undefined {
  if (value === "rules") return "rail";
  return value === "frame" || value === "rail" || value === "off" ? value : undefined;
}

// A fraction of the width (0 < r ≤ 1) or a column count. Anything else — zero, a
// negative, a non-finite number, a string — is the whole width: a typo in a
// setting should not hide the message it was meant to narrow.
function userMaxWidth(value: unknown): number | "auto" {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULTS.userMessageMaxWidth;
}

// `frameFinalReply` from before 0.9 keeps working: `true` is "frame", `false` is "off".
function finalReplyStyle(toolbox: any, style: Style): FinalReplyStyle {
  const own = surfaceStyle(toolbox?.finalReplyStyle);
  if (own) return own;
  if (typeof toolbox?.frameFinalReply === "boolean") return toolbox.frameFinalReply ? "frame" : "off";
  return style;
}

// A whole number of lines, at most the four pi writes; anything else keeps pi's four.
function diffContext(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, DEFAULTS.diffContext) : DEFAULTS.diffContext;
}

export function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaults(): TidyConfig {
  return {
    ...DEFAULTS,
    alwaysShowTools: [...DEFAULTS.alwaysShowTools],
    messageBorderColors: { ...DEFAULTS.messageBorderColors },
    toolColors: { ...DEFAULTS.toolColors },
  };
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), "utf-8"));
}

/**
 * Raw user `tidy` object from `settings.json` (falling back to pre-rename `toolbox`),
 * or `{}` when no settings file or key exists.
 */
export function readRawTidySettings(): Record<string, unknown> {
  try {
    const settings = readSettings();
    if (isPlainObject(settings?.tidy)) return { ...settings.tidy };
    if (isPlainObject(settings?.toolbox)) return { ...settings.toolbox };
    return {};
  } catch {
    return {};
  }
}

export function parseConfig(toolbox: any): TidyConfig {
  // One style for every surface; a surface's own key, where set, is the exception.
  const style: Style = STYLES.includes(toolbox?.style) ? toolbox.style : DEFAULTS.style;
  return {
    enabled: typeof toolbox?.enabled === "boolean" ? toolbox.enabled : DEFAULTS.enabled,
    highlightBash: typeof toolbox?.highlightBash === "boolean" ? toolbox.highlightBash : DEFAULTS.highlightBash,
    frameMessages: typeof toolbox?.frameMessages === "boolean" ? toolbox.frameMessages : DEFAULTS.frameMessages,
    style,
    // The pre-0.5 `frameUserMessages` needs no reading: `true` asked for the frame,
    // and `false` meant "leave them to pi-starline", which no longer draws them.
    userMessageStyle: surfaceStyle(toolbox?.userMessageStyle) ?? style,
    userMessageAlign: toolbox?.userMessageAlign === "right" ? "right" : "left",
    userMessageMaxWidth: userMaxWidth(toolbox?.userMessageMaxWidth),
    userMessageFill: typeof toolbox?.userMessageFill === "boolean" ? toolbox.userMessageFill : DEFAULTS.userMessageFill,
    userMessageTime: typeof toolbox?.userMessageTime === "boolean" ? toolbox.userMessageTime : DEFAULTS.userMessageTime,
    collapseTurns: ["off", "afterRun", "live"].includes(toolbox?.collapseTurns) ? toolbox.collapseTurns : DEFAULTS.collapseTurns,
    finalReplyStyle: finalReplyStyle(toolbox, style),
    messageTimeFormat:
      typeof toolbox?.messageTimeFormat === "string" && toolbox.messageTimeFormat.trim()
        ? toolbox.messageTimeFormat
        : DEFAULTS.messageTimeFormat,
    messageHeaderStyle: toolbox?.messageHeaderStyle === "split" ? "split" : DEFAULTS.messageHeaderStyle,
    replyMetrics: toolbox?.replyMetrics === true,
    icons: typeof toolbox?.icons === "boolean" ? toolbox.icons : DEFAULTS.icons,
    bashResultLines: typeof toolbox?.bashResultLines === "number" ? toolbox.bashResultLines : DEFAULTS.bashResultLines,
    writeLines: typeof toolbox?.writeLines === "number" ? toolbox.writeLines : DEFAULTS.writeLines,
    groupTools: typeof toolbox?.groupTools === "boolean" ? toolbox.groupTools : DEFAULTS.groupTools,
    groupOpen: typeof toolbox?.groupOpen === "boolean" ? toolbox.groupOpen : DEFAULTS.groupOpen,
    toolRowLines: toolbox?.toolRowLines === 2 ? 2 : DEFAULTS.toolRowLines,
    alwaysShowTools: Array.isArray(toolbox?.alwaysShowTools)
      ? toolbox.alwaysShowTools.filter((name: unknown): name is string => typeof name === "string")
      : [...DEFAULTS.alwaysShowTools],
    backgroundJobs: typeof toolbox?.backgroundJobs === "boolean" ? toolbox.backgroundJobs : DEFAULTS.backgroundJobs,
    hideJobNotifications:
      typeof toolbox?.hideJobNotifications === "boolean" ? toolbox.hideJobNotifications : DEFAULTS.hideJobNotifications,
    dedupeErrors: typeof toolbox?.dedupeErrors === "boolean" ? toolbox.dedupeErrors : DEFAULTS.dedupeErrors,
    cleanCopy: typeof toolbox?.cleanCopy === "boolean" ? toolbox.cleanCopy : DEFAULTS.cleanCopy,
    splitDiff: typeof toolbox?.splitDiff === "boolean" ? toolbox.splitDiff : DEFAULTS.splitDiff,
    splitDiffMinWidth:
      typeof toolbox?.splitDiffMinWidth === "number" ? toolbox.splitDiffMinWidth : DEFAULTS.splitDiffMinWidth,
    diffLines: typeof toolbox?.diffLines === "number" ? toolbox.diffLines : DEFAULTS.diffLines,
    diffContext: diffContext(toolbox?.diffContext),
    codeBlocks: typeof toolbox?.codeBlocks === "boolean" ? toolbox.codeBlocks : DEFAULTS.codeBlocks,
    hexSwatches: typeof toolbox?.hexSwatches === "boolean" ? toolbox.hexSwatches : DEFAULTS.hexSwatches,
    renderMarkdown: typeof toolbox?.renderMarkdown === "boolean" ? toolbox.renderMarkdown : DEFAULTS.renderMarkdown,
    renderLatex: typeof toolbox?.renderLatex === "boolean" ? toolbox.renderLatex : DEFAULTS.renderLatex,
    thinkingColor: typeof toolbox?.thinkingColor === "string" ? toolbox.thinkingColor : DEFAULTS.thinkingColor,
    messageBorderColors: { ...DEFAULTS.messageBorderColors, ...toolbox?.messageBorderColors },
    // Replace, not merge: removing a tool's color must be expressible.
    toolColors: isPlainObject(toolbox?.toolColors) ? (toolbox.toolColors as Record<string, string>) : { ...DEFAULTS.toolColors },
  };
}

/**
 * Merge `patch` into the existing `tidy` object in `settings.json` without replacing
 * unrelated top-level or `tidy` keys. A key mapped to `undefined` is removed so an
 * override (such as `userMessageStyle`) can return to its inherited default.
 */
export function saveTidySettings(patch: Record<string, unknown>): TidyConfig {
  // A settings.json linked in from elsewhere (a dotfiles repo) stays a link: the
  // rename below lands on the file it points at, not on the link.
  const file = existsSync(settingsPath()) ? realpathSync(settingsPath()) : settingsPath();
  let root: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!isPlainObject(parsed)) {
      throw new Error(`Expected JSON object in ${file}`);
    }
    root = parsed;
  }

  // Seed from `toolbox` when migrating an older config so `settings.tidy ?? settings.toolbox`
  // does not shadow keys the user had under the pre-rename name.
  const nextTidy: Record<string, unknown> = isPlainObject(root.tidy)
    ? { ...root.tidy }
    : isPlainObject(root.toolbox)
      ? { ...root.toolbox }
      : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete nextTidy[key];
    else nextTidy[key] = value;
  }

  const nextRoot: Record<string, unknown> = { ...root, tidy: nextTidy };
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(nextRoot, null, 2)}\n`, "utf-8");
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  return parseConfig(nextTidy);
}

export function loadConfig(): TidyConfig {
  try {
    // `tidy` since the rename from pi-toolbox; the old key keeps working.
    const settings = readSettings();
    const toolbox = settings?.tidy ?? settings?.toolbox;
    return parseConfig(toolbox);
  } catch {
    return cloneDefaults();
  }
}

