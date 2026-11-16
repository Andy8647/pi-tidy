/**
 * Rounded transparent frames for *every* tool box.
 *
 * Re-registering tools with `renderShell: "self"` only reaches tools this
 * extension registers itself — tools owned by other extensions (MCP via
 * pi-mcp-adapter, subagents, …) keep pi's default filled-background shell,
 * and the extension API exposes no way to wrap another extension's renderers
 * (`getAllTools()` returns name/description/parameters only).
 *
 * So the frame is applied one level lower, on ToolExecutionComponent — the
 * component pi builds for every tool call regardless of who registered it.
 * Extensions import the same live module instance as the host app, so
 * patching the prototype reaches every tool box in the session.
 *
 * The patches are installed once and read their options from a global slot,
 * so a `/reload` with new settings reaches them (see live.ts).
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Box, Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { blankEdges, drawFrame, labeledTopBorder, outsideHyperlink, removeLeadingWord, sameLines, shortenPath, stripBackgroundFills, trimTrailingSpaces, visibleIndexOf, visibleText } from "../draw/frame-draw.ts";
import {
  composeCodemodeBody,
  codemodeSections,
  decorateCodemodeBody,
  type CodemodeBodyOptions,
  type CodemodeToggle,
  type ComposedCodemodeBody,
} from "./codemode-body.ts";
import { composeFabricBody } from "./fabric-body.ts";
import { isPromotedCall, mergesNestedCalls, nestedCallsOf, type NestedCall } from "./nested-calls.ts";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { clipToWidth } from "../draw/frame-draw.ts";
import { fileIcon, PATH_ARG_TOOLS, toolKindIcon } from "../draw/icons.ts";
import { closeJobDetails, jobsForTool, setJobOptions } from "./background-jobs.ts";
import { DEFAULT_BASH_RESULT_LINES } from "../config.ts";
import { liveSlot, optionsRevision, tidyEnabled } from "../live.ts";
import { expandTurnForTool, hideTurnTool, railTurnTool } from "../turns/turn-state.ts";
import { joinBoxCorners, railRows, TURN_RAIL_BOX_CELLS, TURN_RAIL_CELLS } from "../turns/turn-view.ts";
import { renderSplitDiff } from "./split-diff.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";
import { CALL_PROMPT_CELLS } from "./command-text.ts";
import { pinnedJoints, noteSetExpanded, planFor, setGroupOpenDefault } from "./tool-groups.ts";
import { formatToolLine } from "./tool-lines.ts";
import {
  installGroupBoundaries,
  codemodeFoldAt,
  NOT_GROUPED,
  renderGroupedTool,
  routeCodemodeFold,
  routeGroupedMouse,
  setGroupingActive,
  setIconsEnabled,
  setThinkingColor,
  type CodemodeRowSpan,
  type GroupedTool,
} from "./tool-group-view.ts";
import { codemodeHover, claimHover, hoverBand, installHoverTracking, isRowHovered, requestHoverRender } from "../hover.ts";
import { canCopyText, copyText } from "../clipboard.ts";
import { COPIED_MS, chipLabels, chipWord, repaintChip } from "../turns/code-blocks.ts";

interface MouseTarget {
  render(width: number): string[];
  handleMouse?(event: unknown): unknown;
}

/**
 * Where the box's source rows sit in the framed output, so a click can be
 * translated back into the coordinates pi's own components expect.
 */
interface FrameGeometry {
  /** Output row of source row 0 (rows above it were trimmed padding). */
  top: number;
  /** Source rows rendered, and the width they were rendered at. */
  height: number;
  width: number;
  /** false when the frame was dropped (a body hanging under a group row): column 0 is the body. */
  bordered?: boolean;
}

interface ToolBoxInternals extends GroupedTool {
  __tidyTurnRendered?: boolean;
  hideComponent: boolean;
  toolName: string;
  result?: { isError: boolean; durationMs?: number; content?: unknown; details?: unknown };
  selfRenderContainer: MouseTarget;
  contentBox: MouseTarget;
  contentText: MouseTarget;
  /** The MouseRegion pi wraps around `contentText` (no renderer definition). */
  contentTextRegion?: MouseTarget;
  imageComponents: Array<{ render(width: number): string[] }>;
  imageSpacers: Array<{ render(width: number): string[] }>;
  /** The component pi wrapped around the call renderer's output (the edit Box). */
  callRendererComponent?: {
    preview?: { diff?: unknown; error?: unknown };
    children?: ReadonlyArray<{ render(width: number): string[] }>;
    /** A renderer that returns one component hands back its rows, not children. */
    render?(width: number): string[];
  };
  hasRendererDefinition(): boolean;
  getRenderShell(): "default" | "self";
  __frameCache?: {
    width: number;
    color: string;
    expanded: boolean;
    /** `optionsRevision()` when it was built: every option a frame reads, in one number. */
    revision: number;
    unframed: boolean;
    /** The framed codemode fold row wearing the hover band ("" for none). */
    hovered: string;
    raw: string[];
    out: string[];
    geometry: FrameGeometry;
  };
  __frameGeometry?: FrameGeometry;
  __railCells?: number;
  /** The chip label a file box draws, and the path it copies: set by the frame, measured below. */
  __pathChip?: string;
  __pathText?: string;
  /**
   * A file box's path chip, on the rows this component displays: where it is and what a
   * click copies. Measured there rather than on the frame's own rows, because a group
   * and a turn's rail put their cells in front of them.
   */
  __pathCopy?: { row: number; x: number; end: number; text: string };
  /** While the chip reads `copied`, after a click. */
  __pathCopyFlashUntil?: number;
  /** The split diff last built for this box, and what it was built from. */
  __splitCache?: {
    diff: string;
    width: number;
    maxLines: number | undefined;
    filePath: string | undefined;
    theme: ThemeLike;
    call: string[];
    value: { raw: string[]; bgRows: ReadonlySet<number> } | undefined;
  };
  /** Row indices of a call list's fold labels in the last framed body. */
  __codemodeToggles?: CodemodeToggle[];
  /** Rows of a call list's body whose fill belongs to the content (a nested diff). */
  __callListFills?: ReadonlySet<number>;
  /** The boxes a wrapper's promoted calls drew last (a fabric edit's diff). */
  __promotedBoxes?: { details: unknown; width: number; revision: number; theme: ThemeLike; rows: string[]; height: number };
  /** Rows this component drew itself last, before the promoted boxes were appended. */
  __lastOwnRows?: number;
  /** A framed call list's fold rows, in its own output rows; unset for every other box. */
  __codemodeFolds?: CodemodeRowSpan[];
  /** The last composed codemode body, and what it was composed from. fabric keeps its own below. */
  __codemodeComposed?: {
    body: string[];
    details: unknown;
    script: boolean;
    output: boolean;
    revision: number;
    width: number | undefined;
    hovered: string | undefined;
    sample: string;
    value: ComposedCodemodeBody;
  };
  /** The last composed fabric body, and what it was composed from. */
  __fabricComposed?: {
    args: unknown;
    details: unknown;
    output: string;
    script: boolean;
    outputOpen: boolean;
    icons: boolean;
    revision: number;
    width: number | undefined;
    hovered: string | undefined;
    sample: string;
    value: ComposedCodemodeBody;
  };
  /** The framed list built on the last composed body. */
  __codemodeList?: {
    composed: ComposedCodemodeBody;
    w: number;
    revision: number;
    value: { title: string; lines: string[]; toggles: CodemodeToggle[]; fills: ReadonlySet<number> };
  };
  /** The expanded rendering a framed codemode box composes from, and what it was built from. */
  __codemodeFull?: {
    args: unknown;
    result: unknown;
    isPartial: boolean;
    sample: string;
    body: Component | undefined;
  };
  /** pi's own fields, read to draw the body a second time at `expanded: true`. */
  toolDefinition?: {
    renderCall?(args: unknown, theme: unknown, context: unknown): Component;
    renderResult?(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
  };
  cwd?: string;
  outputPad?: number;
  argsComplete?: boolean;
}

export interface ToolFrameOptions {
  /** Prepend a Nerd Font icon (tool kind or target file type) to the call row. */
  icons?: boolean;
  /** Per-tool-name border color for successful executions (theme fg color names). */
  toolColors?: Record<string, string>;
  /**
   * Collapse each assistant segment's tool calls into one summary line
   * (`▸ 4 calls · bash×3 read×1`), expanding to one row per call, then to the
   * full box. Click a line to step down a level; `ctrl+o` still expands all.
   */
  groupTools?: boolean;
  /**
   * Start each new group open (`▾` header, one row per call) instead of folded
   * to its summary line; a click on the header or `ctrl+o` still folds it.
   */
  groupOpen?: boolean;
  /** Tools that never fold into a group (default edit/write: the diff is the point). */
  alwaysShowTools?: string[];
  /**
   * Track background jobs a call started (pi-processes): the row shows the
   * job's live state instead of the call's.
   */
  backgroundJobs?: boolean;
  /** Skip drawing a job's notification messages when its row shows the same. */
  hideJobNotifications?: boolean;
  /** Render the edit diff as two panes (old | new) when the box is wide enough. */
  splitDiff?: boolean;
  /** Box width below which the split falls back to pi's unified diff (default 72). */
  splitDiffMinWidth?: number;
  /** Diff rows shown while the box is collapsed (default 20; `0` shows none). */
  diffLines?: number;
  /** Theme color for thinking rows and the expanded thinking box (default `warning`). */
  thinkingColor?: string;
  /** Syntax-highlight bash commands on group rows. */
  highlightBash?: boolean;
  /** Rows a group's call may take: 2 lets one that does not fit go on to a second. */
  toolRowLines?: number;
  /**
   * Rows of a nested call's own output a call list keeps under its row, the way
   * a bash box keeps this many of its own (default 1).
   */
  bashResultLines?: number;
}

interface ResolvedToolFrameOptions {
  icons: boolean;
  toolColors: Record<string, string>;
  groupTools: boolean;
  groupOpen: boolean;
  alwaysShow: Set<string>;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  diffLines: number;
  thinkingColor: string;
  highlightBash: boolean;
  toolRowLines: number;
  bashResultLines: number;
}

const toolOptions = liveSlot<ResolvedToolFrameOptions>("tool-frame-options", {
  icons: false,
  toolColors: {},
  groupTools: true,
  groupOpen: false,
  alwaysShow: new Set(["edit", "write"]),
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 20,
  thinkingColor: "warning",
  highlightBash: true,
  toolRowLines: 1,
  bashResultLines: DEFAULT_BASH_RESULT_LINES,
});

const grouping = () => tidyEnabled.get() && toolOptions.get().groupTools;

/**
 * A file box's path chip, in its lit states: lit under the pointer, a tick for a moment
 * after a click. The rows are only copied when a state shows, so the frame cache still
 * holds what the box looks like at rest and an idle box costs one comparison.
 */
function withCopyChip(box: ToolBoxInternals, rows: string[], theme: ThemeLike): string[] {
  const copy = box.__pathCopy;
  const until = box.__pathCopyFlashUntil;
  const copied = until !== undefined && Date.now() < until;
  const hot = copy !== undefined && isRowHovered(box, "title");
  if (!copy || rows.length === 0 || (!copied && !hot)) return rows;
  const labels = chipLabels(toolOptions.get().icons);
  return repaintChip(rows, { row: copy.row, index: 0, x: copy.x, end: copy.end }, theme, copied ? labels.copied : labels.copy, hot);
}

/**
 * Where the chip landed on the rows the component displays. They carry the rail or the
 * group's gutter in front, and a pointer reports columns on the same rows, so this is
 * the only place the two agree.
 */
function measurePathChip(box: ToolBoxInternals, rows: readonly string[]): void {
  const chip = box.__pathChip;
  box.__pathCopy = undefined;
  if (!chip) return;
  for (let row = 0; row < rows.length; row++) {
    const plain = visibleText(rows[row]!);
    const at = plain.indexOf(chip);
    if (at < 0) continue;
    const x = visibleWidth(plain.slice(0, at));
    box.__pathCopy = { row, x, end: x + visibleWidth(chip), text: box.__pathText ?? "" };
    return;
  }
}

/** One frame of a box: its chip measured, and painted for the pointer or a copy. */
function finishBox(box: ToolBoxInternals, rows: string[], theme: ThemeLike): string[] {
  measurePathChip(box, rows);
  return withCopyChip(box, rows, theme);
}

/** A call-list box drawn in a frame of its own: grouping off, or its tool in `alwaysShowTools`. */
const framedCallList = (tool: ToolBoxInternals) =>
  tidyEnabled.get() && (!toolOptions.get().groupTools || toolOptions.get().alwaysShow.has(tool.toolName));

/** A tool whose body is the calls it made, and which record those calls are in. */
type CallListKind = "codemode" | "fabric";

const CALL_LIST_TOOLS = new Map<string, CallListKind>([
  ["codemode", "codemode"],
  ["fabric_exec", "fabric"],
]);

/**
 * Whether this box reads as a call list, and which body draws it.
 *
 * `codemode` was the first: pi draws a script's calls as rows inside the result,
 * so tidy decorates that text. pi-fabric's `fabric_exec` keeps its calls in
 * `details.audits` and draws nothing for tidy here, so its body is built from the
 * record instead (fabric-body.ts) — including the diff of a nested `edit`.
 */
function callListKind(tool: ToolBoxInternals): CallListKind | undefined {
  return CALL_LIST_TOOLS.get(tool.toolName);
}

/** The component pi routes a box's clicks through (its result MouseRegions live inside). */
function mouseTarget(tool: ToolBoxInternals): MouseTarget | undefined {
  if (!tool.hasRendererDefinition()) return tool.contentTextRegion;
  return tool.getRenderShell() === "self" ? tool.selfRenderContainer : tool.contentBox;
}

export function patchToolBoxFrames(options: ToolFrameOptions = {}): void {
  const {
    icons = false,
    toolColors = {},
    groupTools = true,
    groupOpen = false,
    alwaysShowTools = ["edit", "write"],
    backgroundJobs = true,
    hideJobNotifications = true,
    splitDiff = true,
    splitDiffMinWidth = 72,
    diffLines = 20,
    thinkingColor = "warning",
    highlightBash = true,
    toolRowLines = 1,
    bashResultLines = DEFAULT_BASH_RESULT_LINES,
  } = options;
  toolOptions.set({
    icons,
    toolColors,
    groupTools,
    groupOpen,
    alwaysShow: new Set(alwaysShowTools),
    splitDiff,
    splitDiffMinWidth,
    diffLines,
    thinkingColor,
    highlightBash,
    toolRowLines,
    bashResultLines,
  });
  setJobOptions({ enabled: backgroundJobs, hideNotifications: hideJobNotifications });
  // Value, not a closure: the patch runs again on `/reload`, which is what
  // pushes a changed `groupOpen` down to the grouping state machine.
  setGroupOpenDefault(groupOpen);

  const proto = ToolExecutionComponent.prototype as unknown as ToolBoxInternals & {
    render(width: number): string[];
    __toolboxFramed?: boolean;
  };
  if (proto.__toolboxFramed) return;
  proto.__toolboxFramed = true;

  const originalRender = proto.render;
  const anyProto = proto as unknown as Record<string, any>;
  const originalHandleMouse = anyProto.handleMouse;
  const originalSetExpanded = anyProto.setExpanded;

  setGroupingActive(grouping);
  setIconsEnabled(() => toolOptions.get().icons);
  setThinkingColor(() => toolOptions.get().thinkingColor);
  installGroupBoundaries();
  installHoverTracking();

  // >0 while pi's own mouse handling runs: its box click reaches setExpanded
  // from in here, ctrl+o's expand/collapse-all from anywhere else.
  let pointerDepth = 0;
  const asPointer = <T>(fn: () => T): T => {
    pointerDepth++;
    try {
      return fn();
    } finally {
      pointerDepth--;
    }
  };

  /**
   * A click on a file box's path chip copies the path, and the pointer over it gets the
   * hand instead of the box's expand switch. The chip's row and columns were measured on
   * these rows, so the event needs no translation — which is what makes it work under a
   * group's header row and on a turn's rail, where a click belongs to someone else.
   */
  function pathChipMouse(this: ToolBoxInternals, event: any): unknown {
    const copy = this.__pathCopy;
    if (!copy || typeof event?.x !== "number" || typeof event?.y !== "number") return undefined;
    const over = event.y === copy.row && event.x >= copy.x && event.x < copy.end;
    if (event.type === "move") {
      // Only a row of ours is given back: a move over the box's body may belong to a job
      // row inside it, and this runs before the group has had its say.
      if (!over && !isRowHovered(this, "title")) return undefined;
      if (claimHover(this, over ? "title" : null)) requestHoverRender();
      return over ? { handled: true } : undefined;
    }
    if (!over || event.type !== "click" || (event.button !== "left" && event.button !== 0)) return undefined;
    const until = Date.now() + COPIED_MS;
    this.__pathCopyFlashUntil = until;
    void copyText(copy.text).catch(() => {
      if (this.__pathCopyFlashUntil === until) this.__pathCopyFlashUntil = undefined;
    });
    setTimeout(() => {
      if (this.__pathCopyFlashUntil !== until) return;
      this.__pathCopyFlashUntil = undefined;
      requestHoverRender();
    }, COPIED_MS).unref?.();
    return { handled: true, render: true };
  }

  /**
   * A click on the framed box, translated into the source component's own
   * coordinates. pi's handler would measure the *unframed* layout (and, for
   * `renderShell: "self"` tools, read a height only its own render records),
   * so clicks landed on the wrong row or — for edit and MCP boxes — nowhere.
   */
  function boxMouse(this: ToolBoxInternals, event: any, dx = 0, dy = 0): unknown {
    // A framed codemode call list is tidy's own rows, not pi's layout: its fold
    // rows open their section, and every other cell is the box's expand switch.
    const folds = this.__codemodeFolds;
    if (folds) {
      const fold = codemodeFoldAt(folds, event?.y - dy);
      if (fold) return routeCodemodeFold(this, event, fold.section);
      const click = event?.type === "click" && (event.button === "left" || event.button === 0);
      if (!click) return undefined;
      asPointer(() => this.setExpanded(!this.expanded));
      return { handled: true };
    }
    const geometry = this.__frameGeometry;
    const target = mouseTarget(this);
    if (!geometry || typeof target?.handleMouse !== "function") {
      return asPointer(() => originalHandleMouse?.call(this, event));
    }
    const y = event.y - dy - geometry.top;
    if (y >= 0 && y < geometry.height) {
      // Column 0 of the source sits right of the left border — unless the frame
      // was dropped, in which case the body starts where the row does.
      const x = event.x - dx - (geometry.bordered === false ? 0 : 1);
      const handled = asPointer(() =>
        target.handleMouse!({ ...event, x, y, width: geometry.width, height: geometry.height }),
      );
      if (handled !== undefined) return handled;
    }
    // Nothing under the pointer took it. The rows we draw are not always rows
    // pi's own layout knows about: a split diff is painted here, so pi's
    // sub-components keep the height they had before the preview arrived (a
    // streamed frame leaves them at two or three rows), and an unframed body is
    // shifted by the gutter. Every cell of the box is the expand switch, so a
    // click that found no owner toggles it here instead of doing nothing.
    const click = event?.type === "click" && (event.button === "left" || event.button === 0);
    if (!click) return undefined;
    asPointer(() => this.setExpanded(!this.expanded));
    return { handled: true };
  }

  anyProto.handleMouse = function (this: ToolBoxInternals, event: any) {
    if (!tidyEnabled.get()) return originalHandleMouse?.call(this, event);
    if (hideTurnTool(this.toolCallId)) return undefined;
    // The promoted boxes hang below this component's own rows and answer no
    // click of their own: a packet on one must not fall through to the
    // wrapper's box mouse, which would fold the list the reader is looking at.
    const promoted = this.__promotedBoxes;
    if (promoted && typeof event?.y === "number") {
      const own = this.__lastOwnRows ?? 0;
      if (event.y >= own && event.y < own + promoted.height) return undefined;
    }
    // Before the rail is discounted and before a group gets its say: the chip is the one
    // cell range of the box that copies instead of opening, wherever the row came from.
    const chip = pathChipMouse.call(this, event);
    if (chip !== undefined) return chip;
    // Everything below measures from where the call starts, which is past the rail.
    if (railTurnTool(this.toolCallId) && typeof event?.x === "number") {
      const cells = this.__railCells ?? TURN_RAIL_CELLS;
      event = { ...event, x: Math.max(0, event.x - cells), width: event.width - cells };
    }
    if (grouping()) {
      const routed = routeGroupedMouse(this, event, {
        pinned: toolOptions.get().alwaysShow.has(this.toolName),
        asPointer,
        boxMouse: (shifted, dx, dy) => boxMouse.call(this, shifted, dx, dy),
      });
      if (routed !== NOT_GROUPED) return routed;
    }
    return boxMouse.call(this, event);
  };

  // ctrl+o 与 pi 自己的展开都走 setExpanded:先改层级,再让 pi 记自己的状态
  anyProto.setExpanded = function (this: ToolBoxInternals, expanded: boolean) {
    if (tidyEnabled.get() && pointerDepth === 0 && (this.__tidyTurnRendered || expanded)) {
      expandTurnForTool(this.toolCallId, expanded);
    }
    if (grouping()) {
      if (!expanded && pointerDepth === 0 && !toolOptions.get().alwaysShow.has(this.toolName)) {
        closeJobDetails(jobsForTool(this).map((job) => job.id));
      }
      noteSetExpanded(this, expanded, pointerDepth > 0);
    }
    // A framed call list draws its rows whatever pi's flag says (see
    // fullCodemodeBody), so what expanding opens there is the program and the
    // output: ctrl+o shows everything, and a click on the box does the same for
    // that one box. Its fold rows still open one section at a time.
    if (callListKind(this) && framedCallList(this)) {
      const sections = codemodeSections(this);
      sections.script = expanded;
      sections.output = expanded;
    }
    return originalSetExpanded.call(this, expanded);
  };

  /**
 * Tools whose body is a diff worth splitting. pi's write box previews the new
 * file as highlighted source, not a diff, so it is not one of them.
 */
const SPLIT_DIFF_TOOLS = new Set(["edit"]);

/**
 * The files a result reports, in the shape pi uses for a mutation.
 *
 * A tool that wraps `edit` can take something other than `{ path }` — aft's
 * hashline mode takes `{ patch }` and names the files it touched in its result
 * instead — so a box cannot assume the call arguments carry one.
 */
function resultFiles(details: unknown): Array<{ path?: unknown; sourcePath?: unknown }> {
  const files = (details as { files?: unknown } | undefined)?.files;
  return Array.isArray(files) ? files.filter((file) => file && typeof file === "object") : [];
}

/**
 * The file a box is about: the call's own `path`, or the one its result reports.
 *
 * Reading the result is what makes the path chip, the file-type icon and the
 * shortened title work for a tool that supplies its own renderers: those skip
 * pi's edit renderer, and with it `args.path` and the `preview` it keeps state on.
 * A result names files relative to the working directory (`aft` reports the
 * patch's own path), so those are resolved here: the box shows an absolute path
 * everywhere else, and a relative one would neither line up with it nor be worth
 * copying.
 */
function targetPath(tool: { args?: unknown; result?: { details?: unknown }; cwd?: string }, toolName: string): string | undefined {
  if (!PATH_ARG_TOOLS.has(toolName)) return undefined;
  const path = (tool.args as { path?: unknown } | undefined)?.path;
  if (typeof path === "string" && path) return path;
  for (const file of resultFiles(tool.result?.details)) {
    for (const candidate of [file.path, file.sourcePath]) {
      if (typeof candidate !== "string" || !candidate) continue;
      return isAbsolute(candidate) ? candidate : resolve(tool.cwd ?? process.cwd(), candidate);
    }
  }
  return undefined;
}

/**
 * The unified diff an edit box can draw.
 *
 * pi's edit renderer serialises it onto its call component (`preview.diff`),
 * which is the only source while the edit is still streaming. Once the result
 * is in, `details.diff` carries the same string — and it is the only one a tool
 * with renderers of its own leaves behind. Undefined means "keep what pi drew":
 * a preview error, or nothing to draw yet.
 */
function editDiff(tool: { callRendererComponent?: { preview?: unknown }; result?: { details?: unknown } }): string | undefined {
  const preview = tool.callRendererComponent?.preview as { diff?: unknown; error?: unknown } | undefined;
  if (preview) {
    if ("error" in preview) return undefined;
    if (typeof preview.diff === "string" && preview.diff) return preview.diff;
  }
  const diff = (tool.result?.details as { diff?: unknown } | undefined)?.diff;
  return typeof diff === "string" && diff ? diff : undefined;
}

/**
 * Rebuild an edit box's rows as two panes.
 *
 * pi's edit renderer keeps the unified diff string on its call component
 * (`preview.diff`) and renders it with `renderDiff`; the coloured lines are not
 * reversible, so the panes are built from that string instead. Undefined means
 * "keep what pi drew": no preview yet (streaming), a preview error, a narrow
 * box, or a diff that cannot be laid out.
 */
function splitEditBody(
  tool: ToolBoxInternals,
  innerWidth: number,
  callWidth: number,
  theme: ThemeLike,
): { raw: string[]; bgRows: ReadonlySet<number> } | undefined {
  const { splitDiff, splitDiffMinWidth, diffLines } = toolOptions.get();
  if (!splitDiff || !SPLIT_DIFF_TOOLS.has(tool.toolName) || innerWidth < splitDiffMinWidth) return undefined;
  const component = tool.callRendererComponent;
  const preview = component?.preview;
  if (preview && "error" in preview) return undefined;
  const diff = editDiff(tool);
  if (!diff) return undefined;
  const filePath = targetPath(tool, tool.toolName);
  // Collapsed, the body is a window on the diff; `ctrl+o` draws all of it.
  const maxLines = tool.expanded ? undefined : diffLines;
  // Row 0 is the call row (`edit ~/x.ts`), which keeps pi's rendering so the
  // icon prefix and path shortening still apply; the body starts with its own
  // summary row (`↳ diff +1 -1 [...]`). pi's edit renderer keeps the row as the
  // first child of a container; a renderer that hands back one component (aft's
  // hashline `edit`) has no children, and its own first row is the call row.
  const child = component?.children?.[0];
  const call = child ? child.render(callWidth) : (component?.render?.(callWidth) ?? []).slice(0, 1);
  // pi renders the whole transcript every frame — every wheel tick, every
  // streamed token — so each edit box in the history comes through here each
  // time. Rebuilding (and re-highlighting) its panes is what made scrolling a
  // long session crawl; the panes only change with these inputs. getTheme()
  // returns the actual instance, which pi replaces on theme switches/reloads.
  // Compare it directly: different themes may share the same added-text colour.
  // Unlike the codemode path below, which renders components and compares coloured
  // body rows, this cache starts from an uncoloured diff, so it must track the theme.
  const cache = tool.__splitCache;
  if (
    cache &&
    cache.diff === diff &&
    cache.width === innerWidth &&
    cache.maxLines === maxLines &&
    cache.filePath === filePath &&
    cache.theme === theme &&
    sameLines(cache.call, call)
  ) {
    return cache.value;
  }
  const body = renderSplitDiff({ diff, width: innerWidth, theme, filePath, maxLines });
  const offset = call.length;
  const value = body
    ? { raw: [...call, ...body.lines], bgRows: new Set(body.bgRows.map((row) => row + offset)) }
    : undefined;
  tool.__splitCache = { diff, width: innerWidth, maxLines, filePath, theme, call, value };
  return value;
}

/**
 * A codemode box's body as pi draws it expanded, without expanding the box.
 *
 * Collapsed, pi's renderer keeps ten script lines, the last eight calls and five
 * output lines, so a call list folded from that would drop calls and miscount
 * both sections. The framed call list is composed from a second rendering by
 * the same renderers at `expanded: true`, with components and state of its own:
 * pi's box, and anything another renderer keeps on its state, are never touched.
 * `executionStarted: false` keeps pi's timer out of it (it would arm an interval
 * on that state); the timer row is dropped from the composed body anyway.
 */
function fullCodemodeBody(tool: ToolBoxInternals, width: number, theme: ThemeLike): string[] | undefined {
  const definition = tool.toolDefinition;
  if (typeof definition?.renderCall !== "function") return undefined;
  const sample = theme.fg("toolTitle", "x");
  let cache = tool.__codemodeFull;
  if (
    !cache ||
    cache.args !== tool.args ||
    cache.result !== tool.result ||
    cache.isPartial !== tool.isPartial ||
    cache.sample !== sample
  ) {
    const state = {};
    const context = {
      args: tool.args,
      toolCallId: tool.toolCallId,
      invalidate: () => {
        tool.__codemodeFull = undefined;
        tool.ui?.requestRender?.();
      },
      lastComponent: undefined,
      state,
      cwd: tool.cwd,
      executionStarted: false,
      argsComplete: tool.argsComplete,
      isPartial: tool.isPartial,
      expanded: true,
      showImages: false,
      isError: tool.result?.isError ?? false,
      durationMs: tool.isPartial ? undefined : tool.result?.durationMs,
      outputPad: tool.outputPad ?? 1,
    };
    let body: Component | undefined;
    try {
      // The same shell pi draws into, so the rows line up with what it would show.
      const shell = tool.getRenderShell() === "self" ? new Container() : new Box(tool.outputPad ?? 1, 1);
      shell.addChild(definition.renderCall(tool.args, theme, context));
      if (tool.result && typeof definition.renderResult === "function") {
        const { content, details } = tool.result;
        shell.addChild(definition.renderResult({ content, details }, { expanded: true, isPartial: tool.isPartial }, theme, context));
      }
      body = shell;
    } catch {
      body = undefined;
    }
    cache = { args: tool.args, result: tool.result, isPartial: tool.isPartial, sample, body };
    tool.__codemodeFull = cache;
  }
  return cache.body?.render(width);
}

/**
 * `composeCodemodeBody`, kept per box. Every framed codemode box in the history
 * is composed on every frame, and every grouped one once it is open (all of
 * them after ctrl+o); splitting a body walks the text of each of its rows.
 */
function composedCodemode(
  tool: ToolBoxInternals,
  body: string[],
  theme: ThemeLike,
  options: CodemodeBodyOptions,
): ComposedCodemodeBody {
  const state = codemodeSections(tool);
  const details = tool.result?.details;
  const sample = theme.fg("accent", "x");
  const revision = optionsRevision();
  const cache = tool.__codemodeComposed;
  if (
    cache &&
    cache.details === details &&
    cache.script === state.script &&
    cache.output === state.output &&
    cache.revision === revision &&
    cache.width === options.width &&
    cache.hovered === options.hovered &&
    cache.sample === sample &&
    sameLines(cache.body, body)
  ) {
    return cache.value;
  }
  const value = composeCodemodeBody(body, details, state, theme, options);
  tool.__codemodeComposed = {
    body,
    details,
    script: state.script,
    output: state.output,
    revision,
    width: options.width,
    hovered: options.hovered,
    sample,
    value,
  };
  return value;
}

/** The text blocks of a result, joined: what the model was handed. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * `composeFabricBody`, kept per box. Same reason as the codemode body: every
 * open box is composed on every frame, and a nested diff re-highlights every
 * changed line of itself when it is rebuilt.
 */
function composedFabric(tool: ToolBoxInternals, theme: ThemeLike, options: CodemodeBodyOptions): ComposedCodemodeBody {
  const state = codemodeSections(tool);
  const details = tool.result?.details;
  const output = resultText(tool.result?.content);
  const sample = theme.fg("accent", "x");
  const revision = optionsRevision();
  const cache = tool.__fabricComposed;
  if (
    cache &&
    cache.args === tool.args &&
    cache.details === details &&
    cache.output === output &&
    cache.script === state.script &&
    cache.outputOpen === state.output &&
    cache.icons === options.icons &&
    cache.revision === revision &&
    cache.width === options.width &&
    cache.hovered === options.hovered &&
    cache.sample === sample
  ) {
    return cache.value;
  }
  const { bashResultLines, diffLines } = toolOptions.get();
  const value = composeFabricBody({
    args: tool.args,
    details,
    output,
    diffLines,
    outputLines: bashResultLines,
    state,
    theme,
    options,
  });
  tool.__fabricComposed = {
    args: tool.args,
    details,
    output,
    script: state.script,
    outputOpen: state.output,
    icons: options.icons,
    revision,
    width: options.width,
    hovered: options.hovered,
    sample,
    value,
  };
  return value;
}

/**
 * A framed call list: the row a group would show for the call
 * (`✓ codemode bash×2 read×1 · 0.1s`) in place of pi's title, then its rows,
 * with the program and the output folded to one row each. The row is handed
 * back apart from the body: every other framed tool puts its title in the top
 * border, and this one had no title of its own to put there. Undefined keeps
 * pi's layout: no renderer to draw it again, or nothing to fold yet (the
 * script is still streaming, or the output cannot be told from the calls).
 */
function composeFramedCallList(
  tool: ToolBoxInternals,
  kind: CallListKind,
  w: number,
  theme: ThemeLike,
  icons: boolean,
): { title: string; lines: string[]; toggles: CodemodeToggle[]; fills: ReadonlySet<number> } | undefined {
  const width = w - 2;
  // The rules and the title stop a cell short of the right border: pi's rows
  // keep a cell of padding there, as they do on the left.
  const options = { icons, width: width - 1, hovered: codemodeHover(tool) };
  let composed: ComposedCodemodeBody;
  if (kind === "fabric") {
    composed = composedFabric(tool, theme, options);
  } else {
    const body = fullCodemodeBody(tool, width, theme);
    if (!body) return undefined;
    composed = composedCodemode(tool, body, theme, options);
  }
  // A codemode list is only worth drawing once its script can be told from its
  // output; fabric's rows are built from the record, so they stand on their own.
  if (kind === "codemode" && composed.toggles.length === 0) return undefined;
  if (composed.lines.length === 0) return undefined;
  // The title reads the result, which the body was drawn from: a new result is
  // a new body, and so a new composition.
  const revision = optionsRevision();
  const cache = tool.__codemodeList;
  if (cache && cache.composed === composed && cache.w === w && cache.revision === revision) return cache.value;
  // The row goes into the top border, so it has to pay for the border's own
  // `╭─ ` and ` ─╮` cells before the body does: laid out at the full width it
  // would be clipped there, and the clip takes the duration first.
  const title = formatToolLine(tool, theme, { icons, width: Math.max(1, w - 6) });
  const value = {
    title,
    lines: composed.lines,
    toggles: composed.toggles,
    fills: new Set((composed.fills ?? []).map((fill) => fill.row)),
  };
  tool.__codemodeList = { composed, w, revision, value };
  return value;
}

/**
 * The boxes a wrapper's promoted calls draw below its own: a fabric edit's
 * diff, a write's content — the change itself, as a box of its own, the way a
 * model-issued edit draws. The rows are the frame's own (title in the border,
 * split panes for a diff), built from the audit, so they need no component of
 * their own and no click of their own either.
 */
function promotedCallBoxes(tool: ToolBoxInternals, w: number, theme: ThemeLike): string[] {
  if (!mergesNestedCalls(tool.toolName)) {
    tool.__promotedBoxes = undefined;
    return [];
  }
  const details = tool.result?.details;
  const revision = optionsRevision();
  const cache = tool.__promotedBoxes;
  // The details object is the record's identity: pi hands the same one back
  // until a new result lands, and the calls read from it cannot change without
  // it. Comparing the parsed calls instead would miss every time — the reader
  // builds fresh objects on every frame.
  if (cache && cache.details === details && cache.width === w && cache.revision === revision && cache.theme === theme) {
    return cache.rows;
  }
  const calls = nestedCallsOf(details).filter(isPromotedCall);
  if (calls.length === 0) {
    tool.__promotedBoxes = undefined;
    return [];
  }
  const { icons, toolColors, splitDiff, splitDiffMinWidth, diffLines } = toolOptions.get();
  const rows: string[] = [];
  for (const call of calls) {
    rows.push(...promotedCallBox(call, w, theme, { icons, toolColors, splitDiff, splitDiffMinWidth, diffLines }));
  }
  tool.__promotedBoxes = { details, width: w, revision, theme, rows, height: rows.length };
  return rows;
}

/** One promoted call as a framed box: title in the border, the change below. */
function promotedCallBox(
  call: NestedCall,
  w: number,
  theme: ThemeLike,
  options: { icons: boolean; toolColors: Record<string, string>; splitDiff: boolean; splitDiffMinWidth: number; diffLines: number },
): string[] {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : undefined;
  const failed = call.status === "error";
  const color = failed ? "error" : options.toolColors[call.name] || "accent";
  const inner = Math.max(2, w - 2);

  // The body: an edit's diff in the panes its own box uses, a write's content
  // as the text it wrote. A failed call keeps its error instead. Each is a
  // window of `diffLines` rows with the rest counted — nothing here opens
  // further, so an unbounded body would own the screen for good.
  const budget = Math.max(1, options.diffLines);
  const window = (lines: string[], paint: (line: string) => string): string[] => {
    const shown = lines.slice(0, budget).map((line) => ` ${paint(line)}`);
    if (lines.length > budget) shown.push(` ${theme.fg("dim", `… ${lines.length - budget} more line${lines.length - budget === 1 ? "" : "s"}`)}`);
    return shown;
  };
  let body: string[] = [];
  let bgRows: ReadonlySet<number> | undefined;
  if (failed && call.error) {
    body = window(call.error.split("\n"), (line) => theme.fg("error", line || " "));
  } else if (call.name === "edit" && call.diff) {
    const split = options.splitDiff && inner >= options.splitDiffMinWidth
      ? renderSplitDiff({ diff: call.diff, width: inner, theme, ...(path ? { filePath: path } : {}), maxLines: options.diffLines, hint: false })
      : undefined;
    if (split) {
      body = split.lines;
      bgRows = new Set(split.bgRows);
    } else {
      body = window(call.diff.split("\n"), (line) =>
        theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line || " "),
      );
    }
  } else if (call.name === "write" && typeof args.content === "string") {
    // A cell of padding, the way pi's own shell pads a box's body.
    body = window(args.content.replace(/\s+$/, "").split("\n"), (line) => theme.fg("toolOutput", line || " "));
  } else if (call.output) {
    body = window(call.output.split("\n"), (line) => theme.fg("toolOutput", line || " "));
  }

  // The title is the row a group would draw for the call, in the border.
  const title = formatToolLine(
    {
      toolName: call.name,
      args: path ? { ...args, path: shortenPath(path) } : args,
      isPartial: call.status === "running",
      result: {
        isError: failed,
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        content: call.output === undefined ? [] : [{ type: "text" as const, text: call.output }],
      },
    },
    theme,
    { icons: options.icons, width: Math.max(1, w - 6) },
  );
  const framed = drawFrame(body, w, theme, color, bgRows);
  framed[0] = labeledTopBorder(w, theme, color, clipToWidth(title.trim(), Math.max(1, w - 6), "…"));
  return framed;
}

/** The rounded box at width `w` (what pi would draw, reframed). */
  function frameBox(this: ToolBoxInternals, w: number, theme: ThemeLike, unframed = false): string[] {
    const { icons, toolColors } = toolOptions.get();
    const source = !this.hasRendererDefinition()
      ? this.contentText
      : this.getRenderShell() === "self"
        ? this.selfRenderContainer
        : this.contentBox;
    // The icon cells come off the call row's render width so nothing
    // truncates. Layout: ` <kind> <file> /tmp/x.ts` — the kind icon leads
    // (replacing the tool-name word, which is removed as redundant), the
    // file-type icon sits directly in front of the path (the same role
    // `$` plays for bash). When the path can't be located in the rendered
    // row, the file icon falls back into the prefix.
    let kindPrefix = "";
    let fileGlyph = "";
    let filePath = "";
    const pathArg = targetPath(this, this.toolName);
    // Read whether the icons are on or not: the path is also what the border's chip
    // copies, and that is not an icon.
    if (typeof pathArg === "string" && pathArg) filePath = pathArg;
    if (icons) {
      kindPrefix = ` ${toolKindIcon(this.toolName)} `;
      if (filePath) fileGlyph = fileIcon(filePath);
    }
    const iconCells = (kindPrefix ? visibleWidth(kindPrefix) : 0) + (fileGlyph ? visibleWidth(fileGlyph) + 1 : 0);
    const sourceWidth = w - 2 - iconCells;
    // A command's own lines hang on its first word: after `$ ` in a box of its own.
    // A group row carries the command at a column of its own and writes that one
    // before asking for the body (see renderGroupedTool), so only this path resets.
    if (!unframed && this.rendererState) this.rendererState.tidyCommandIndent = CALL_PROMPT_CELLS;
    const split = splitEditBody(this, w - 2, sourceWidth, theme);
    // Inside a group a codemode body is a call list: the script and the output
    // fold to one row each (they open on click, see tool-group-view.ts), and
    // every row sits one rail deeper than the call it belongs to. In a frame of
    // its own it is the same list, under the row a group would show for it.
    const kind = callListKind(this);
    const collapse = kind !== undefined && unframed;
    const listed = kind !== undefined && !unframed ? composeFramedCallList(this, kind, w, theme, icons) : undefined;
    const railCells = collapse ? 2 : 0;
    const codemodeRows: CodemodeToggle[] = [];
    const listOptions: CodemodeBodyOptions = { icons, width: sourceWidth - railCells, hovered: codemodeHover(this) };
    let raw: string[];
    let listFills: ReadonlySet<number> | undefined;
    if (collapse) {
      // fabric's rows are built from the record it kept, so pi's never have to
      // be drawn; codemode's are pi's own rows, so they are drawn a second time
      // at full length (see fullCodemodeBody).
      const composed = kind === "fabric"
        ? composedFabric(this, theme, listOptions)
        : composedCodemode(this, source.render(sourceWidth - railCells), theme, listOptions);
      const rail = `${theme.fg("borderMuted", "│")} `;
      raw = composed.lines.map((line) => rail + line);
      codemodeRows.push(...composed.toggles);
      listFills = new Set((composed.fills ?? []).map((fill) => fill.row));
    } else if (listed) {
      raw = listed.lines;
      listFills = listed.fills;
    } else {
      raw = kind === "codemode"
        ? decorateCodemodeBody(split ? split.raw : source.render(sourceWidth), this.result?.details, { icons, width: sourceWidth })
        : split
          ? split.raw
          : source.render(sourceWidth);
    }
    this.__codemodeToggles = codemodeRows;
    this.__callListFills = listFills;
    // The framed list's fold rows, as rows of this box's output: the top border
    // is row 0 and the body starts under it, so every row is one deeper.
    this.__codemodeFolds = listed?.toggles.map((toggle) => ({ row: toggle.row + 1, section: toggle.section }));
    // An open fold row reads the same hovered or not; only the band tells.
    const hovered = listed ? (codemodeHover(this) ?? "") : "";

    // The whole returned array is cached, not just the framed body.
    // pi-powerline-footer's compositor re-renders the entire root on every
    // mouse packet while scrolling, so an unchanged box must cost a key
    // check and nothing more — no re-framing its lines.
    //
    // Border color tracks tool state, then per-tool identity: pending is
    // grey and error is red no matter what; a successful box takes its
    // tool's configured color, falling back to the theme accent.
    const color = this.isPartial ? "borderMuted" : this.result?.isError ? "error" : toolColors[this.toolName] || "accent";
    // Image boxes skip the cache entirely: the line key says nothing about
    // an image component being swapped in (kitty PNG conversion finishes
    // asynchronously and rebuilds them), so a hit would freeze the box on
    // its pre-conversion frame.
    const cacheable = this.imageComponents.length === 0;
    const revision = optionsRevision();
    const cache = this.__frameCache;
    if (
      cacheable &&
      cache &&
      cache.width === w &&
      cache.color === color &&
      cache.expanded === this.expanded &&
      cache.revision === revision &&
      cache.unframed === unframed &&
      cache.hovered === hovered &&
      sameLines(cache.raw, raw)
    ) {
      this.__frameGeometry = cache.geometry;
      return cache.out;
    }

    // pi's default shell pads content by one cell on every side; the frame
    // supplies the vertical part, so only the blank padding rows are dropped.
    // `Text` hands back its own cached array — never write into `raw`.
    const edges = blankEdges(raw);
    let content = edges.start === 0 && edges.end === raw.length ? raw : raw.slice(edges.start, edges.end);
    // The kind icon prefixes the call row that pi drew first. A composed codemode
    // body has no call row: its first row is the script's fold label, which the
    // row above already introduces, and prefixing it pushed that row off the
    // body's rail (issue #31 review).
    if (icons && content.length > 0 && !collapse && !listed) {
      let first = content[0];
      // The kind icon already names the tool — drop the redundant word.
      if (PATH_ARG_TOOLS.has(this.toolName)) {
        const stripped = removeLeadingWord(first, this.toolName);
        if (stripped !== first) first = stripped.replace(/^ +/, "");
      }
      let row = kindPrefix + first;
      if (fileGlyph) {
        // renderToolPath shortens $HOME to `~` in the display text — try
        // the raw path first, then its shortened form.
        const home = homedir();
        const candidates = filePath.startsWith(home) ? [filePath, `~${filePath.slice(home.length)}`] : [filePath];
        let at = -1;
        for (const candidate of candidates) {
          const idx = visibleIndexOf(row, candidate);
          if (idx >= 0) {
            at = outsideHyperlink(row, idx);
            break;
          }
        }
        row = at >= 0 ? row.slice(0, at) + fileGlyph + " " + row.slice(at) : kindPrefix + fileGlyph + " " + first;
      }
      content = [row, ...content.slice(1)];
    }
    // Unframed means the call row is already the row above it: the body is the
    // output, not the command again. The blank row that separated them goes too.
    // A composed codemode body has already dropped pi's call row, and its first
    // row is the script's fold label, which is the body's to keep.
    if (unframed && content.length > 0 && !collapse) {
      content = content.slice(1);
      const rest = blankEdges(content);
      content = rest.start === 0 && rest.end === content.length ? content : content.slice(rest.start, rest.end);
    }
    // A file tool's call row is a title (`󰛦 󰈔 path`), not body: the frame's top
    // border is where a title belongs. So is a framed codemode list's summary
    // row, which a group draws above the box — the same row, one line up. Only
    // framed boxes have a border; inside a group the row above already carries
    // the call.
    const pathTitle = !unframed && !collapse && !listed && PATH_ARG_TOOLS.has(this.toolName) && content.length > 1
      ? trimTrailingSpaces(stripBackgroundFills(content[0])).trim()
      : "";
    let titleShift = 0;
    if (pathTitle) {
      // The write preview puts a blank row between its title and the text;
      // the border already separates them, so the body never starts with one.
      let lead = 1;
      while (lead < content.length && !visibleText(content[lead]).trim()) lead++;
      content = content.slice(lead);
      titleShift = lead;
    }
    const title = pathTitle || (listed?.title.trim() ?? "");
    // The fold row under the pointer wears the hover band, inside the frame.
    let banded: ReadonlySet<number> | undefined;
    const bandRow = hovered ? listed?.toggles.find((toggle) => toggle.section === hovered)?.row : undefined;
    if (bandRow !== undefined && bandRow < content.length) {
      content = content.slice();
      content[bandRow] = hoverBand(content[bandRow]!, w - 2, theme);
      banded = new Set([bandRow]);
    }
    const drawn: string[] = [];
    this.__pathChip = undefined;
    if (content.length > 0) {
      // Split-diff rows carry their own tint, as does a hovered fold row;
      // everything else stays transparent.
      const splitBg = split && edges.start > 0
        ? new Set([...split.bgRows].map((row) => row - edges.start).filter((row) => row >= 0))
        : split?.bgRows;
      // A call list's own tinted rows (a nested diff) are indexed in the body it
      // drew; the same trimming that moved everything else moved them.
      const listBg = this.__callListFills && edges.start > 0
        ? new Set([...this.__callListFills].map((row) => row - edges.start).filter((row) => row >= 0))
        : this.__callListFills;
      const contentBg = splitBg && listBg ? new Set([...splitBg, ...listBg]) : (splitBg ?? listBg);
      const bgRows = banded ?? (contentBg && titleShift
        ? new Set([...contentBg].map((row) => row - titleShift).filter((row) => row >= 0))
        : contentBg);
      const framed = drawFrame(content, w, theme, color, bgRows);
      // A border that names a file carries a chip: the path is the one thing a reader
      // wants out of a write or edit box, and dragging its border for it is not obvious.
      const chipText = pathTitle && filePath && canCopyText() ? chipLabels(icons).copy : "";
      const paintedChip = chipText ? chipWord(theme, chipText, false) : "";
      const label = chipText
        ? `${clipToWidth(title, Math.max(1, w - 6 - visibleWidth(chipText) - 1), "…")} ${paintedChip}`
        : clipToWidth(title, Math.max(1, w - 6), "…");
      if (title) framed[0] = labeledTopBorder(w, theme, color, label);
      // The chip is measured on the rows this component displays, not on this frame:
      // a group's header row and a turn's rail sit in front of it.
      this.__pathChip = chipText && visibleText(framed[0]!).includes(chipText) ? chipText : undefined;
      this.__pathText = chipText ? shortenPath(filePath) : undefined;
      // Unframed: the row above already carries the frame of reference (the
      // group rail), so only the body is drawn — borders dropped, cells kept.
      if (unframed) {
        // Borders dropped, cells kept: the body is the content columns only.
        for (const line of framed.slice(1, -1)) drawn.push(sliceByColumn(line, 1, Math.max(1, w - 2)));
      } else {
        for (const line of framed) drawn.push(line);
      }
    }
    // No leading spacer: the box butts against whatever came before it. pi
    // puts one there for its own unframed shell, which we replaced with the
    // frame — inside a transcript it just reads as a stray blank row.
    const out: string[] = drawn;
    // Output: [spacer, top border, content…, bottom border] — content row 0
    // is source row `edges.start`. Unframed drops the spacer and both borders,
    // so the body starts on the first line.
    const geometry: FrameGeometry = unframed
      ? { top: -(edges.start + 1), height: raw.length, width: sourceWidth - 2, bordered: false }
      : { top: 1 - edges.start - titleShift, height: raw.length, width: sourceWidth };
    this.__frameGeometry = content.length > 0 ? geometry : undefined;
    // Images stay outside the frame: their lines carry terminal graphics
    // payloads that padding/truncation would corrupt.
    for (let i = 0; i < this.imageComponents.length; i++) {
      const spacer = this.imageSpacers[i];
      if (spacer) for (const line of spacer.render(w)) out.push(line);
      const image = this.imageComponents[i];
      if (image) for (const line of image.render(w)) out.push(line);
    }

    if (out.length === 0) return [];
    if (cacheable) this.__frameCache = { width: w, color, expanded: this.expanded, revision, unframed, hovered, raw, out, geometry };
    return out;
  }

  proto.render = function (this: ToolBoxInternals, width: number): string[] {
    const theme = getTheme();
    if (!theme || !tidyEnabled.get()) {
      this.__frameGeometry = undefined;
      this.__pathChip = undefined;
      measurePathChip(this, []);
      return originalRender.call(this, width);
    }
    try {
      this.__tidyTurnRendered = true;
      if (this.hideComponent) {
        measurePathChip(this, []);
        return [];
      }
      if (hideTurnTool(this.toolCallId)) {
        // A folded turn forgets which of its calls were open, the way folding a group
        // forgets the boxes inside it (see closeGroup): reopening either starts from the
        // plain rows it started with. Nothing of the box is on screen while its turn is
        // folded, so this is the frame that has to do it. The reset is made as a pointer
        // would, so it leaves the group's level and the turn's own fold alone.
        if (this.expanded) asPointer(() => this.setExpanded(false));
        // Carriers still register while the turn is folded. Its tools must
        // register too, especially the pinned boundaries that split groups.
        if (grouping()) planFor(this, toolOptions.get().alwaysShow.has(this.toolName));
        measurePathChip(this, []);
        return [];
      }
      const railed = railTurnTool(this.toolCallId);
      const w = Math.max(4, railed ? width - TURN_RAIL_CELLS : width);
      // A wrapper's promoted calls draw as boxes of their own, below whatever
      // this box drew — folded or open, the change itself stays visible. On a
      // turn's rail they hang on it too: the rail runs down everything the run
      // drew, and a box outside it would read as a stranger's.
      const withPromoted = (rows: string[], boxWidth: number, railPad?: string): string[] => {
        this.__lastOwnRows = rows.length;
        const promoted = promotedCallBoxes(this, boxWidth, theme);
        if (promoted.length === 0) return rows;
        return [...rows, ...(railPad === undefined ? promoted : railRows(promoted, theme, railPad))];
      };
      if (grouping()) {
        const { icons, alwaysShow, highlightBash, toolRowLines } = toolOptions.get();
        const grouped = renderGroupedTool(
          this,
          w,
          theme,
          { icons, pinned: alwaysShow.has(this.toolName), highlight: highlightBash, rowLines: toolRowLines },
          (boxWidth, unframed) => frameBox.call(this, boxWidth, theme, unframed),
        );
        if (grouped) {
          this.__railCells = TURN_RAIL_CELLS;
          return finishBox(this, railed ? withPromoted(railRows(grouped, theme), w, "") : withPromoted(grouped, w), theme);
        }
      }
      if (!railed) return finishBox(this, withPromoted(frameBox.call(this, w, theme), w), theme);
      this.__railCells = TURN_RAIL_BOX_CELLS;
      const boxWidth = Math.max(4, width - TURN_RAIL_BOX_CELLS);
      const box = frameBox.call(this, boxWidth, theme);
      // On the rail a box's corner sits in its neighbouring groups' rail column. With
      // grouping off nothing has registered, so there is nothing to meet.
      const { above, below } = pinnedJoints(this);
      return finishBox(this, withPromoted(railRows(joinBoxCorners(box, above, below), theme, " "), boxWidth, " "), theme);
    } catch {
      this.__frameGeometry = undefined;
      measurePathChip(this, []);
      return originalRender.call(this, width);
    }
  };
}
