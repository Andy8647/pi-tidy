/**
 * pi-tidy — a tidy transcript for the pi coding agent: a reply's tool calls
 * fold into one clickable line, every box gets a rounded transparent frame.
 *
 * - every tool box (built-in, MCP, other extensions) gets a self-drawn rounded
 *   frame with status-aware border colors and no background fill
 * - bash commands are syntax-highlighted
 *
 * Configuration (settings.json → "tidy"; the pre-rename "toolbox" key still works):
 *   enabled: boolean        — enable/disable the extension (default: true)
 *   highlightBash: boolean  — syntax-highlight bash commands (default: true)
 *   frameMessages: boolean  — rounded frame on message boxes (default: true)
 *   frameUserMessages: boolean — also frame user messages (default: false;
 *     pi-starline already restyles them and two render patches would fight)
 *   icons: boolean          — Nerd Font icons on boxes (default: true)
 *   groupTools: boolean     — fold each segment's tool calls into one summary
 *     line; click for one row per call, a row for its box (default: true)
 *   alwaysShowTools: string[] — tools that never fold (default: edit, write)
 *   backgroundJobs: boolean — a call that started a pi-processes job shows the
 *     job's live state on its row (default: true)
 *   hideJobNotifications: boolean — skip drawing that job's notification
 *     messages; the model still gets them (default: true)
 *   messageBorderColors: per-kind theme fg colors for message-box borders
 *     (user/compaction/branch/skill/custom; defaults toolTitle/customMessageLabel/
 *      mdCode/accent/warning)
 *   toolColors: per-tool border color on success (replaces defaults when set)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, keyHint, VERSION } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatBashCallHighlighted } from "./bash-highlight.ts";
import { patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";
import { collapsedResultBudget, shrinkResultPreview } from "./result-preview.ts";
import { loadConfig } from "./config.ts";
import { tidyEnabled } from "./live.ts";
import { connectJobs, type EventBusLike } from "./background-jobs.ts";
import type { ThemeLike } from "./theme-access.ts";

export { highlightBashCommand, formatBashCallHighlighted } from "./bash-highlight.ts";
export { stripBackgroundFills, patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";

interface BashRenderState {
  startedAt?: number;
  endedAt?: number;
  callText?: Text;
}

/**
 * Re-register bash with a syntax-highlighted call row. Everything else about
 * the box (the frame, the transparent background) comes from the component
 * patch, so no other tool needs an override.
 */
function registerHighlightedBash(
  pi: ExtensionAPI,
  cwd: string,
  resultLines: number,
): void {
  const definition = createBashToolDefinition(cwd) as any;

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: definition.description,
    // Not inherited from the built-in on override — copy them explicitly
    ...(definition.promptSnippet ? { promptSnippet: definition.promptSnippet } : {}),
    ...(definition.promptGuidelines ? { promptGuidelines: definition.promptGuidelines } : {}),
    parameters: definition.parameters,
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),

    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args: any, theme: ThemeLike, context: any) {
      const state = context.state as BashRenderState;
      // Replicate the built-in renderCall's timing state — its renderResult
      // reads startedAt/endedAt for the "Took Xs" footer.
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = state.callText ?? new Text("", 0, 0);
      state.callText = text;
      // 折叠态(默认)只留命令首行 + `+N more lines`,和 pi 其它工具的折叠行为一致;
      // ctrl+o 展开后恢复整条命令(heredoc 之类)。
      text.setText(
        formatBashCallHighlighted(args, theme, {
          expanded: context.expanded,
          hint: keyHint("app.tools.expand", "to expand"),
        }),
      );
      return text;
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      const component = definition.renderResult(result, options, theme, context);
      // 内置 bash 结果预览固定 5 行(BASH_PREVIEW_LINES),pi 没给配置项。
      // 折叠态下把它的行数预算改小;展开态和报错时保持内置原样(一行 traceback 没用)。
      const budget = collapsedResultBudget(resultLines, context.isError);
      if (!options.expanded && budget !== undefined) shrinkResultPreview(component, budget);
      return component;
    },
  } as any);
}

/**
 * Oldest pi everything works on: component mouse events (0.86), the bash
 * preview budget (1.0) and tool durations (1.1). Checked at load rather than
 * as a peer range — pi asks for `"*"` peers, and a peer conflict blocks every
 * npm install in pi's package directory, not just this one.
 */
const MIN_PI = "1.1.0";

function olderThan(version: string, min: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version), parse(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Pi extension entry point. */
export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  if (typeof VERSION === "string" && olderThan(VERSION, MIN_PI)) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`pi-tidy needs pi ≥ ${MIN_PI} (this is ${VERSION}): clicks and durations won't work.`, "warning");
    });
  }
  // Patches installed by an earlier load (before a /reload) read this live,
  // so turning the extension off takes effect without a restart.
  tidyEnabled.set(config.enabled);
  if (!config.enabled) return;

  try {
    patchToolBoxFrames({
      icons: config.icons,
      toolColors: config.toolColors,
      groupTools: config.groupTools,
      alwaysShowTools: config.alwaysShowTools,
      backgroundJobs: config.backgroundJobs,
      hideJobNotifications: config.hideJobNotifications,
    });
    // Live job updates (pi-processes broadcasts on the shared extension bus).
    connectJobs(config.backgroundJobs ? (pi as { events?: EventBusLike }).events : undefined);
  } catch (error) {
    console.debug("[pi-tidy] tool box frame patch failed:", error);
  }

  try {
    // Called even when off: `enabled: false` turns patches from an earlier
    // load into pass-throughs.
    patchMessageBoxes(config.messageBorderColors, config.icons, config.frameMessages);
    patchContainerBoxes(config.messageBorderColors, {
      icons: config.icons,
      includeUser: config.frameUserMessages,
      enabled: config.frameMessages,
    });
  } catch (error) {
    console.debug("[pi-tidy] message box frame patch failed:", error);
  }

  if (config.highlightBash) {
    try {
      registerHighlightedBash(pi, process.cwd(), config.bashResultLines);
    } catch (error) {
      console.debug("[pi-tidy] bash highlight override failed:", error);
    }
  }

}
