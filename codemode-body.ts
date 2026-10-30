/**
 * The decorations a `codemode` box's body gets from tidy.
 *
 * A script's nested calls are not tool components: pi renders them as plain
 * rows inside the parent's result — status glyph, tool name, the arguments as
 * compact JSON, the duration. tidy does not take the renderer over, so it
 * works on the rendered rows and on `result.details.calls`, which is the same
 * list in the same order:
 *
 * - each nested tool's name takes the kind icon the outer tool rows carry;
 * - the arguments JSON becomes the same one-line summary the outer rows use
 *   (`pwd`, `src/app.ts`) — `args` on the result is `JSON.stringify(args)`
 *   clipped to 200 characters, so a clipped one is read back through the keys
 *   it still shows;
 * - bash's own `Command exited with code N` trailer is dropped from a nested
 *   failure, where the error text above it already says what happened.
 *
 * Everything else — the script, its output, pi's layout — is left alone. A
 * diff for a nested `edit`, or a sub-call that opens on click, needs data the
 * result does not carry: `args` is a clipped string, there is no per-call
 * output, and no component to hang a hit area on.
 */

import { rawIndexOfVisible, visibleText } from "./frame-draw.ts";
import { toolKindIcon } from "./icons.ts";
import { summarizeArgs } from "./tool-lines.ts";

/** pi's nested-call status glyphs, before the tool's name. */
const STATUS_GLYPHS = new Set(["✓", "✗", "⊘", "…"]);

/**
 * bash's trailer inside a nested error, indented by the error block's own
 * four spaces. The top-level bash box keeps pi's version: there it is the only
 * report of the exit code.
 */
const NESTED_BASH_TRAILER = /^ {4}Command (?:exited with code \d+|terminated)\b/;

/**
 * The first path-ish argument visible in a clipped JSON string. `args` is cut
 * to 200 characters, so `JSON.parse` fails on the long ones while the keys that
 * matter are usually still readable.
 */
const PARTIAL_ARG =
  /"(command|file_path|filePath|path|pattern|url|query)":\s*"((?:[^"\\]|\\.)*)"?/;

/** Escape sequences only, so a replaced span's style closers can be kept. */
const ESCAPES_ONLY = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

interface NestedCall {
  name: string;
  /** `JSON.stringify(args)`, clipped by pi. Empty when the call took none. */
  args: string;
}

function nestedCalls(details: unknown): NestedCall[] {
  const calls = (details as { calls?: unknown } | undefined)?.calls;
  if (!Array.isArray(calls)) return [];
  const out: NestedCall[] = [];
  for (const call of calls as Array<{ name?: unknown; args?: unknown }>) {
    if (typeof call?.name !== "string" || !call.name) continue;
    out.push({ name: call.name, args: typeof call.args === "string" ? call.args : "" });
  }
  return out;
}

/**
 * `{"command":"pwd","timeout":10}` → `pwd`. Parsed when the whole string made
 * it through; otherwise read the one key that survived. Empty when neither
 * works, and the row keeps pi's JSON.
 */
function summarizeNestedArgs(name: string, argsText: string): string {
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    const match = PARTIAL_ARG.exec(argsText);
    if (!match) return "";
    // The value can be cut mid-escape, and pi marks the cut with `...`; both
    // leave the fragment unparseable on its own.
    const value = match[2]!.replace(/(?:\\+|\.\.\.)$/, "").replace(/\\+$/, "");
    try {
      args = { [match[1]!]: JSON.parse(`"${value}"`) };
    } catch {
      return "";
    }
  }
  if (!args || typeof args !== "object") return "";
  return summarizeArgs(name, args);
}

/**
 * Replace the row's visible arguments with the summary. The escapes inside the
 * replaced span (the arguments' own colour closers) are carried over, so the
 * rest of the row keeps whatever styling pi gave it.
 */
function replaceArgs(line: string, argsText: string, summary: string): string {
  const plain = visibleText(line);
  const at = plain.indexOf(argsText);
  if (at < 0) return line;
  const from = rawIndexOfVisible(line, at);
  const to = rawIndexOfVisible(line, at + argsText.length);
  if (from < 0) return line;
  const end = to < 0 ? line.length : to;
  const escapes = line.slice(from, end).match(ESCAPES_ONLY)?.join("") ?? "";
  return line.slice(0, from) + summary + escapes + line.slice(end);
}

/** `✓ bash …` → `✓ 󰆍 bash …`, inserted inside the name's own colour span. */
function addKindIcon(line: string, name: string): string {
  const at = rawIndexOfVisible(line, 2);
  if (at < 0) return line;
  return line.slice(0, at) + `${toolKindIcon(name)} ` + line.slice(at);
}

/**
 * Decorate the rendered rows. A row is a nested call only if it opens with a
 * status glyph and names one of the script's tools, and it is matched to the
 * first unconsumed call of that name — so two `bash` calls keep their own
 * arguments — which leaves the script, its output and a multi-line error's
 * continuation rows untouched.
 */
function decorateRows(lines: readonly string[], calls: NestedCall[], icons: boolean): string[] {
  let next = 0;
  return lines.map((line) => {
    const plain = visibleText(line);
    if (!STATUS_GLYPHS.has(plain[0] ?? "") || plain[1] !== " ") return line;
    const name = plain.slice(2).split(" ")[0] ?? "";
    let index = next;
    while (index < calls.length && calls[index]!.name !== name) index++;
    if (index >= calls.length) return line;
    next = index + 1;

    const call = calls[index]!;
    let row = line;
    if (call.args) {
      const summary = summarizeNestedArgs(name, call.args);
      if (summary) row = replaceArgs(row, call.args, summary);
    }
    return icons ? addKindIcon(row, name) : row;
  });
}

/**
 * Drop the trailer bash appends to a failed nested call, along with the blank
 * continuation row its error text carries in front of it. The trailer is only
 * taken when an indented error row precedes it — that is what a nested
 * failure's block looks like; the script's own source is never indented that
 * way right before one.
 */
function dropBashTrailers(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (NESTED_BASH_TRAILER.test(visibleText(line))) {
      let back = out.length - 1;
      while (back >= 0 && visibleText(out[back]!).trim() === "") back--;
      if (back >= 0 && /^ {4}\S/.test(visibleText(out[back]!))) {
        while (out.length > 0 && visibleText(out[out.length - 1]!).trim() === "") out.pop();
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

export interface CodemodeBodyOptions {
  /** Put the kind icon in front of every nested tool's name. */
  icons: boolean;
}

/**
 * Decorate a rendered `codemode` body. Without nested-call details (older pi,
 * or a script that called nothing) the rows are pi's, unchanged.
 */
export function decorateCodemodeBody(
  lines: string[],
  details: unknown,
  options: CodemodeBodyOptions,
): string[] {
  const calls = nestedCalls(details);
  const decorated = calls.length > 0 ? decorateRows(lines, calls, options.icons) : lines;
  return dropBashTrailers(decorated);
}
