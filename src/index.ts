/**
 * pi-tidy — a tidy transcript for the pi coding agent: a reply's tool calls
 * fold into one clickable line, every box gets a rounded transparent frame.
 *
 * - every tool box (built-in, MCP, other extensions) gets a self-drawn rounded
 *   frame with status-aware border colors and no background fill
 * - bash commands are syntax-highlighted
 *
 * Configuration: settings.json → "tidy" (the pre-rename "toolbox" key still
 * works). Every option and when it applies: README, "Configuration".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint, VERSION } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CommandText, type CommandIndent } from "./tools/command-text.ts";
import { formatBashCallHighlighted } from "./tools/bash-highlight.ts";
import { cleanCopy, installCleanCopy } from "./clean-copy.ts";
import { patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";
import { collapsedResultBudget, shrinkResultPreview } from "./tools/result-preview.ts";
import { connectTurns } from "./turns/turn-lifecycle.ts";
import { codeBlocksAvailable } from "./turns/turn-view.ts";
import { turnOptions } from "./turns/turn-state.ts";
import { DEFAULT_BASH_RESULT_LINES, loadConfig, PI_WRITE_PREVIEW_LINES, type TidyConfig } from "./config.ts";
import { agentRunning, tidyEnabled } from "./live.ts";
import { patchBashExecutions } from "./messages/bash-mode-frame.ts";
import { patchErrorLines } from "./messages/error-lines.ts";
import { patchUserMessages } from "./messages/user-message.ts";
import { restoreColor, withHexSwatchesCached } from "./messages/hex-swatches.ts";
import { transformLatexEnvironmentsCached } from "./messages/latex-environments.ts";
import { createWriteCallComponent, formatWriteCallText } from "./tools/write-preview.ts";
import { createReadPreviewComponent } from "./tools/markdown-latex-preview.ts";
import { isLatexPath, isMarkdownPath } from "./tools/lang-support.ts";
import { connectJobs, registerNestedJobs, type EventBusLike } from "./tools/background-jobs.ts";
import { installGroupBoundaries } from "./tools/tool-group-view.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";

export { highlightBashCommand, formatBashCallHighlighted } from "./tools/bash-highlight.ts";
export { stripBackgroundFills, patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";

interface BashRenderState extends CommandIndent {
  startedAt?: number;
  endedAt?: number;
  /** Our own slot: the execution extension may be using `callText` itself. */
  tidyCallText?: Text;
}

/**
 * Decorate bash's rows without registering a replacement tool.
 *
 * Both changes are presentation only: a syntax-highlighted command row, and a
 * smaller budget for the collapsed result preview. Registering `bash` to get
 * them meant any extension that also owns it (a sandbox, for instance) failed
 * to load with "Tool \"bash\" conflicts with …". As a renderer it composes: the
 * active tool keeps execution, schema, shell and result renderer, and `next()`
 * hands us whatever it has (pi's built-in renderers when it defines none).
 */
function registerBashRenderers(pi: ExtensionAPI, resultLines: number, highlight: boolean): void {
  if (!hasRendererApi(pi)) return;

  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (toolName !== "bash" || !renderers) return renderers;

    const renderCall = (args: any, theme: ThemeLike, context: any) => {
      const state = context.state as BashRenderState;
      // The built-in renderResult reads these for the "Took Xs" footer. We
      // replaced the call renderer that normally sets them.
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = state.tidyCallText ?? new CommandText(state);
      state.tidyCallText = text;
      // 折叠态(默认)只留命令首行 + `+N more lines`,和 pi 其它工具的折叠行为一致;
      // ctrl+o 展开后恢复整条命令(heredoc 之类)。
      text.setText(
        formatBashCallHighlighted(args, theme, {
          expanded: context.expanded,
          hint: keyHint("app.tools.expand", "to expand"),
        }),
      );
      return text;
    };

    // The budget has nothing to do with highlighting: with `highlightBash` off the
    // command row stays whoever owns it, and the result is still budgeted.
    const call = highlight ? { renderCall } : {};
    // No result renderer downstream means nothing to budget; leave it absent
    // rather than inventing a bare component.
    const downstream = renderers.renderResult;
    if (!downstream) return { ...renderers, ...call };

    return {
      ...renderers,
      ...call,
      renderResult(result: any, options: any, theme: any, context: any) {
        // Whatever the execution extension draws stays: we only lower the
        // preview budget inside it.
        const component = downstream(result, options, theme, context);
        // 内置 bash 结果预览固定 5 行(BASH_PREVIEW_LINES),pi 没给配置项。
        // 折叠态下把它的行数预算改小;展开态和报错时保持原样(一行 traceback 没用)。
        const budget = collapsedResultBudget(resultLines, context.isError);
        if (!options.expanded && budget !== undefined) shrinkResultPreview(component, budget);
        return component;
      },
    };
  });
}

/**
 * Oldest pi everything works on: component mouse events (0.86), the bash
 * preview budget (1.0) and tool durations (1.1). Checked at load rather than
 * as a peer range — pi asks for `"*"` peers, and a peer conflict blocks every
 * npm install in pi's package directory, not just this one.
 */const MIN_PI = "1.1.0";

function olderThan(version: string, min: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version), parse(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Decorate write's call preview and read's expanded body without registering a
 * replacement tool. The active tool (e.g. pi-playpen's sandboxed write) keeps
 * ownership of execution, and next() preserves its shell and result renderer,
 * including error output.
 *
 * One resolver for both, because a second `registerToolRenderer` call would ask
 * every other extension's resolver one more time for nothing. Markdown and LaTeX
 * files get a rendered body; everything else keeps exactly what pi drew.
 */
function registerWritePreview(pi: ExtensionAPI, config: TidyConfig): void {
  // No fallback to a tool override: a duplicate registration takes down
  // whoever else owns `write`. The caller has already warned (see entry point).
  if (!hasRendererApi(pi)) return;
  const lines = config.writeLines;

  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (toolName === "write") {
      return {
        ...renderers,
        renderCall(args, theme, context) {
          // Rendering state is shared with the execution extension's renderers.
          // Use our own key so its cached components are not overwritten.
          const state = context.state as { tidyWriteCallText?: Text };
          const writeArgs = args as Parameters<typeof formatWriteCallText>[0];
          const preview = createWriteCallComponent(writeArgs, theme, {
            expanded: context.expanded,
            lines,
            renderMarkdown: config.renderMarkdown,
            renderLatex: config.renderLatex,
          });
          if (preview) return preview;
          const text = state.tidyWriteCallText ?? new Text("", 0, 0);
          state.tidyWriteCallText = text;
          text.setText(formatWriteCallText(writeArgs, theme, { expanded: context.expanded, lines }));
          return text;
        },
      };
    }
    if (toolName !== "read") return renderers;
    const downstream = renderers?.renderResult;
    if (!renderers || !downstream) return renderers;

    return {
      ...renderers,
      renderResult(result: any, options: any, theme: any, context: any) {
        const rawPath = typeof context.args?.file_path === "string" ? context.args.file_path : typeof context.args?.path === "string" ? context.args.path : "";
        const kindMarkdown = config.renderMarkdown && isMarkdownPath(rawPath);
        const kindLatex = !kindMarkdown && config.renderLatex && isLatexPath(rawPath);
        // Collapsed, pi shows the first ten rows plus a hint; that is a code
        // preview, and the whole point of a document is the expanded box. Only
        // then is the file text collected, so a 10k-line read is not rendered
        // twice.
        if (options?.expanded && !context.isError && (kindMarkdown || kindLatex)) {
          const { body, notice } = splitTruncationNotice(resultText(result?.content));
          if (body.trim()) {
            return createReadPreviewComponent(body, theme, {
              kind: kindMarkdown ? "markdown" : "latex",
              renderLatex: config.renderLatex,
              notice,
            });
          }
        }
        return downstream(result, options, theme, context);
      },
    };
  });
}

/** The text blocks of a tool result, joined the way pi joins them. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * pi's truncation row (`[Truncated: …]`, `[First line exceeds …]`) is the last
 * line of the body it hands a renderer. A rendered document cannot carry it —
 * Markdown would fold it into a paragraph — so it is lifted out and drawn under
 * the body in `warning` instead.
 */
function splitTruncationNotice(text: string): { body: string; notice?: string } {
  const rows = text.split("\n");
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.trim() === "") end--;
  const last = rows[end - 1]?.trim();
  if (last === undefined || !/^\[(?:Truncated:|First line exceeds)/.test(last)) return { body: text };
  return { body: rows.slice(0, end - 1).join("\n"), notice: last };
}

/** `registerToolRenderer` arrived in pi 1.3; peer ranges stay `*` (see MIN_PI). */
function hasRendererApi(pi: ExtensionAPI): boolean {
  return typeof (pi as { registerToolRenderer?: unknown }).registerToolRenderer === "function";
}

/**
 * Say once, at session start, which renderer-backed features this pi cannot
 * have. Only features the user actually asked for — warning someone who left
 * `writeLines` at pi's own default would be pure noise.
 */
function warnUnavailableRenderers(pi: ExtensionAPI, features: string[]): void {
  if (features.length === 0) return;
  pi.on("session_start", (_event, ctx) => {
    const list = features.join(" and ");
    ctx.ui.notify(
      `pi-tidy: ${list} need pi.registerToolRenderer (pi 1.3 or newer). Upgrade pi to turn ${features.length === 1 ? "it" : "them"} on.`,
      "warning",
    );
  });
}

/** Pi extension entry point. */
export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  if (typeof VERSION === "string" && olderThan(VERSION, MIN_PI)) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`pi-tidy needs pi ≥ ${MIN_PI} (this is ${VERSION}): clicks and durations won't work.`, "warning");
    });
  }
  // The code-block rail hangs on a private method of pi's Markdown component.
  // A pi that renames it keeps its own code blocks, and the setting is inert.
  if (config.codeBlocks && !codeBlocksAvailable()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("pi-tidy: this pi's Markdown draws code blocks itself, so `tidy.codeBlocks` does nothing on it.", "warning");
    });
  }
  // Patches installed by an earlier load (before a /reload) read this live,
  // so turning the extension off takes effect without a restart.
  turnOptions.set({
    collapseTurns: config.collapseTurns,
    frameFinalReply: config.finalReplyStyle !== "off",
    replyStyle: config.finalReplyStyle === "off" ? "frame" : config.finalReplyStyle,
    icons: config.icons,
    assistantColor: config.messageBorderColors.assistant,
    timeFormat: config.messageTimeFormat,
    headerStyle: config.messageHeaderStyle,
    codeBlocks: config.codeBlocks,
    splitDiff: config.splitDiff,
    splitDiffMinWidth: config.splitDiffMinWidth,
  });
  tidyEnabled.set(config.enabled);
  agentRunning.set(false);
  if (!config.enabled) return;
  if (config.collapseTurns !== "off" || config.finalReplyStyle !== "off") connectTurns(pi);

  // The thinking row's "is this still arriving" cannot trust pi's private
  // `isStreaming` flag (it is not always settled), and a text-growth window
  // alone would keep spinning for a moment after the turn. The run's own
  // boundaries are the authority: set on start, cleared when the loop ends.
  pi.on("agent_start", () => agentRunning.set(true));
  pi.on("agent_end", () => agentRunning.set(false));
  pi.on("agent_settled", () => agentRunning.set(false));
  // The group boundaries are a wrapper on the message renders, and it only sees
  // anything while it is the outermost layer. Another extension may restyle a
  // message after this load without calling down; put the wrapper back on top
  // before a reply starts, not at its first tool, when half its calls have
  // already joined a group. A no-op while it is still on top.
  pi.on("before_agent_start", () => installGroupBoundaries());

  const unavailable: string[] = [];
  if (!hasRendererApi(pi)) {
    if (config.highlightBash) unavailable.push("bash highlighting and the `bashResultLines` budget");
    else if (config.bashResultLines !== DEFAULT_BASH_RESULT_LINES) unavailable.push("the `bashResultLines` budget");
    if (config.writeLines !== PI_WRITE_PREVIEW_LINES) unavailable.push("the custom write preview (`writeLines`)");
  }
  warnUnavailableRenderers(pi, unavailable);

  try {
    patchToolBoxFrames({
      icons: config.icons,
      toolColors: config.toolColors,
      groupTools: config.groupTools,
      groupOpen: config.groupOpen,
      alwaysShowTools: config.alwaysShowTools,
      backgroundJobs: config.backgroundJobs,
      hideJobNotifications: config.hideJobNotifications,
      splitDiff: config.splitDiff,
      splitDiffMinWidth: config.splitDiffMinWidth,
      diffLines: config.diffLines,
      thinkingColor: config.thinkingColor,
      highlightBash: config.highlightBash,
      toolRowLines: config.toolRowLines,
    });
    // Live job updates (pi-processes broadcasts on the shared extension bus).
    connectJobs(config.backgroundJobs ? (pi as { events?: EventBusLike }).events : undefined);
    if (config.backgroundJobs) registerNestedJobs(pi);
  } catch (error) {
    console.debug("[pi-tidy] tool box frame patch failed:", error);
  }

  try {
    // Called even when off: `enabled: false` turns patches from an earlier
    // load into pass-throughs.
    patchMessageBoxes(config.messageBorderColors, config.icons, config.frameMessages);
    patchContainerBoxes(config.messageBorderColors, {
      icons: config.icons,
      includeUser: config.userMessageStyle === "frame",
      userAlign: config.userMessageAlign,
      userMaxWidth: config.userMessageMaxWidth,
      userTime: config.userMessageTime,
      timeFormat: config.messageTimeFormat,
      headerStyle: config.messageHeaderStyle,
        enabled: config.frameMessages,
    });
    patchUserMessages({
      style: config.userMessageStyle,
      railColor: config.userMessageColors.rail,
      ruleColor: config.userMessageColors.rule,
      paddingY: config.userMessagePaddingY,
      icons: config.icons,
      time: config.userMessageTime,
      align: config.userMessageAlign,
      timeFormat: config.messageTimeFormat,
      headerStyle: config.messageHeaderStyle,
      });
    patchBashExecutions({
      enabled: config.frameMessages,
      icons: config.icons,
      // The user's own commands wear the user's color, whichever style draws them.
      color:
        config.userMessageStyle === "rail" ? config.userMessageColors.rail : config.messageBorderColors.user,
    });
    // pi's non-tool error rows: one framed row per failure instead of one per
    // retry attempt.
    patchErrorLines({ enabled: config.dedupeErrors });
  } catch (error) {
    console.debug("[pi-tidy] message box frame patch failed:", error);
  }

  cleanCopy.set(config.cleanCopy);
  if (config.cleanCopy && !installCleanCopy()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("pi-tidy: this pi has no selection text to clean, so copies keep their frames.", "warning");
    });
  }

  // The user message rail and frame above draw on their own and never call
  // down, so they bury the boundary wrapper `patchToolBoxFrames` installed. A
  // buried wrapper used to come back only at the first grouped tool's render,
  // mid-reply: the first reply of every process then split into two groups.
  try {
    installGroupBoundaries();
  } catch (error) {
    console.debug("[pi-tidy] group boundary install failed:", error);
  }

  try {
    registerBashRenderers(pi, config.bashResultLines, config.highlightBash);
  } catch (error) {
    console.debug("[pi-tidy] bash renderer failed:", error);
  }

  try {
    registerWritePreview(pi, config);
  } catch (error) {
    console.debug("[pi-tidy] write preview renderer failed:", error);
  }

  // Two display-only Markdown rewrites, one registration: pi keeps exactly one
  // `markdownTransformer` per extension, and the second call would replace the
  // first. The transformer runs before pi's own Markdown renderer and never
  // reaches the session or the model context.
  //
  // - a bare `\begin{equation}…\end{equation}` becomes a `$$…$$` math block
  //   (`tidy.renderLatex`), because pi's tokenizer only knows `$$` and `\[`
  // - a hex colour in a message gets a swatch painted with the colour it names
  //   (`tidy.hexSwatches`). Thinking is skipped — the box is dim and a swatch
  //   in it reads as a misplaced highlight.
  if (config.renderLatex || config.hexSwatches) {
    try {
      if (typeof (pi as { registerMarkdownTransformer?: unknown }).registerMarkdownTransformer !== "function") {
        throw new Error("pi.registerMarkdownTransformer is not a function");
      }
      pi.registerMarkdownTransformer((markdown, { messageType }) => {
        if (!tidyEnabled.get()) return markdown;
        let text = config.renderLatex ? transformLatexEnvironmentsCached(markdown) : markdown;
        if (config.hexSwatches && messageType !== "assistant-thinking") {
          const theme = getTheme();
          if (theme) text = withHexSwatchesCached(text, restoreColor(theme, messageType), theme);
        }
        return text;
      });
    } catch (error) {
      console.debug("[pi-tidy] markdown transformer failed:", error);
    }
  }
}
