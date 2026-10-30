/**
 * `codemode` body decoration: pi draws a script's nested calls as plain rows,
 * and tidy puts the kind icon in front of each and drops bash's trailer from a
 * nested failure. Rows are built here the way pi builds them (real escapes, no
 * tags) so the visible-text mapping is exercised.
 */

import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";
import {
  codemodeSections,
  composeCodemodeBody,
  decorateCodemodeBody,
  toggleCodemodeSection,
} from "../codemode-body.ts";

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
  assert.equal(out[2], "\x1b[32m✓\x1b[39m \x1b[36m\u{f018d} bash\x1b[39m \x1b[90mpwd\x1b[39m\x1b[90m   50ms\x1b[39m");
  assert.equal(out[3], "\x1b[32m✓\x1b[39m \x1b[36m\u{f06e} read\x1b[39m \x1b[90ma.ts\x1b[39m\x1b[90m  1ms\x1b[39m");
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

// ─── the fold ───────────────────────────────────────────────────────────────

const call = (name: string, args: string) => ({ name, args, status: "ok" });

/** What pi renders for a script that ran two calls and printed two items. */
const piBody = [
  " codemode",
  " const a = await tools.bash({ command: 'pwd' });",
  " const b = await tools.read({ path: 'src/app.ts' });",
  "",
  " \x1b[32m✓\x1b[39m bash \x1b[90m{\"command\":\"pwd\"}\x1b[39m 50ms",
  " \x1b[32m✓\x1b[39m read \x1b[90m{\"path\":\"src/app.ts\"}\x1b[39m 1ms",
  "",
  " \x1b[36m==> text 1/2 <==\x1b[39m",
  " \x1b[36m#0 ok exit=0 \"/tmp\"\x1b[39m",
  " \x1b[36m==> text 2/2 <==\x1b[39m",
  " \x1b[36m#1 ok exit=0 \"app\"\x1b[39m",
  "",
  " Took 0.1s",
];
const twoCalls = { calls: [call("bash", '{"command":"pwd"}'), call("read", '{"path":"src/app.ts"}')] };

const text = (out: { lines: string[] }) => out.lines.map(plain).map((line) => line.trim());

test("a closed body is a call list: script and output one row each", () => {
  const out = composeCodemodeBody(piBody, twoCalls, { script: false, output: false }, theme, { icons: false });
  assert.deepEqual(text(out), [
    "▸ script · 2 lines",
    "✓ bash pwd         50ms",
    "✓ read src/app.ts  1ms",
    "▸ output · 2 items",
  ]);
  assert.deepEqual(out.toggles.map((t) => [t.section, t.row]), [
    ["script", 0],
    ["output", 3],
  ]);
});

test("an open script keeps its rows under the label, above the calls", () => {
  const out = composeCodemodeBody(piBody, twoCalls, { script: true, output: false }, theme, { icons: false });
  assert.deepEqual(text(out).slice(0, 4), [
    "▾ script · 2 lines",
    "const a = await tools.bash({ command: 'pwd' });",
    "const b = await tools.read({ path: 'src/app.ts' });",
    "✓ bash pwd         50ms",
  ]);
});

test("an open output drops pi's markers and separates the items", () => {
  const out = composeCodemodeBody(piBody, twoCalls, { script: false, output: true }, theme, { icons: false });
  const rows = text(out);
  assert.ok(rows.includes("▾ output · 2 items"), rows.join("\n"));
  assert.ok(!rows.some((row) => row.includes("==> text")), "the count on the label is the marker now");
  assert.deepEqual(rows.slice(rows.indexOf("▾ output · 2 items") + 1), ['#0 ok exit=0 "/tmp"', "", '#1 ok exit=0 "app"']);
});

test("the fold state is per box and survives a re-render", () => {
  const box = {};
  assert.equal(codemodeSections(box).script, false);
  assert.equal(toggleCodemodeSection(box, "script"), true);
  assert.equal(codemodeSections(box).script, true);
  assert.equal(codemodeSections({}).script, false, "another box starts closed");
});

test("a script that called nothing still folds: the output marker is its anchor", () => {
  // What pi draws for `text('hi')` with no nested calls: title, script, output.
  const noCalls = [
    " codemode",
    " const x = 1;",
    " text('hi');",
    "",
    " \x1b[36m==> text 1/1 <==\x1b[39m",
    " \x1b[36mhi\x1b[39m",
    "",
    " Took 0.1s",
  ];
  const out = composeCodemodeBody(noCalls, { calls: [] }, { script: false, output: false }, theme, { icons: true });
  assert.deepEqual(
    out.toggles.map((toggle) => toggle.section),
    ["script", "output"],
  );
  assert.deepEqual(text(out), ["▸ script · 2 lines", "▸ output · 1 item"]);

  // No marker to anchor on: pi's own body stays.
  const bare = [" codemode", " const x = 1;", "", " just text"];
  assert.deepEqual(composeCodemodeBody(bare, { calls: [] }, { script: false, output: false }, theme, { icons: true }).toggles, []);
});

test("one rule separates the script from the output when no calls sit between them", () => {
  const noCalls = [" codemode", " const x = 1;", "", " \x1b[36m==> text 1/1 <==\x1b[39m", " \x1b[36mhi\x1b[39m"];
  const out = composeCodemodeBody(noCalls, { calls: [] }, { script: false, output: false }, theme, { icons: true, width: 40 });
  const rules = text(out).filter((row) => row.startsWith("─"));
  assert.equal(rules.length, 1, text(out).join("\n"));
});

test("the body's own rows take a name column and a duration column", () => {
  const calls = [
    { name: "bash", args: '{"command":"pwd"}' },
    { name: "ds_search", args: '{"query":"typst"}' },
    { name: "read", args: '{"path":"a.ts"}' },
  ];
  const body = [
    " codemode",
    " const x = 1;",
    "",
    " \x1b[32m✓\x1b[39m bash \x1b[90m{\"command\":\"pwd\"}\x1b[39m 522ms",
    " \x1b[32m✓\x1b[39m ds_search \x1b[90m{\"query\":\"typst\"}\x1b[39m 5ms",
    " \x1b[32m✓\x1b[39m read \x1b[90m{\"path\":\"a.ts\"}\x1b[39m 1.8s",
  ];
  const out = composeCodemodeBody(body, { calls }, { script: false, output: false }, theme, { icons: false, width: 40 });
  const rows = out.lines.filter((line) => line.includes("✓")).map(plain);
  assert.equal(rows.length, 3, out.lines.map(plain).join("\n"));
  const column = (row: string, needle: string) => visibleWidth(row.slice(0, row.indexOf(needle)));
  const argsAt = rows.map((row) => column(row, row.includes("pwd") ? "pwd" : row.includes("typst") ? "typst" : "a.ts"));
  assert.equal(new Set(argsAt).size, 1, rows.join("\n"));
  // The durations share a column too, two cells past the longest arguments
  // rather than out at the box's edge.
  const durationsAt = rows.map((row) => column(row, row.trimEnd().split(" ").pop()!));
  assert.equal(new Set(durationsAt).size, 1, rows.join("\n"));
  assert.ok(durationsAt[0]! < 40 - 3, "with the arguments, not out at the box's edge");
  assert.deepEqual(
    rows.map((row) => row.trimEnd().split(" ").pop()),
    ["522ms", "5ms", "1.8s"],
  );
});

test("the sections are separated by a rule when the body has a width", () => {
  const out = composeCodemodeBody(piBody, twoCalls, { script: false, output: false }, theme, { icons: false, width: 40 });
  const rows = text(out);
  const rules = rows.map((row, i) => (row.startsWith("─") ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(rules, [1, rows.length - 2], rows.join("\n"));
  assert.equal(rows[1], "─".repeat(39), "one row of the body width, minus its leading pad");
  // No width (a plain unit call, or a box too narrow to divide) means no rules.
  assert.ok(!text(composeCodemodeBody(piBody, twoCalls, { script: false, output: false }, theme, { icons: false })).some((row) => row.startsWith("─")));
});
