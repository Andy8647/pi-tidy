/**
 * How a tool box looks and reacts while it belongs to a group (tool-groups.ts
 * owns the state; this file turns a `ViewPlan` into lines and clicks):
 *
 *    ▸ 3 calls ·  bash×3 · 1 failed · 0.5s     header, carried by the first member
 *    │ ✗ bash  pnpm test  exit 1 · 0.4s       a row (running/failed rows show while folded)
 *    │ ╭──────────────╮                       a full box, three cells in
 *
 * Also installs the boundary hooks on the message components, which is where
 * the groups get cut.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { getTheme, type ThemeLike } from "./theme-access.ts";
import { formatGroupLine, formatToolLine, GUTTER_CELLS, groupGutter } from "./tool-lines.ts";
import {
  carrierView,
  classifyAssistant,
  closeGroup,
  noteBoundary,
  openGroup,
  planFor,
  summaryFor,
  takeLateJoin,
  toolCallIds,
  type CarrierView,
  type ViewPlan,
} from "./tool-groups.ts";

/** The slice of ToolExecutionComponent the group view reads. */
export interface GroupedTool {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  isPartial: boolean;
  expanded: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
  imageComponents?: unknown[];
  ui?: { requestRender?(): void };
  setExpanded(expanded: boolean): void;
}

/**
 * Cells a grouped full box is shifted right by: the gutter plus a space. Boxes
 * with images skip the gutter — their lines carry graphics payloads that must
 * start at the left edge.
 */
function boxIndent(tool: GroupedTool, plan: ViewPlan): number {
  return plan.gutter && !(tool.imageComponents?.length ?? 0) ? GUTTER_CELLS + 1 : 0;
}

/**
 * The tool's lines while grouping is on, or `undefined` when it is an
 * always-shown tool and should render as a plain box.
 */
export function renderGroupedTool(
  tool: GroupedTool,
  width: number,
  theme: ThemeLike,
  options: { icons: boolean; pinned: boolean },
  frameBox: (width: number) => string[],
): string[] | undefined {
  // Another extension may have patched a boundary render on top of ours
  // since; re-wrap so the boundaries keep being seen.
  installGroupBoundaries();
  const plan = planFor(tool, options.pinned);
  if (takeLateJoin()) tool.ui?.requestRender?.();
  if (!plan.header && !plan.gutter) return undefined;

  const { icons } = options;
  const lines: string[] = [];
  if (plan.header) {
    const summary = summaryFor(tool);
    if (summary) lines.push(truncateToWidth(formatGroupLine(summary, theme, { icons, open: plan.header === "open" }), width, "…"));
  }
  const gutter = groupGutter(theme);
  if (plan.line) {
    lines.push(truncateToWidth(gutter + formatToolLine(tool, theme, { icons }), width, "…"));
  }
  if (plan.full) {
    const indent = boxIndent(tool, plan);
    for (const line of frameBox(Math.max(4, width - indent))) {
      lines.push(indent ? (line ? `${gutter} ${line}` : gutter) : line);
    }
  }
  return lines;
}

/** `routeGroupedMouse` result meaning "not grouped: handle it as a plain box". */
export const NOT_GROUPED = Symbol("not grouped");

export interface MouseRouting {
  pinned: boolean;
  /** Run `fn` as pointer-driven (pi's box toggle must not read as ctrl+o). */
  asPointer<T>(fn: () => T): T;
  /** Hand the event to the full box, shifted by the gutter and header. */
  boxMouse(event: any, dx: number, dy: number): unknown;
}

/**
 * Clicks on a grouped tool. Only left clicks on our own rows are taken —
 * presses and drags fall through so text selection keeps working.
 */
export function routeGroupedMouse(tool: GroupedTool, event: any, routing: MouseRouting): unknown {
  const plan = planFor(tool, routing.pinned);
  if (!plan.header && !plan.gutter) return NOT_GROUPED;

  // pi-tui names buttons ("left"); accept the raw SGR code too.
  const click = event?.type === "click" && (event.button === "left" || event.button === 0);
  let y = event?.y;
  if (plan.header) {
    if (y === 0) {
      if (!click) return undefined;
      if (plan.header === "closed") openGroup(tool);
      else for (const member of closeGroup(tool)) routing.asPointer(() => (member as GroupedTool).setExpanded(false));
      // 层级是跨组件的状态;pi 每帧都重渲染整个 transcript,请求一帧即可
      tool.ui?.requestRender?.();
      return { handled: true };
    }
    y -= 1;
  }
  if (plan.line) {
    if (y !== 0 || !click) return undefined;
    // A row always means "this call's box" — also the running/failed row
    // under a folded header, which opens the group on the way.
    openGroup(tool);
    // 走 setExpanded 而不是直接改字段:pi 的 updateDisplay 才会重建盒子
    routing.asPointer(() => tool.setExpanded(true));
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  if (plan.full) return routing.boxMouse(event, boxIndent(tool, plan), plan.header ? 1 : 0);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary hooks
// ─────────────────────────────────────────────────────────────────────────────

const BOUNDARY_WRAPPER = Symbol.for("pi-toolbox:group-boundary");

type RenderFn = ((this: any, ...args: any[]) => string[]) & { [BOUNDARY_WRAPPER]?: true };

/** Whether grouping is on right now (the tool patch keeps this current). */
let groupingActive: () => boolean = () => true;

export function setGroupingActive(active: () => boolean): void {
  groupingActive = active;
}

/**
 * Wrap `proto.render` unless the outermost wrapper is already ours. `view`
 * decides per render: draw as usual, draw nothing, or draw under the group
 * gutter (two cells narrower, `│` in front).
 */
function wrapBoundaryRender(proto: { render?: RenderFn } | undefined, view: (component: any) => CarrierView): void {
  const render = proto?.render;
  if (typeof render !== "function" || render[BOUNDARY_WRAPPER]) return;
  const wrapped: RenderFn = function (this: any, ...args: any[]) {
    if (!groupingActive()) return render.apply(this, args);
    const how = view(this);
    if (how === "hidden") return [];
    const [width, ...rest] = args;
    const theme = how === "gutter" ? getTheme() : undefined;
    if (!theme || typeof width !== "number" || width <= GUTTER_CELLS + 4) return render.apply(this, args);
    const gutter = groupGutter(theme);
    return render.call(this, width - GUTTER_CELLS, ...rest).map((line) => gutter + line);
  };
  wrapped[BOUNDARY_WRAPPER] = true;
  proto!.render = wrapped;
}

/**
 * Group boundaries are seen through the message components' render. These
 * wrappers must be the *outermost* layer: pi-starline restyles
 * UserMessageComponent with a render patch that never calls its predecessor,
 * so a wrapper installed underneath it (toolbox loads first) would never run.
 * Hence this runs at patch time and again from the tool render, by which time
 * every extension has installed its patches.
 */
export function installGroupBoundaries(): void {
  wrapBoundaryRender((AssistantMessageComponent as any)?.prototype, (component) => {
    const role = classifyAssistant(component.lastMessage);
    if (role === "boundary") noteBoundary(component);
    else if (role === "carrier") return carrierView(component, toolCallIds(component.lastMessage));
    return "plain";
  });
  wrapBoundaryRender((UserMessageComponent as any)?.prototype, (component) => {
    noteBoundary(component);
    return "plain";
  });
}
