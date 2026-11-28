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
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, keyHint, VERSION, type ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { CommandText, type CommandIndent } from "./tools/command-text.ts";
import { formatBashCallHighlighted } from "./tools/bash-highlight.ts";
import { cleanCopy, installCleanCopy } from "./clean-copy.ts";
import { patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";
import { collapsedResultBudget, shrinkResultPreview } from "./tools/result-preview.ts";
import { noteHostRecord, resetHostRecords } from "./tools/nested-calls.ts";
import { noteDelegateNotice, resetDelegateNotices } from "./turns/delegate-notices.ts";
import { installSkillPrompts } from "./messages/skill-prompt.ts";
import { connectTurns, restoreBranchTurns, toggleTurn } from "./turns/turn-lifecycle.ts";
import { codeBlocksAvailable } from "./turns/turn-view.ts";
import { turnOptions } from "./turns/turn-state.ts";
import { DEFAULT_BASH_RESULT_LINES, loadConfig, PI_WRITE_PREVIEW_LINES, type TidyConfig } from "./config.ts";
import { agentRunning, chromeStyle, liveSlot, tidyEnabled } from "./live.ts";
import { openTidySettingsPopup } from "./settings-popup.ts";
import { patchBashExecutions } from "./messages/bash-mode-frame.ts";
import { patchErrorLines } from "./messages/error-lines.ts";
import { installRunGaps } from "./messages/user-message.ts";
import { restoreColor, withHexSwatchesCached } from "./messages/hex-swatches.ts";
import { transformLatexEnvironmentsCached } from "./messages/latex-environments.ts";
import { createWriteCallComponent, formatWriteCallText } from "./tools/write-preview.ts";
import { createReadPreviewComponent } from "./tools/markdown-latex-preview.ts";
import { isLatexPath, isMarkdownPath } from "./tools/lang-support.ts";
import { connectJobs, registerNestedJobs, type EventBusLike } from "./tools/background-jobs.ts";
import { installGroupBoundaries } from "./tools/tool-group-view.ts";
import { toolBodyInternalsAvailable } from "./tools/tool-frame.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";

export { highlightBashCommand, formatBashCallHighlighted } from "./tools/bash-highlight.ts";
export { stripBackgroundFills, patchContainerBoxes, patchMessageBoxes, patchToolBoxFrames } from "./frame.ts";

interface BashRenderState extends CommandIndent {
  startedAt?: number;
  endedAt?: number;
  /** Our own slot: the execution extension may be using `callText` itself. */
  tidyCallText?: Text;
}

const liveTidyConfig = liveSlot<TidyConfig>("tidy-config", loadConfig());

interface RuntimeHooks {
  patchesInstalled: boolean;
  turnsConnected: boolean;
  jobsConnected: boolean;
  markdownConnected: boolean;
  hasMarkdownTransformerApi: boolean;
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
function registerBashRenderers(pi: ExtensionAPI): void {
  if (!hasRendererApi(pi)) return;

  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (toolName !== "bash" || !renderers || !tidyEnabled.get()) return renderers;
    const live = liveTidyConfig.get();

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
    const call = live.highlightBash ? { renderCall } : {};
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
        if (!tidyEnabled.get()) return component;
        // 内置 bash 结果预览固定 5 行(BASH_PREVIEW_LINES),pi 没给配置项。
        // 折叠态下把它的行数预算改小;展开态和报错时保持原样(一行 traceback 没用)。
        const budget = collapsedResultBudget(liveTidyConfig.get().bashResultLines, context.isError);
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
function registerWritePreview(pi: ExtensionAPI): void {
  // No fallback to a tool override: a duplicate registration takes down
  // whoever else owns `write`. The caller has already warned (see entry point).
  if (!hasRendererApi(pi)) return;

  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (!tidyEnabled.get()) return renderers;
    if (toolName === "write") {
      return {
        ...renderers,
        renderCall(args, theme, context) {
          const live = liveTidyConfig.get();
          const lines = live.writeLines;
          // Rendering state is shared with the execution extension's renderers.
          // Use our own key so its cached components are not overwritten.
          const state = context.state as {
            tidyWriteCallText?: Text;
            tidyWritePreview?: {
              path: unknown;
              filePath: unknown;
              content: unknown;
              expanded: boolean;
              lines: number;
              renderMarkdown: boolean;
              renderLatex: boolean;
              theme: ThemeLike;
              component: Component;
            };
          };
          const writeArgs = args as Parameters<typeof formatWriteCallText>[0];
          const cached = state.tidyWritePreview;
          if (cached && cached.path === writeArgs?.path && cached.filePath === writeArgs?.file_path &&
              cached.content === writeArgs?.content && cached.expanded === context.expanded &&
              cached.lines === lines && cached.renderMarkdown === live.renderMarkdown &&
              cached.renderLatex === live.renderLatex && cached.theme === theme) {
            return cached.component;
          }
          const preview = createWriteCallComponent(writeArgs, theme, {
            expanded: context.expanded,
            lines,
            renderMarkdown: live.renderMarkdown,
            renderLatex: live.renderLatex,
          });
          if (preview) {
            state.tidyWritePreview = {
              path: writeArgs?.path,
              filePath: writeArgs?.file_path,
              content: writeArgs?.content,
              expanded: context.expanded,
              lines,
              renderMarkdown: live.renderMarkdown,
              renderLatex: live.renderLatex,
              theme,
              component: preview,
            };
            return preview;
          }
          state.tidyWritePreview = undefined;
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
        if (!tidyEnabled.get()) return downstream(result, options, theme, context);
        const live = liveTidyConfig.get();
        const rawPath = typeof context.args?.file_path === "string" ? context.args.file_path : typeof context.args?.path === "string" ? context.args.path : "";
        const kindMarkdown = live.renderMarkdown && isMarkdownPath(rawPath);
        const kindLatex = !kindMarkdown && live.renderLatex && isLatexPath(rawPath);
        const state = context.state as {
          tidyReadPreview?: { body: string; notice?: string; continuation?: string; kind: "markdown" | "latex"; renderLatex: boolean; theme: ThemeLike; component: Component };
        } | undefined;
        // Only expanded documents need a preview; pi owns collapsed and error
        // results, including the diagnostic for an oversized first line.
        if (options?.expanded && !context.isError && (kindMarkdown || kindLatex) && !result?.details?.truncation?.firstLineExceedsLimit) {
          const { body, notice, continuation } = readPreviewText(resultText(result?.content), result?.details);
          if (body.trim()) {
            const kind = kindMarkdown ? "markdown" : "latex";
            const cached = state?.tidyReadPreview;
            if (cached && cached.body === body && cached.notice === notice && cached.continuation === continuation && cached.kind === kind && cached.renderLatex === live.renderLatex && cached.theme === theme) {
              return cached.component;
            }
            const component = createReadPreviewComponent(body, theme, { kind, renderLatex: live.renderLatex, notice, continuation });
            if (state) state.tidyReadPreview = { body, notice, continuation, kind, renderLatex: live.renderLatex, theme, component };
            return component;
          }
        }
        // Pi's renderer reuses lastComponent as a Text. Our document component
        // is not a Text, so never pass it to the downstream renderer. Drop the
        // detached preview: it cannot be invalidated if the theme changes while
        // the result is collapsed, and would otherwise reopen in stale colours.
        const preview = state?.tidyReadPreview?.component;
        const downstreamContext = preview && context.lastComponent === preview
          ? { ...context, lastComponent: undefined }
          : context;
        if (state) state.tidyReadPreview = undefined;
        return downstream(result, options, theme, downstreamContext);
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

/** Keep pi's continuation and truncation messages outside the Markdown body. */
function readPreviewText(text: string, details: ReadToolDetails | undefined): { body: string; notice?: string; continuation?: string } {
  const truncation = details?.truncation;
  if (!truncation?.truncated) return { body: text };

  // The content field is the exact file text before pi appends its continuation
  // message. Do not remove a matching-looking line from an ordinary document.
  let body = text;
  let continuation: string | undefined;
  const prefix = `${truncation.content}\n\n`;
  if (text.startsWith(prefix)) {
    const suffix = text.slice(prefix.length);
    if (/^\[Showing lines \d+-\d+ of \d+.* Use offset=\d+ to continue\.\]$/.test(suffix)) {
      body = truncation.content;
      continuation = suffix;
    }
  }
  const notice = truncation.firstLineExceedsLimit
    ? `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
    : truncation.truncatedBy === "lines"
      ? `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`
      : `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`;
  return { body, notice, continuation };
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

function applyBaseConfig(config: TidyConfig): void {
  liveTidyConfig.set(config);
  turnOptions.set({
    collapseTurns: config.collapseTurns,
    frameFinalReply: config.finalReplyStyle !== "off",
    replyStyle: config.finalReplyStyle === "off" ? "frame" : config.finalReplyStyle,
    icons: config.icons,
    assistantColor: config.messageBorderColors.assistant,
    timeFormat: config.messageTimeFormat,
    headerStyle: config.messageHeaderStyle,
    replyMetrics: config.replyMetrics,
    codeBlocks: config.codeBlocks,
    splitDiff: config.splitDiff,
    splitDiffMinWidth: config.splitDiffMinWidth,
  });
  tidyEnabled.set(config.enabled);
  chromeStyle.set(config.style);
  cleanCopy.set(config.cleanCopy);
}

function applyPatchConfig(config: TidyConfig, pi: ExtensionAPI): void {
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
      diffContext: config.diffContext,
      thinkingColor: config.thinkingColor,
      highlightBash: config.highlightBash,
      toolRowLines: config.toolRowLines,
      bashResultLines: config.bashResultLines,
    });
    // Live job updates (pi-processes broadcasts on the shared extension bus).
    connectJobs(config.enabled && config.backgroundJobs ? (pi as { events?: EventBusLike }).events : undefined);
  } catch (error) {
    console.debug("[pi-tidy] tool box frame patch failed:", error);
  }

  try {
    // Called even when off: `enabled: false` turns patches from an earlier
    // load into pass-throughs.
    patchMessageBoxes(config.messageBorderColors, config.icons, config.frameMessages);
    patchContainerBoxes(config.messageBorderColors, {
      icons: config.icons,
      includeUser: config.userMessageStyle !== "off",
      userOpen: config.userMessageStyle === "rail",
      userAlign: config.userMessageAlign,
      userMaxWidth: config.userMessageMaxWidth,
      userFill: config.userMessageFill,
      userTime: config.userMessageTime,
      timeFormat: config.messageTimeFormat,
      headerStyle: config.messageHeaderStyle,
      enabled: config.frameMessages,
    });
    patchBashExecutions({
      enabled: config.frameMessages,
      icons: config.icons,
      // The user's own commands wear the user's color.
      color: config.messageBorderColors.user,
    });
    // pi's non-tool error rows: one framed row per failure instead of one per
    // retry attempt.
    patchErrorLines({ enabled: config.dedupeErrors });
  } catch (error) {
    console.debug("[pi-tidy] message box frame patch failed:", error);
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
}

function needsReload(config: TidyConfig, runtime: RuntimeHooks): boolean {
  if (!config.enabled) return false;
  if (!runtime.patchesInstalled) return true;
  if (!runtime.turnsConnected && (config.collapseTurns !== "off" || config.finalReplyStyle !== "off")) return true;
  if (!runtime.jobsConnected && config.backgroundJobs) return true;
  if (!runtime.markdownConnected && runtime.hasMarkdownTransformerApi && (config.renderLatex || config.hexSwatches)) return true;
  return false;
}

function registerTidyCommand(pi: ExtensionAPI, runtime: RuntimeHooks): void {
  if (typeof (pi as { registerCommand?: unknown }).registerCommand !== "function") return;

  pi.registerCommand("tidy", {
    description: "Configure pi-tidy or toggle a turn: /tidy settings | /tidy turn [number|last]",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trimStart().split(/\s+/);
      if (tokens.length > 2) return null;
      if (tokens.length <= 1) {
        const partial = tokens[0] ?? "";
        const items = [
          { value: "settings", label: "settings", description: "Open the interactive pi-tidy settings popup" },
          { value: "turn ", label: "turn", description: "Toggle a turn's folded process" },
        ].filter((item) => item.label.startsWith(partial));
        return items.length > 0 ? items : null;
      }
      if (tokens[0] === "turn") {
        const partial = tokens[1] ?? "";
        return "last".startsWith(partial)
          ? [{ value: "turn last", label: "last", description: "Toggle the most recent turn" }]
          : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0];
      if ((action === undefined || action === "settings") && tokens.length <= 1) {
        await openTidySettingsPopup(ctx, {
          onApply: (nextConfig) => {
            if (
              !runtime.turnsConnected &&
              (nextConfig.collapseTurns !== "off" || nextConfig.finalReplyStyle !== "off") &&
              typeof ctx.sessionManager?.getBranch === "function"
            ) {
              restoreBranchTurns(ctx);
            }
            applyBaseConfig(nextConfig);
            if (runtime.patchesInstalled) applyPatchConfig(nextConfig, pi);
          },
          needsReload: (nextConfig) => needsReload(nextConfig, runtime),
        });
        return;
      }
      if (action === "turn" && tokens.length <= 2) {
        toggleTurn(tokens[1], ctx);
        return;
      }
      ctx.ui.notify("Usage: /tidy settings | /tidy turn [number|last]", "warning");
    },
  });
}

/** Pi extension entry point. */
export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const runtime: RuntimeHooks = {
    patchesInstalled: false,
    turnsConnected: false,
    jobsConnected: false,
    markdownConnected: false,
    hasMarkdownTransformerApi: typeof (pi as { registerMarkdownTransformer?: unknown }).registerMarkdownTransformer === "function",
  };
  registerTidyCommand(pi, runtime);

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
  // A tool box's body sits in one of pi's private containers. A pi build that
  // reorganised them (Pi-Bolt, #93) keeps its own boxes and clicks.
  if (!toolBodyInternalsAvailable()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("pi-tidy: this pi builds its tool boxes differently, so tidy leaves their frames and clicks to pi.", "warning");
    });
  }
  // Patches installed by an earlier load (before a /reload) read this live,
  // so turning the extension off takes effect without a restart.
  applyBaseConfig(config);
  agentRunning.set(false);
  if (!config.enabled) return;

  if (config.collapseTurns !== "off" || config.finalReplyStyle !== "off") {
    connectTurns(pi);
    runtime.turnsConnected = true;
  }

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
  // pi's own record of the calls a tool made through `ctx.executeTool()` rides on
  // the tool result message, not on the result the box is drawn from. Keep its
  // arguments by call id: codemode's own record clips them at 200 characters.
  pi.on("message_start", ({ message }) => noteHostRecord(message));
  pi.on("session_start", (_event, ctx) => resetHostRecords(ctx.sessionManager.getBranch()));
  pi.on("session_tree", (_event, ctx) => resetHostRecords(ctx.sessionManager.getBranch()));
  // Sub-agent notices hang on the call that launched them (delegate-notices.ts):
  // index them from the session and as they arrive.
  pi.on("session_start", (_event, ctx) => resetDelegateNotices(ctx.sessionManager.getBranch()));
  pi.on("session_tree", (_event, ctx) => resetDelegateNotices(ctx.sessionManager.getBranch()));
  pi.on("message_start", ({ message }) => { noteDelegateNotice(message); });
  // `/skill:<name>` is the prompt that started the turn: drawn as one (skill-prompt.ts).
  installSkillPrompts();
  // Two blank rows between runs: the one pi puts in front of your message, widened.
  installRunGaps();

  const unavailable: string[] = [];
  if (!hasRendererApi(pi)) {
    if (config.highlightBash) unavailable.push("bash highlighting and the `bashResultLines` budget");
    else if (config.bashResultLines !== DEFAULT_BASH_RESULT_LINES) unavailable.push("the `bashResultLines` budget");
    if (config.writeLines !== PI_WRITE_PREVIEW_LINES) unavailable.push("the custom write preview (`writeLines`)");
  }
  warnUnavailableRenderers(pi, unavailable);

  runtime.patchesInstalled = true;
  applyPatchConfig(config, pi);
  if (config.backgroundJobs) {
    try {
      registerNestedJobs(pi);
      runtime.jobsConnected = true;
    } catch (error) {
      console.debug("[pi-tidy] nested job registration failed:", error);
    }
  }

  if (config.cleanCopy && !installCleanCopy()) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("pi-tidy: this pi has no selection text to clean, so copies keep their frames.", "warning");
    });
  }

  try {
    registerBashRenderers(pi);
  } catch (error) {
    console.debug("[pi-tidy] bash renderer failed:", error);
  }

  try {
    registerWritePreview(pi);
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
        const live = liveTidyConfig.get();
        let text = live.renderLatex ? transformLatexEnvironmentsCached(markdown) : markdown;
        if (live.hexSwatches && messageType !== "assistant-thinking") {
          const theme = getTheme();
          if (theme) text = withHexSwatchesCached(text, restoreColor(theme, messageType), theme);
        }
        return text;
      });
      runtime.markdownConnected = true;
    } catch (error) {
      console.debug("[pi-tidy] markdown transformer failed:", error);
    }
  }
}
