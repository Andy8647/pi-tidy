import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MessageBorderColors {
  user: string;
  compaction: string;
  branch: string;
  skill: string;
  custom: string;
}

export interface TidyConfig {
  enabled: boolean;
  highlightBash: boolean;
  /** Give message boxes the same rounded transparent frame as tool boxes. */
  frameMessages: boolean;
  /** Frame user messages too — off by default because pi-starline owns them. */
  frameUserMessages: boolean;
  /** Prepend Nerd Font icons (tool kind / file type / message kind). */
  icons: boolean;
  /**
   * Collapsed bash result preview height, in visual lines (default 1). pi's own
   * bash renderer hard-codes 5 and has no setting; `ctrl+o` still shows everything.
   */
  bashResultLines: number;
  /**
   * Collapse one assistant segment's tool calls into a single summary line.
   * Click the line for one row per call, click a row for the full box.
   */
  groupTools: boolean;
  /**
   * Tools that never fold into a group and keep pi's own box (edit/write by
   * default: the diff is the point). They also end the group before them.
   */
  alwaysShowTools: string[];
  /** Track background jobs (pi-processes) on the row of the call that started them. */
  backgroundJobs: boolean;
  /** Hide a job's notification messages when its row already shows them. */
  hideJobNotifications: boolean;
  /** Per-kind theme fg colors for message-box borders (any ThemeColor name). */
  messageBorderColors: MessageBorderColors;
  /**
   * Per-tool border color for successful executions (theme fg color names;
   * pending stays grey, error stays red). When set in settings, the map
   * REPLACES the defaults entirely — `{}` disables per-tool colors.
   */
  toolColors: Record<string, string>;
}

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
  frameUserMessages: false,
  icons: true,
  bashResultLines: 1,
  groupTools: true,
  alwaysShowTools: ["edit", "write"],
  backgroundJobs: true,
  hideJobNotifications: true,
  messageBorderColors: {
    user: "toolTitle",
    compaction: "customMessageLabel",
    branch: "mdCode",
    skill: "accent",
    custom: "warning",
  },
  toolColors: DEFAULT_TOOL_COLORS,
};

function readSettings(): any {
  const agentDir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || "/tmp"}/.pi/agent`;
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
}

export function loadConfig(): TidyConfig {
  try {
    // `tidy` since the rename from pi-toolbox; the old key keeps working.
    const settings = readSettings();
    const toolbox = settings?.tidy ?? settings?.toolbox;
    return {
      enabled: toolbox?.enabled ?? DEFAULTS.enabled,
      highlightBash: toolbox?.highlightBash ?? DEFAULTS.highlightBash,
      frameMessages: toolbox?.frameMessages ?? DEFAULTS.frameMessages,
      frameUserMessages: toolbox?.frameUserMessages ?? DEFAULTS.frameUserMessages,
      icons: toolbox?.icons ?? DEFAULTS.icons,
      bashResultLines: typeof toolbox?.bashResultLines === "number" ? toolbox.bashResultLines : DEFAULTS.bashResultLines,
      groupTools: typeof toolbox?.groupTools === "boolean" ? toolbox.groupTools : DEFAULTS.groupTools,
      alwaysShowTools: Array.isArray(toolbox?.alwaysShowTools)
        ? toolbox.alwaysShowTools.filter((name: unknown): name is string => typeof name === "string")
        : DEFAULTS.alwaysShowTools,
      backgroundJobs: typeof toolbox?.backgroundJobs === "boolean" ? toolbox.backgroundJobs : DEFAULTS.backgroundJobs,
      hideJobNotifications:
        typeof toolbox?.hideJobNotifications === "boolean" ? toolbox.hideJobNotifications : DEFAULTS.hideJobNotifications,
      messageBorderColors: {
        ...DEFAULTS.messageBorderColors,
        ...toolbox?.messageBorderColors,
      },
      // Replace, not merge: removing a tool's color must be expressible.
      toolColors: toolbox?.toolColors ?? DEFAULTS.toolColors,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

