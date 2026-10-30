/**
 * `codemode` body decoration: pi draws a script's nested calls as plain rows,
 * and tidy puts the kind icon in front of each and drops bash's trailer from a
 * nested failure. Rows are built here the way pi builds them (real escapes, no
 * tags) so the visible-text mapping is exercised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decorateCodemodeBody } from "../codemode-body.ts";

const theme = {
  fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => text,
} as any;

const plain = (line: string) => line.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "");

const details = {
  calls: [
    { id: "c/1", name: "bash", args: '{"command":"pwd"}', status: "ok" },
    { id: "c/2", name: "read", args: '{"path":"a.ts"}', status: "ok" },
  ],
};

test("nested call rows take the kind icon, the script and its output do not", () => {
  const lines = [
    "\x1b[90mconst commands = ['pwd'];\x1b[39m",
    "",
    "\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m \x1b[90m{\"command\":\"pwd\"}\x1b[39m \x1b[90m50ms\x1b[39m",
    "\x1b[32m✓\x1b[39m \x1b[36mread\x1b[39m \x1b[90m{\"path\":\"a.ts\"}\x1b[39m \x1b[90m1ms\x1b[39m",
    "",
    "\x1b[36m==> text 1/1 <==\x1b[39m",
    "\x1b[36mpwd output\x1b[39m",
  ];
  const out = decorateCodemodeBody(lines, details, { icons: true });
  assert.equal(out.length, lines.length);
  assert.equal(out[2], "\x1b[32m✓\x1b[39m \x1b[36m\u{f018d} bash\x1b[39m \x1b[90mpwd\x1b[39m \x1b[90m50ms\x1b[39m");
  assert.equal(out[3], "\x1b[32m✓\x1b[39m \x1b[36m\u{f06e} read\x1b[39m \x1b[90ma.ts\x1b[39m \x1b[90m1ms\x1b[39m");
  assert.equal(out[0], lines[0], "script row untouched");
  assert.equal(out[6], lines[6], "output row untouched");
});

test("a name that is not one of the script's calls is left alone", () => {
  const lines = ["\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m looks like a row but is output"];
  const out = decorateCodemodeBody(lines, { calls: [{ name: "read" }] }, { icons: true });
  assert.equal(out[0], lines[0]);
});

test("bash's trailer comes off a nested failure, with the blank row above it", () => {
  const lines = [
    "\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m \x1b[90m{\"command\":\"pwd\"}\x1b[39m",
    "\x1b[31m✗\x1b[39m \x1b[36mbash\x1b[39m \x1b[90m{\"command\":\"ls /nope\"}\x1b[39m",
    "    \x1b[31m\"/nope\": No such file or directory\x1b[39m",
    "    ",
    "    \x1b[31mCommand exited with code 2\x1b[39m",
    "\x1b[32m✓\x1b[39m \x1b[36mread\x1b[39m \x1b[90m{\"path\":\"a.ts\"}\x1b[39m",
  ];
  const out = decorateCodemodeBody(lines, details, { icons: false });
  assert.equal(out.length, 4, out.join("\n"));
  assert.ok(out[2]!.includes("No such file"), "the error itself stays");
  assert.ok(out.some((line) => line.includes("read")), "the next call stays");
});

test("a top-level bash trailer (not indented) is not tidy's to remove", () => {
  const lines = ["Command exited with code 1"];
  assert.deepEqual(decorateCodemodeBody(lines, details, { icons: true }), lines);
});

test("no details means pi's rows, byte for byte", () => {
  const lines = ["\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m {\"command\":\"pwd\"}"];
  assert.deepEqual(decorateCodemodeBody(lines, undefined, { icons: true }), lines);
  assert.deepEqual(decorateCodemodeBody(lines, { calls: [] }, { icons: true }), lines);
});

test("icons off still summarizes the arguments — that is not an icon thing", () => {
  const lines = ["\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m {\"command\":\"pwd\"}"];
  assert.deepEqual(decorateCodemodeBody(lines, details, { icons: false }), [
    "\x1b[32m✓\x1b[39m \x1b[36mbash\x1b[39m pwd",
  ]);
});

test("arguments clipped by pi are read back through the keys that survived", () => {
  // 200 characters of JSON, cut mid-value and marked with `...`: `JSON.parse`
  // cannot work on it, the one key that survived still can.
  const value = `echo ${"x".repeat(190)}`;
  const big = `${JSON.stringify({ command: value }).slice(0, 197)}...`;
  const lines = [`\x1b[32m✓\x1b[39m bash ${big}`];
  const out = decorateCodemodeBody(lines, { calls: [{ name: "bash", args: big }] }, { icons: false });
  assert.ok(plain(out[0]!).startsWith("✓ bash echo x"), out[0]);
  assert.ok(!plain(out[0]!).includes("{\"command\""), "the JSON is gone");
  assert.ok(plain(out[0]!).endsWith("…"), "summarized and clipped the way every other row is");
});

test("two calls of the same tool keep their own arguments", () => {
  const lines = [
    "\x1b[32m✓\x1b[39m bash {\"command\":\"pwd\"}",
    "\x1b[32m✓\x1b[39m bash {\"command\":\"ls\"}",
  ];
  const two = { calls: [{ name: "bash", args: '{"command":"pwd"}' }, { name: "bash", args: '{"command":"ls"}' }] };
  const out = decorateCodemodeBody(lines, two, { icons: false });
  assert.deepEqual(out, ["\x1b[32m✓\x1b[39m bash pwd", "\x1b[32m✓\x1b[39m bash ls"]);
});

test("arguments that parse to nothing readable keep pi's JSON", () => {
  const lines = ["\x1b[32m✓\x1b[39m bash {\"weird\":true}"];
  const out = decorateCodemodeBody(lines, { calls: [{ name: "bash", args: '{"weird":true}' }] }, { icons: false });
  assert.deepEqual(out, lines);
});

test("a call whose arguments are not in the row is left as pi drew it", () => {
  // Collapsed, pi clips the JSON to 80 characters, so the full text is absent.
  const lines = ["\x1b[32m✓\x1b[39m bash {\"command\":\"pw…"];
  const out = decorateCodemodeBody(lines, { calls: [{ name: "bash", args: '{"command":"pwd"}' }] }, { icons: false });
  assert.deepEqual(out, lines);
});
