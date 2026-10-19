/**
 * Three-level collapsing for the tool calls of one assistant segment:
 *
 *   0  ▸ 4 calls ·  bash×3  read×1 · 1.2s      (常态;整段工具只剩一行)
 *   1  ▾ 4 calls ·  bash×3  read×1 · 1.2s      (click: back to 0)
 *      │ ✓ bash  cd ~ && python3 - <<'PY' (+26 lines)  0.1s
 *      │ ✓ read  src/app.ts  0.1s
 *   2  │ the full rounded box (what pi renders natively, output preview included)
 *
 * The `│` gutter marks what belongs to the open group. Tools in
 * `alwaysShowTools` (edit/write by default: their diff is the point) never
 * fold — they render as pi's own box and close the group before them, so the
 * calls after one start a new group and the transcript stays in order.
 *
 * One group = the tool calls between two *boundaries*: a user message, or an
 * assistant message with visible text. pi gives every model step its own
 * assistant message, and a step that only calls a tool carries no text — those
 * "carrier" messages do not break the group, so a reply that runs six tools in
 * six steps still folds into one line. The text itself always renders, which is
 * what lets you see a reply drifting.
 *
 * Membership is decided *at render time* from transcript order, which is also
 * what makes it survive a session reload: pi rebuilds the components in order.
 * Every frame renders the whole transcript top to bottom, so a boundary's render
 * only *selects* its group (keyed by the component); it never resets anything.
 * A tool or carrier joins the selected group the first time it renders and stays
 * there.
 *
 * Nothing here touches pi's own expand flag except through `setExpanded`, which
 * is why `ctrl+o` and pi's built-in click-to-expand keep working: both land here
 * first and get translated into "level 1" / "level 2".
 */

export interface GroupMember {
  toolName: string;
  durationMs?: number;
  isPartial: boolean;
  isError?: boolean;
}

export interface BreakdownEntry {
  name: string;
  count: number;
}

export interface GroupSummary {
  count: number;
  /** Per-tool counts, most frequent first, ties alphabetical. */
  breakdown: BreakdownEntry[];
  /** Sum of the durations that are known (running tools have none yet). */
  durationMs: number;
  /** Tool name of the member still executing, if any. */
  running?: string;
  /** Members that finished with an error. */
  failed: number;
}

/** Pure: what the summary line says, independent of theme or icons. */
export function buildGroupSummary(members: GroupMember[]): GroupSummary {
  const counts = new Map<string, number>();
  let durationMs = 0;
  let running: string | undefined;
  let failed = 0;
  for (const member of members) {
    if (!member.isPartial && member.isError) failed++;
    counts.set(member.toolName, (counts.get(member.toolName) ?? 0) + 1);
    if (typeof member.durationMs === "number" && Number.isFinite(member.durationMs)) {
      durationMs += member.durationMs;
    }
    if (member.isPartial && running === undefined) running = member.toolName;
  }
  const breakdown = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { count: members.length, breakdown, durationMs, running, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assistant message roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - `boundary`: has visible text → starts a group, renders as usual
 * - `carrier`:  only thinking + tool calls → belongs to the current group and
 *               shows only next to its own call's full box (otherwise every
 *               step's `Thinking...` label would sit between the rows)
 * - `plain`:    anything else (still streaming its thinking, an error, a
 *               truncation notice) → renders as usual, leaves grouping alone
 */
export type AssistantRole = "boundary" | "carrier" | "plain";

interface AssistantMessageLike {
  content?: unknown;
  stopReason?: unknown;
}

export function classifyAssistant(message: AssistantMessageLike | undefined): AssistantRole {
  // Unknown shape (pi changed the field): keep the old behaviour, never hide.
  if (!message || !Array.isArray(message.content)) return "boundary";
  let hasToolCall = false;
  for (const block of message.content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return "boundary";
    if (block?.type === "toolCall") hasToolCall = true;
  }
  // A length stop renders "Response was truncated" — never fold that away.
  if (hasToolCall && message.stopReason !== "length") return "carrier";
  return "plain";
}

/** The ids of the tool calls a message carries (matched against `toolCallId`). */
export function toolCallIds(message: AssistantMessageLike | undefined): string[] {
  if (!message || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content as Array<{ type?: unknown; id?: unknown }>) {
    if (block?.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────────

/** What a component should draw this frame, top to bottom. */
export interface ViewPlan {
  /** The group's summary line, carried by its first member: `▸` folded, `▾` open. */
  header: "closed" | "open" | null;
  /** The one-row view of this call. */
  line: boolean;
  /** The full box. */
  full: boolean;
  /** Indent `line`/`full` under a `│` gutter: they belong to the header above. */
  gutter: boolean;
}

/** An always-shown tool: pi's own box, nothing else. */
const PINNED: ViewPlan = { header: null, line: false, full: true, gutter: false };

/** Where a carrier message should render, if at all. */
export type CarrierView = "hidden" | "plain" | "gutter";

interface ToolLike {
  toolName: string;
  toolCallId?: string;
  isPartial: boolean;
  expanded: boolean;
  result?: { durationMs?: number; isError?: boolean };
}

/** Finished with an error: keeps its row visible even while folded. */
const failed = (tool: ToolLike) => !tool.isPartial && tool.result?.isError === true;

interface Group {
  level: 0 | 1;
  /** The tool components themselves, so the summary always reads live state. */
  members: ToolLike[];
}

const newGroup = (): Group => ({ level: 0, members: [] });

/** The group of the boundary rendered most recently in this frame. */
let current: Group = newGroup();
const groupOfBoundary = new WeakMap<object, Group>();
const groupOf = new WeakMap<object, Group>();
const groupOfCarrier = new WeakMap<object, Group>();
/** Always-shown tools by call id, so the step that carried one can follow it. */
const pinnedById = new Map<string, WeakRef<ToolLike>>();
/** A tool joined a group whose summary line already rendered this frame. */
let lateJoin = false;

/**
 * A boundary component rendered: what follows it (until the next boundary)
 * belongs to its group. Idempotent — called on every frame.
 */
export function noteBoundary(component: object): void {
  let group = groupOfBoundary.get(component);
  if (!group) {
    group = newGroup();
    groupOfBoundary.set(component, group);
  }
  current = group;
}

/**
 * A carrier message rendered; where to draw it: only while one of the calls it
 * carries is a full box, so level 1 stays one row per call and ctrl+o's
 * expand-all looks like pi's native transcript. Without ids to match (field
 * missing), any full box in the group shows it.
 */
export function carrierView(component: object, toolCallIds: readonly string[] = []): CarrierView {
  let group = groupOfCarrier.get(component);
  if (!group) {
    group = current;
    groupOfCarrier.set(component, group);
  }
  for (const id of toolCallIds) {
    if (pinnedById.get(id)?.deref()?.expanded) return "plain";
  }
  if (group.level === 0) return "hidden";
  const shown = group.members.some(
    (member) =>
      member.expanded &&
      (toolCallIds.length === 0 || (member.toolCallId !== undefined && toolCallIds.includes(member.toolCallId))),
  );
  return shown ? "gutter" : "hidden";
}

function join(tool: ToolLike): Group {
  const known = groupOf.get(tool);
  if (known) return known;
  const group = current;
  // The summary sits on the first member, which rendered before this one:
  // its count is one short until the next frame. An expanded newcomer also
  // un-hides its carrier, which rendered before it too.
  if (group.members.length > 0 || tool.expanded) lateJoin = true;
  group.members.push(tool);
  // pi hands a new box `setExpanded(toolOutputExpanded)` before it ever
  // renders: arriving already expanded means ctrl+o's expand-all is on.
  if (tool.expanded) group.level = 1;
  groupOf.set(tool, group);
  return group;
}

/**
 * Whether a tool joined an existing group since the last call. The render
 * patch then asks pi for one more frame, so the summary line catches up.
 */
export function takeLateJoin(): boolean {
  const late = lateJoin;
  lateJoin = false;
  return late;
}

/**
 * `pinned`: the tool is in `alwaysShowTools`. It draws pi's own box and acts as
 * a boundary — whatever follows it starts a new group.
 */
export function planFor(tool: ToolLike, pinned = false): ViewPlan {
  if (pinned) {
    if (tool.toolCallId && !pinnedById.has(tool.toolCallId)) {
      pinnedById.set(tool.toolCallId, new WeakRef(tool));
      // Its carrier rendered just before it, before it could be found.
      if (tool.expanded) lateJoin = true;
    }
    noteBoundary(tool);
    return PINNED;
  }
  const group = join(tool);
  const header = group.members[0] === tool ? (group.level === 0 ? "closed" : "open") : null;
  if (group.level === 0) {
    // 运行中的那个露一行 B,否则长命令跑三十秒时 C 行一动不动;
    // 失败的也露,报错不该藏在 C 行里
    return { header, line: tool.isPartial || failed(tool), full: false, gutter: true };
  }
  return { header, line: !tool.expanded, full: tool.expanded, gutter: true };
}

export function summaryFor(tool: ToolLike): GroupSummary | undefined {
  const group = groupOf.get(tool);
  if (!group) return undefined;
  return buildGroupSummary(
    group.members.map((member) => ({
      toolName: member.toolName,
      isPartial: member.isPartial,
      isError: member.result?.isError === true,
      durationMs: member.isPartial ? undefined : member.result?.durationMs,
    })),
  );
}

/** Level 0 → 1: the summary line unfolds into one row per call. */
export function openGroup(tool: object): void {
  const group = groupOf.get(tool);
  if (group) group.level = 1;
}

/**
 * Level 1 → 0 from the `▾` header. Returns the members still showing a full
 * box; the caller folds them through pi's `setExpanded`, so reopening the
 * group starts from plain rows again.
 */
export function closeGroup(tool: object): ToolLike[] {
  const group = groupOf.get(tool);
  if (!group) return [];
  group.level = 0;
  return group.members.filter((member) => member.expanded);
}

/**
 * pi calls `setExpanded` for `ctrl+o` (every box, `fromPointer` false) and for
 * a click on a full box (that one box, `fromPointer` true).
 *
 * Expanding anything opens the group, so the rows become reachable. Collapsing
 * from a click folds that box back into its row; collapsing from ctrl+o's
 * collapse-all returns the whole group to its summary line.
 */
export function noteSetExpanded(tool: object, expanded: boolean, fromPointer: boolean): void {
  const group = groupOf.get(tool);
  if (!group) return;
  if (expanded) group.level = 1;
  else if (!fromPointer) group.level = 0;
}

/** Test seam: forget the current group (WeakMaps drop with their components). */
export function resetGroups(): void {
  current = newGroup();
  lateJoin = false;
}
