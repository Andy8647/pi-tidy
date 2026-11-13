/**
 * Bash command syntax highlighting (custom tokenizer — highlight.js's bash
 * grammar is too weak: no command names, flags, paths, or pipe operators)
 *
 * A flag or a heredoc can carry a whole program in another language
 * (`python3 -c "…"`, `python3 - <<'PY'`). Those payloads are handed to
 * highlight.js through pi's `highlightCode`, so a script reads as the language
 * it is written in rather than as one flat string.
 */

import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../theme-access.ts";

interface BashCallArgs {
  command?: string;
  timeout?: number;
}

// Shell grammar keywords (flow control) → syntaxKeyword
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "coproc", "{", "}", "!",
]);

// NOTE: '#' is deliberately NOT a word break. A '#' only starts a comment at
// word start (handled above), so a mid-word '#' (fill:#242f60, a#b, url#frag)
// must stay inside the word. Treating it as a break used to leave the scanner
// unable to advance — see the progress guard in highlightBashCommand.
const WORD_BREAK = /[\s'"`$|&;<>()]/;

/**
 * Shells whose `-c` takes a script. `-c` on anything else (`grep -c`, `sort -c`)
 * takes none, so the string after it has to stay a string.
 */
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish"]);

/** `-c`, and the combined forms a login or traced shell uses: `-lc`, `-xc`. */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** `bash -c 'bash -c …'` is worth a level or two, not an endless descent. */
const MAX_PAYLOAD_DEPTH = 3;

/** This tokenizer's own language, as a payload language and as a heredoc's. */
const SHELL_LANGUAGE = "shell";

/**
 * A word that runs a program, and the flag that hands it one.
 */
interface Runner {
  /** The language of that program: SHELL_LANGUAGE, or a highlight.js grammar. */
  language: string;
  /** Whether `word` is the flag whose next token is the program. */
  takesProgram(word: string): boolean;
}

/**
 * Interpreters whose flag takes a program rather than an argument.
 *
 * `-c` on `grep` or `sort` counts and checks, so a flag is not enough on its
 * own: the word before it has to name one of these. The languages are the ones
 * pi's highlight.js build registers eagerly (`utils/syntax-highlight.js`); a
 * payload in a grammar that is not loaded yet comes back unpainted, which is
 * where it started.
 */
const INTERPRETERS: ReadonlyArray<{ names: readonly string[]; language: string; flags: readonly string[] }> = [
  { names: ["python", "python2", "python3", "pypy", "pypy3"], language: "python", flags: ["-c"] },
  { names: ["node", "nodejs"], language: "javascript", flags: ["-e", "--eval", "-p", "--print"] },
  { names: ["bun", "deno", "tsx"], language: "typescript", flags: ["-e", "--eval"] },
  { names: ["ruby"], language: "ruby", flags: ["-e"] },
  { names: ["perl"], language: "perl", flags: ["-e", "-E"] },
  { names: ["php"], language: "php", flags: ["-r"] },
  { names: ["lua", "luajit"], language: "lua", flags: ["-e"] },
];

/** `python3.12`, `pypy3.10`: the name is a version of the one in the table. */
const VERSIONED_INTERPRETER = /^(?:python|pypy)\d+(?:\.\d+)?$/;

const RUNNERS = new Map<string, Runner>();
for (const entry of INTERPRETERS) {
  for (const name of entry.names) {
    RUNNERS.set(name, { language: entry.language, takesProgram: (word) => entry.flags.includes(word) });
  }
}

const SHELL_RUNNER: Runner = { language: SHELL_LANGUAGE, takesProgram: (word) => SHELL_COMMAND_FLAG.test(word) };

/** The runner a word names, if any. `/bin/bash` and `python3.12` count. */
function runnerFor(word: string): Runner | undefined {
  const base = word.slice(word.lastIndexOf("/") + 1);
  if (SHELL_NAMES.has(base)) return SHELL_RUNNER;
  return RUNNERS.get(base) ?? (VERSIONED_INTERPRETER.test(base) ? RUNNERS.get("python") : undefined);
}

/**
 * Another language's program, in this theme's colours.
 *
 * pi's `highlightCode` maps highlight.js's scopes onto the same `syntax*` tokens
 * this tokenizer uses, so a Python payload and the shell around it agree. It
 * throws when no theme is installed (the tokenizer's own tests run without one)
 * and paints nothing for a grammar that is not loaded yet; either way the text
 * comes back as it went in, because a payload is never worth losing.
 */
function highlightProgram(text: string, language: string): string {
  try {
    return highlightCode(text, language).join("\n");
  } catch {
    return text;
  }
}

/**
 * The body of a heredoc starting at `start`, and the line that ends it.
 *
 * `undefined` when no terminator follows: a command whose arguments are still
 * streaming has an unterminated heredoc on every frame but the last, and that
 * has to cost nothing. Lines are read whole, so a body line that looks like
 * shell is never tokenized as shell.
 */
function readHeredoc(
  command: string,
  start: number,
  delimiter: string,
  stripTabs: boolean,
): { text: string; terminator: string; end: number } | undefined {
  if (!delimiter) return undefined;
  let lineStart = start;
  for (;;) {
    const newline = command.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? command.length : newline;
    const line = command.slice(lineStart, lineEnd);
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
      return {
        text: command.slice(start, lineStart),
        terminator: line,
        end: newline === -1 ? command.length : newline + 1,
      };
    }
    if (newline === -1) return undefined;
    lineStart = newline + 1;
  }
}

/**
 * Tokenize and color a shell command string.
 * `color(token, text)` maps a syntax token name to styled text (theme.fg).
 * Anything unrecognized passes through uncolored.
 */
export function highlightBashCommand(
  command: string,
  color: (token: string, text: string) => string
): string {
  return highlightShell(command, color, 0);
}

/**
 * The work behind `highlightBashCommand`, which only seeds the descent depth.
 *
 * `bash -c 'set -e` + newline + `cd src'` is a shell script inside a string.
 * Coloring the payload as one string token is what the shell's grammar says, but
 * a six-line command in one flat colour is unreadable, so a payload the word
 * before the flag named is tokenized as the code it is: shell through this
 * tokenizer, anything else through highlight.js. A quoted word nothing
 * introduced stays the string it is.
 *
 * A heredoc's body is read whole for the same reason: `python3 - <<'PY'` is the
 * form a sandboxed agent reaches for, and a body tokenized as shell turns
 * `import` into a command.
 */
function highlightShell(
  command: string,
  color: (token: string, text: string) => string,
  depth: number
): string {
  const out: string[] = [];
  const push = (text: string, token: string | null) => {
    out.push(token && text ? color(token, text) : text);
  };
  /** A payload, in the language it is written in. Unknown keeps the text plain. */
  const pushProgram = (text: string, language: string | null) => {
    if (!text) return;
    if (language === SHELL_LANGUAGE) {
      if (depth < MAX_PAYLOAD_DEPTH) {
        // Pushed raw: the inner call colors its own tokens.
        out.push(highlightShell(text, color, depth + 1));
        return;
      }
      out.push(text);
      return;
    }
    out.push(language ? highlightProgram(text, language) : text);
  };

  let i = 0;
  const n = command.length;
  let expectCmd = true; // next word sits in command position
  let named: Runner | null = null; // the previous word runs a program
  let programNext: string | null = null; // the token coming up is that program
  let delimiterNext = false; // the token coming up is a heredoc's delimiter
  let stripTabs = false; // `<<-` eats the body's leading tabs
  let heredoc: { delimiter: string; language: string | null } | null = null; // read, waiting for its line

  while (i < n) {
    const c = command[i];

    // whitespace / newlines
    if (c === " " || c === "\t") { push(c, null); i++; continue; }
    if (c === "\n") {
      push(c, null);
      i++;
      // A heredoc's body starts on the line after its delimiter. Reading it here,
      // whole, keeps a body line that looks like shell from being tokenized as shell.
      if (heredoc) {
        const body = readHeredoc(command, i, heredoc.delimiter, stripTabs);
        if (body) {
          pushProgram(body.text, heredoc.language);
          push(body.terminator, "toolOutput");
          i = body.end;
        }
        heredoc = null;
        stripTabs = false;
      }
      expectCmd = true;
      named = null;
      programNext = null;
      delimiterNext = false;
      continue;
    }

    // comment (only at word start)
    if (c === "#" && (i === 0 || command[i - 1] === " " || command[i - 1] === "\t" || command[i - 1] === "\n")) {
      const nl = command.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      push(command.slice(i, end), "syntaxComment");
      i = end;
      continue;
    }

    // Only the token right after the flag or the `<<` is what it introduces: read
    // it here and clear it, so a later quote in the same command is a plain
    // string again. Whitespace and comments above must not consume it.
    const program = programNext;
    programNext = null;
    const delimiter = delimiterNext;
    delimiterNext = false;

    // operators (longest first)
    // fd redirects like 2>&1 (4 chars): target is not a command word
    const four = command.slice(i, i + 4);
    if (four === "2>&1" || four === "1>&2") {
      push(four, "syntaxOperator"); i += 4; continue;
    }
    const three = command.slice(i, i + 3);
    if (three === "&>>") {
      push(three, "syntaxOperator"); i += 3; continue;
    }
    // `<<<` is a here-string: the word after it is data, not a body's delimiter.
    if (three === "<<<") {
      push(three, "syntaxOperator"); i += 3; continue;
    }
    if (three === "<<-") {
      push(three, "syntaxOperator"); i += 3; delimiterNext = true; stripTabs = true; continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(two, "syntaxOperator"); i += 2; expectCmd = true; continue;
    }
    if (two === "<<") {
      push(two, "syntaxOperator"); i += 2; delimiterNext = true; continue;
    }
    // other redirects: the next word is a file target, not a command
    if (two === ">>" || two === "2>" || two === ">&" || two === "<&" || two === "&>") {
      push(two, "syntaxOperator"); i += 2; continue;
    }
    if (c === "|" || c === ";") {
      push(c, "syntaxOperator"); i++; expectCmd = true; continue;
    }
    if (c === ">" || c === "<") {
      push(c, "syntaxOperator"); i++; continue;
    }
    if (c === "&") { push(c, "syntaxOperator"); i++; expectCmd = true; continue; }
    if (c === "(") { push(c, "syntaxOperator"); i++; expectCmd = true; continue; }
    if (c === ")") { push(c, "syntaxOperator"); i++; expectCmd = false; continue; }

    // single-quoted string
    if (c === "'") {
      const q = command.indexOf("'", i + 1);
      const end = q === -1 ? n : q + 1;
      // A quoted word can be a heredoc's delimiter or a runner's program. The
      // quotes stay strings; what is between them is read as what it is.
      if (q !== -1 && delimiter) heredoc = { delimiter: command.slice(i + 1, q), language: named?.language ?? null };
      if (q !== -1 && program) {
        push("'", "syntaxString");
        pushProgram(command.slice(i + 1, q), program);
        push("'", "syntaxString");
        i = end;
        continue;
      }
      push(command.slice(i, end), "syntaxString");
      i = end;
      continue;
    }

    // double-quoted string (escape-aware)
    if (c === '"') {
      let j = i + 1;
      let closes = false;
      while (j < n) {
        if (command[j] === "\\") { j += 2; continue; }
        if (command[j] === '"') { closes = true; break; }
        j++;
      }
      const end = closes ? j + 1 : n;
      const inner = command.slice(i + 1, closes ? j : n);
      if (closes && delimiter) heredoc = { delimiter: inner, language: named?.language ?? null };
      if (closes && program) {
        push('"', "syntaxString");
        pushProgram(inner, program);
        push('"', "syntaxString");
        i = end;
        continue;
      }
      push(command.slice(i, end), "syntaxString");
      i = end;
      continue;
    }

    // backtick substitution
    if (c === "`") {
      const q = command.indexOf("`", i + 1);
      const end = q === -1 ? n : q + 1;
      push(command.slice(i, end), "syntaxString");
      i = end;
      continue;
    }

    // variable: $VAR ${VAR} $1 $@ $? $(...)
    if (c === "$") {
      const m = /^\$(\([^)]*\)|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*_-])/.exec(command.slice(i));
      if (m) {
        push(m[0], "syntaxVariable");
        i += m[0].length;
        continue;
      }
      push(c, null); i++; continue;
    }

    // word
    let j = i;
    while (j < n && !WORD_BREAK.test(command[j])) j++;
    // Progress guard: every branch above either advanced `i` or is reached only
    // when `command[i]` is not a word break. If some future/unhandled break
    // character lands here, `j === i` and a bare `continue` would spin forever
    // pushing empty strings (this froze the whole TUI on `echo a#b`). Emit the
    // character plainly and move on — the tokenizer must always terminate.
    if (j === i) {
      push(c, null);
      i++;
      continue;
    }
    const word = command.slice(i, j);
    i = j;

    // Track `… bash -c` and `… python3 -c`: the runner word arms the flag, the
    // flag arms the next program. `/bin/bash` counts, and a word that is neither
    // a runner nor a flag disarms both.
    //
    // A heredoc's delimiter is data, not a command word: `<<EOF` names the line
    // that ends the body, and the word before it says which program owns it.
    if (delimiter) {
      push(word, "toolOutput");
      heredoc = { delimiter: word, language: named?.language ?? null };
      continue;
    }
    const runner = runnerFor(word);
    if (runner) {
      named = runner;
    } else if (named?.takesProgram(word)) {
      programNext = named.language;
      named = null; // one program per runner word
    } else if (!word.startsWith("-")) {
      named = null;
    }

    // assignment prefix in command position: VAR=value
    if (expectCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      const eq = word.indexOf("=");
      push(word.slice(0, eq), "syntaxVariable");
      push("=", "syntaxOperator");
      push(word.slice(eq + 1), "toolOutput");
      continue; // still expecting the command word
    }

    if (expectCmd) {
      if (SHELL_KEYWORDS.has(word)) push(word, "syntaxKeyword");
      else push(word, "syntaxFunction"); // builtins + external commands
      expectCmd = false;
      continue;
    }

    // flags: -x -abc --long --key=value
    if (/^--?[A-Za-z0-9][\w.-]*(=.*)?$/.test(word) && word !== "-") {
      const eq = word.indexOf("=");
      if (eq !== -1) {
        push(word.slice(0, eq), "syntaxType");
        push("=", "syntaxOperator");
        push(word.slice(eq + 1), "toolOutput");
      } else {
        push(word, "syntaxType");
      }
      continue;
    }

    // numbers
    if (/^\d+(\.\d+)?$/.test(word)) { push(word, "syntaxNumber"); continue; }

    // Words the grammar cannot name: arguments, paths, globs, filenames. The
    // shell has no type for these — `cp foo bar` and `cp foo/bar` are the same
    // shape — so they are not guessed at, they are one quiet colour. Left
    // uncoloured they would be the terminal's default foreground, which turns a
    // path-heavy command into a wall of white. `toolOutput` rather than `muted`:
    // readable at a glance, and not the grey a comment takes.
    push(word, "toolOutput");
  }

  return out.join("");
}

/**
 * Format the bash call row: bold `$` prompt + syntax-highlighted command.
 * Falls back to the built-in flat style when there is no command yet.
 */
export interface BashCallFormatOptions {
  /**
   * `false` renders the collapsed view pi shows by default: only the first
   * line of the command plus a `+N more lines` hint. `true` (default) renders
   * the whole command, which is what `ctrl+o` switches to.
   */
  expanded?: boolean;
  /** Collapsed view: how many characters of the first line to keep. */
  maxChars?: number;
  /** Collapsed view: styled hint appended after the `+N more lines` count. */
  hint?: string;
}

/** Matches pi's own `COLLAPSED_ARGS_CHARS` so bash collapses like every other tool. */
export const COLLAPSED_COMMAND_CHARS = 100;

interface CollapsedCommand {
  head: string;
  hiddenLines: number;
  truncatedChars: boolean;
}

/**
 * Reduce a possibly multi-line command to the single line shown in the
 * collapsed view. Heredocs are the reason this exists: `python3 - <<'PY'` plus
 * 40 lines of body used to fill the whole box before the command even ran.
 */
export function collapseBashCommand(command: string, maxChars: number = COLLAPSED_COMMAND_CHARS): CollapsedCommand {
  const lines = command.split("\n");
  let head = (lines[0] ?? "").trimEnd();
  const hiddenLines = lines.length - 1;
  let truncatedChars = false;
  if (head.length > maxChars) {
    head = `${head.slice(0, Math.max(0, maxChars - 1))}…`;
    truncatedChars = true;
  }
  return { head, hiddenLines, truncatedChars };
}

export function formatBashCallHighlighted(
  args: BashCallArgs,
  theme: ThemeLike,
  options: BashCallFormatOptions | boolean = {},
): string {
  const opts = typeof options === "boolean" ? { expanded: options } : options;
  const expanded = opts.expanded ?? true;
  const command = typeof args?.command === "string" ? args.command : "";
  const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const prompt = theme.fg("toolTitle", theme.bold("$ "));

  if (!command) {
    return prompt + theme.fg("toolOutput", "...") + timeoutSuffix;
  }

  let body = command;
  let collapsedSuffix = "";
  if (!expanded) {
    const { head, hiddenLines, truncatedChars } = collapseBashCommand(command, opts.maxChars);
    if (hiddenLines > 0 || truncatedChars) {
      body = head;
      const parts: string[] = [];
      if (hiddenLines > 0) parts.push(`+${hiddenLines} more lines`);
      if (truncatedChars) parts.push("truncated");
      collapsedSuffix =
        theme.fg("muted", ` (${parts.join(", ")}, `) +
        (opts.hint ?? "expand") +
        theme.fg("muted", ")");
    }
  }

  let highlighted: string;
  try {
    highlighted = highlightBashCommand(body, (token, text) => theme.fg(token, text));
  } catch {
    highlighted = body; // never break the tool row on a tokenizer bug
  }
  return prompt + highlighted + collapsedSuffix + timeoutSuffix;
}
