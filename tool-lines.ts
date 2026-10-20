/**
 * The two one-line views: the group summary (level 0) and a single tool row
 * (level 1). Pure string building — no component or pi state — so both are
 * cheap to render every frame and trivial to test.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { toolKindIcon } from "./icons.ts";
import type { ThemeLike } from "./theme-access.ts";
import type { JobState } from "./background-jobs.ts";
import type { GroupSummary } from "./tool-groups.ts";

export interface LineOptions {
  /** Prepend each tool's Nerd Font kind icon. */
  icons?: boolean;
  /** Icon cells are dropped when a terminal has no Nerd Font. */
  maxArgChars?: number;
  /** Group line only: the group is unfolded (`▾`) rather than folded (`▸`). */
  open?: boolean;
  /** The pointer is on this row: the glyph turns solid, a tool row gains a `›`. */
  hovered?: boolean;
  /** Group line: the glyph for running background jobs. Tool line: this job's. */
  spinner?: string;
  /** Tool line only: the background job this call started. */
  job?: JobState;
}

const DEFAULT_MAX_ARG_CHARS = 60;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** `▸ 4 calls ·  bash×3  read×1 · 1.2s` (`▾` while the group is open) */
export function formatGroupLine(summary: GroupSummary, theme: ThemeLike, options: LineOptions = {}): string {
  const { icons = true, open = false, hovered = false } = options;
  const glyph = open ? "▾" : hovered ? "▶" : "▸";
  const parts: string[] = [
    `${theme.fg("accent", glyph)} ${theme.fg("toolTitle", `${summary.count} ${summary.count === 1 ? "call" : "calls"}`)}`,
  ];

  const breakdown = summary.breakdown.map(({ name, count }) => {
    const icon = icons ? `${toolKindIcon(name)} ` : "";
    return theme.fg("muted", `${icon}${name}×${count}`);
  });
  if (breakdown.length > 0) parts.push(breakdown.join(theme.fg("muted", "  ")));

  // Folded, this is the *only* report that anything failed — no row hangs
  // below it — so it takes the red. Open, the rows below each carry their own
  // `✗` and the count goes quiet. No glyph of its own either way: `32 calls`
  // needs no cross beside it, the colour is the signal.
  if (summary.failed > 0) parts.push(theme.fg(open ? "muted" : "error", `${summary.failed} failed`));
  if (summary.jobsRunning > 0) {
    parts.push(theme.fg("accent", `${options.spinner ?? "◐"} ${summary.jobsRunning} running`));
  }

  if (summary.running) {
    parts.push(theme.fg("warning", `running ${summary.running}`));
  } else if (summary.durationMs > 0) {
    parts.push(theme.fg("muted", formatDuration(summary.durationMs)));
  }

  return ` ${parts.join(theme.fg("muted", " · "))}`;
}

interface ToolLike {
  toolName: string;
  args?: unknown;
  isPartial: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The text blocks of a tool result, joined. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Lines of real output, pi's own notices excluded. */
function realLines(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        line.trim() !== "(no output)" &&
        !/^\[Showing /.test(line) &&
        !/^Command (exited with code|terminated)/.test(line),
    );
}

function outputLines(text: string, details: unknown): number {
  const total = (details as { truncation?: { truncated?: unknown; totalLines?: unknown } } | undefined)?.truncation;
  if (total?.truncated === true && typeof total.totalLines === "number") return total.totalLines;
  return realLines(text).length;
}

/**
 * A failure with nothing to read: the call exited non-zero and said nothing —
 * `sed` on a path that moved, a `test`, a probe. Those are mundane; a failure
 * whose output has actual text is where the red belongs. pi's own trailing
 * notices (`Command exited with code 1`, `(no output)`, the truncation line)
 * do not count as text, but a timeout or an abort does.
 */
export function isSilentFailure(result: ToolLike["result"]): boolean {
  if (!result || result.isError !== true) return false;
  return realLines(resultText(result.content)).length === 0;
}

/**
 * What a finished call produced, in a few words — the part of Claude Code's
 * `Read 120 lines` that makes a folded row worth reading. Built-in tools only;
 * anything else (MCP, extensions) gets no note rather than a wrong one.
 */
export function summarizeResult(toolName: string, result: ToolLike["result"]): string {
  if (!result) return "";
  const text = resultText(result.content);
  switch (toolName) {
    case "bash": {
      const code = /Command exited with code (\d+)/.exec(text)?.[1];
      if (result.isError) return code ? `exit ${code}` : "";
      const lines = outputLines(text, result.details);
      return lines > 0 ? plural(lines, "line") : "";
    }
    case "read":
      return result.isError ? "" : plural(outputLines(text, result.details), "line");
    case "grep":
      if (result.isError) return "";
      return text.trim() === "No matches found" ? "no matches" : plural(outputLines(text, result.details), "match", "matches");
    case "find":
      if (result.isError) return "";
      return /^No files found/.test(text.trim()) ? "no files" : plural(outputLines(text, result.details), "file");
    case "ls":
      if (result.isError) return "";
      return text.trim() === "(empty directory)" ? "empty" : plural(outputLines(text, result.details), "entry", "entries");
    default:
      return "";
  }
}

/**
 * The one-string description of a call's arguments: a shell command's first
 * line, a file's path, or the first stringish argument it can find.
 */
export function summarizeArgs(toolName: string, args: unknown, maxChars = DEFAULT_MAX_ARG_CHARS): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;

  const command = typeof record.command === "string" ? record.command : undefined;
  if (command) {
    const [first, ...rest] = command.split("\n");
    const head = first.trim();
    const truncated = head.length > maxChars ? `${head.slice(0, maxChars - 1)}…` : head;
    return rest.length > 0 ? `${truncated} (+${rest.length} lines)` : truncated;
  }

  for (const key of ["path", "file_path", "filePath", "pattern", "url", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }

  for (const value of Object.values(record)) {
    if (typeof value === "string" && value) {
      return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
    }
  }
  return "";
}

/** `running 12s · READY matched` / `exited 0 · 20s` / `killed SIGTERM · 3s` */
export function describeJob(job: JobState, now = Date.now()): string {
  const end = job.status === "running" ? now : job.endTime;
  const took = job.startTime !== undefined && end !== undefined ? formatElapsed(end - job.startTime) : "";
  const parts: string[] = [];
  switch (job.status) {
    case "running":
      parts.push(took ? `running ${took}` : "running");
      break;
    case "done":
      parts.push(`exited ${job.exitCode ?? 0}`);
      break;
    case "failed":
      parts.push(typeof job.exitCode === "number" ? `exit ${job.exitCode}` : "failed");
      break;
    case "killed":
      parts.push(job.signal ? `killed ${job.signal}` : "killed");
      break;
    case "gone":
      return "not running";
  }
  if (job.status !== "running" && took) parts.push(took);
  if (job.note) parts.push(job.note);
  return parts.join(" · ");
}

/** Whole seconds, then minutes: `12s`, `3m05s`, `1h02m`. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")}m`;
}

/** ` ✓ bash cd ~ && python3 - <<'PY' (+26 lines)  3 lines · 0.1s` */
export function formatToolLine(tool: ToolLike, theme: ThemeLike, options: LineOptions = {}): string {
  const { icons = true, job } = options;
  if (job) return formatJobLine(tool, job, theme, icons, options.spinner);
  const { isPartial } = tool;
  const isError = !isPartial && tool.result?.isError === true;
  // A silent failure keeps its red glyph and drops the rest to `dim`: it is
  // still visibly a failure, but it stops competing with the reply's text.
  const silent = isSilentFailure(tool.result);
  const body = silent ? "dim" : undefined;

  const status = isPartial
    ? theme.fg("muted", "⋯")
    : isError
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");

  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  const name = theme.fg(body ?? "toolTitle", `${icon}${tool.toolName}`);
  const detail = summarizeArgs(tool.toolName, tool.args, options.maxArgChars);
  const detailText = detail ? theme.fg(body ?? "toolOutput", ` ${detail}`) : "";

  // `  12 lines · 0.3s` — what it produced, then how long it took.
  const tail: string[] = [];
  if (!isPartial) {
    const note = summarizeResult(tool.toolName, tool.result);
    // Not red: the glyph already says it failed, and `exit 1` is data.
    if (note) tail.push(theme.fg(body ?? "muted", note));
    const durationMs = tool.result?.durationMs;
    if (typeof durationMs === "number" && durationMs > 0) tail.push(theme.fg(body ?? "muted", formatDuration(durationMs)));
  }
  const tailText = tail.length > 0 ? `  ${tail.join(theme.fg("muted", " · "))}` : "";
  const hint = options.hovered ? theme.fg("muted", "  ›") : "";

  return ` ${status} ${name}${detailText}${tailText}${hint}`;
}

/** The `│` that runs down the left of an open group, under its `▾`. */
export function groupGutter(theme: ThemeLike): string {
  return ` ${theme.fg("borderMuted", "│")}`;
}

/** Cells `groupGutter` takes. */
export const GUTTER_CELLS = 2;

/** A call that started a background job: the row tracks the job, not the call. */
function formatJobLine(tool: ToolLike, job: JobState, theme: ThemeLike, icons: boolean, spinner = "◐"): string {
  const status =
    job.status === "running"
      ? theme.fg("accent", spinner)
      : job.status === "done"
        ? theme.fg("success", "✓")
        : job.status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("muted", "⊘");
  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  const name = theme.fg("toolTitle", `${icon}${tool.toolName}`);
  const color = job.status === "failed" ? "error" : job.status === "running" ? "warning" : "muted";
  return ` ${status} ${name}${theme.fg("toolOutput", ` ${job.name}`)}  ${theme.fg(color, describeJob(job))}`;
}

export { formatDuration };
