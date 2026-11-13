/**
 * A payload is painted as the language it is written in.
 *
 * `bash -c '…'` was the first case (the script it is, through this tokenizer).
 * An interpreter's flag takes a program the same way, and `python3 -c "…"` is
 * the shape an agent reaches for far more often, so the tokenizer hands that
 * payload to highlight.js. These tests run with a theme installed: without one
 * `highlightCode` throws, and the payload correctly falls back to plain text
 * (that path is covered in bash-highlight.test.ts, which has no theme).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { highlightBashCommand } from "../src/tools/bash-highlight.ts";
import { getTheme } from "../src/theme-access.ts";

initTheme("dark");
// Pin the colour mode. A terminal with truecolor paints `38;2;…` and a CI runner
// without one paints `38;5;…`, so an assertion about the escapes themselves reads
// differently on the two machines — the painting below is the same either way.
setCapabilityOverrides({ trueColor: true });
const theme = getTheme()!;

const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "");
/** Highlight one command the way the call row does. */
const paint = (command: string) => highlightBashCommand(command, (token, text) => theme.fg(token, text));
/** The tokens the tokenizer emitted, as pairs. */
const tokens = (command: string) => {
  const seen: Array<[string, string]> = [];
  highlightBashCommand(command, (token, text) => {
    seen.push([token, text]);
    return text;
  });
  return seen;
};
/** What the payload looks like when it is painted as `language`. */
const asLanguage = (payload: string, language: string) => highlightCode(payload, language).join("\n");

test("a python3 -c payload is painted as python", () => {
  const payload = "import pathlib\np = pathlib.Path('x')\nprint(p)";
  const command = `python3 -c "${payload}"`;
  const out = paint(command);
  const painted = asLanguage(payload, "python");
  assert.notEqual(painted, payload, "the theme painted nothing to compare against");
  assert.ok(out.includes(painted), "the payload is not python-highlighted");
  assert.equal(plain(out), command, "no characters lost");
});

test("the flag's position and form do not matter", () => {
  const payload = "const x = 1";
  const js = asLanguage(payload, "javascript");
  const ts = asLanguage(payload, "typescript");
  assert.ok(paint(`node -e '${payload}'`).includes(js), "single quotes");
  assert.ok(paint(`node --eval "${payload}"`).includes(js), "the long flag, in double quotes");
  assert.ok(paint(`bun -e '${payload}'`).includes(ts), "bun runs TypeScript");
  // A flag before the program-carrying one, and a versioned interpreter name.
  assert.ok(paint(`python3 -u -c "print(1)"`).includes(asLanguage("print(1)", "python")));
  assert.ok(paint(`python3.12 -c "print(1)"`).includes(asLanguage("print(1)", "python")));
  assert.ok(paint(`sudo pypy3 -c "print(1)"`).includes(asLanguage("print(1)", "python")));
});

test("a payload in a sandbox script is still a payload", () => {
  const out = paint(`bash -c 'python3 -c "print(1)"'`);
  assert.ok(out.includes(asLanguage("print(1)", "python")), "the nested payload is not python-highlighted");
});

test("-c and -e on tools that take no program stay strings", () => {
  for (const [command, quoted] of [
    ["grep -c 'foo'", "'foo'"],
    ["sort -c file", ""],
    ["sed -n '1p' file", "'1p'"],
  ] as const) {
    const strings = tokens(command).filter(([token]) => token === "syntaxString").map(([, text]) => text);
    assert.deepEqual(strings, quoted ? [quoted] : [], command);
  }
});

test("a heredoc's body is painted as its owner's language", () => {
  const out = paint("python3 - <<'PY'\nprint(1)\nPY");
  assert.ok(out.includes(asLanguage("print(1)\n", "python")), "the body is not python-highlighted");
  assert.equal(plain(out), "python3 - <<'PY'\nprint(1)\nPY");
});

test("a heredoc nobody owns keeps its text uncoloured", () => {
  // Prose and data in `cat <<'EOF'` must not be read as shell: `cd` is not a command here.
  const out = paint("cat <<'EOF'\ncd src\nEOF");
  assert.ok(out.includes("\ncd src\n"), "the body was painted");
});

test("a streaming command's unterminated heredoc is not a heredoc yet", () => {
  const command = "python3 - <<'PY'\nprint(1)";
  assert.equal(plain(paint(command)), command);
});
