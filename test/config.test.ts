/**
 * Settings: the `tidy` key, and the pre-rename `toolbox` key still honoured.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

function withSettings(settings: object, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-config-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("settings come from the `tidy` key", () => {
  withSettings({ tidy: { groupTools: false, bashResultLines: 3 } }, () => {
    const config = loadConfig();
    assert.equal(config.groupTools, false);
    assert.equal(config.bashResultLines, 3);
  });
});

test("the pre-rename `toolbox` key still works, and `tidy` wins over it", () => {
  withSettings({ toolbox: { icons: false } }, () => assert.equal(loadConfig().icons, false));
  withSettings({ toolbox: { icons: false }, tidy: { icons: true } }, () => assert.equal(loadConfig().icons, true));
});

test("settings use the native home directory when HOME is absent", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-tidy-home-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tidy: { bashResultLines: 23 } }));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const mockedHome = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  delete process.env.HOME;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(loadConfig().bashResultLines, 23);
  } finally {
    mockedHome.mock.restore();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("no settings file: defaults", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-tidy-does-not-exist");
  try {
    assert.equal(loadConfig().groupTools, true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("groupOpen defaults to false, passes true through, and ignores a non-boolean", () => {
  withSettings({ tidy: {} }, () => assert.equal(loadConfig().groupOpen, false));
  withSettings({ tidy: { groupOpen: true } }, () => assert.equal(loadConfig().groupOpen, true));
  withSettings({ tidy: { groupOpen: false } }, () => assert.equal(loadConfig().groupOpen, false));
  withSettings({ tidy: { groupOpen: "yes" } }, () => assert.equal(loadConfig().groupOpen, false));
  withSettings({ tidy: { groupOpen: 1 } }, () => assert.equal(loadConfig().groupOpen, false));
});

test("one style draws every surface; a surface's own key, where set, is the exception", () => {
  withSettings({ tidy: {} }, () => {
    const config = loadConfig();
    assert.deepEqual([config.style, config.userMessageStyle, config.finalReplyStyle], ["rail", "rail", "rail"]);
  });
  withSettings({ tidy: { style: "frame" } }, () => {
    const config = loadConfig();
    assert.deepEqual([config.style, config.userMessageStyle, config.finalReplyStyle], ["frame", "frame", "frame"]);
  });
  withSettings({ tidy: { style: "boxed" } }, () => assert.equal(loadConfig().style, "rail", "an unknown style is the default"));
  withSettings({ tidy: { style: "frame", userMessageStyle: "rail", finalReplyStyle: "off" } }, () => {
    const config = loadConfig();
    assert.deepEqual([config.userMessageStyle, config.finalReplyStyle], ["rail", "off"]);
  });
  // An unknown value on a surface says nothing, so the surface follows the style.
  withSettings({ tidy: { style: "frame", userMessageStyle: "boxed" } }, () => assert.equal(loadConfig().userMessageStyle, "frame"));
  // pre-0.5: `false` left user messages to pi-starline, which no longer draws them.
  withSettings({ tidy: { frameUserMessages: false } }, () => assert.equal(loadConfig().userMessageStyle, "rail"));
});

test("`rules`, the rail's name before 0.11, reads as a rail on either surface", () => {
  withSettings({ tidy: { userMessageStyle: "rules", finalReplyStyle: "rules" } }, () => {
    const config = loadConfig();
    assert.deepEqual([config.userMessageStyle, config.finalReplyStyle], ["rail", "rail"]);
  });
});

test("user alignment defaults left and accepts only right as an override", () => {
  for (const value of [undefined, "left", "right", "center", 1]) {
    withSettings({ tidy: { userMessageAlign: value } }, () => {
      assert.equal(loadConfig().userMessageAlign, value === "right" ? "right" : "left");
    });
  }
});

test("turn folding and final reply frames are on by default and turn off independently", () => {
  for (const mode of ["off", "afterRun", "live", true, "unknown", undefined]) {
    withSettings({ tidy: { collapseTurns: mode, frameFinalReply: false } }, () => {
      const config = loadConfig();
      assert.equal(config.collapseTurns, mode === "off" || mode === "live" ? mode : "afterRun");
      assert.equal(config.finalReplyStyle, "off");
    });
  }
  withSettings({ tidy: {} }, () => {
    assert.equal(loadConfig().collapseTurns, "afterRun");
    assert.equal(loadConfig().finalReplyStyle, "rail");
  });
});

test("finalReplyStyle wins over the old frameFinalReply, which still works alone", () => {
  for (const [settings, expected] of [
    [{ finalReplyStyle: "rail" }, "rail"],
    [{ finalReplyStyle: "rail", frameFinalReply: true }, "rail"],
    [{ finalReplyStyle: "off", frameFinalReply: true }, "off"],
    [{ finalReplyStyle: "boxed" }, "rail"],
    [{ frameFinalReply: true }, "frame"],
    [{ frameFinalReply: true, style: "rail" }, "frame"],
    [{ frameFinalReply: false }, "off"],
  ] as const) {
    withSettings({ tidy: settings }, () => assert.equal(loadConfig().finalReplyStyle, expected, JSON.stringify(settings)));
  }
});

test("clean copy is on by default and only a boolean turns it off", () => {
  for (const [value, expected] of [[undefined, true], [false, false], [true, true], ["no", true]] as const) {
    withSettings({ tidy: { cleanCopy: value } }, () => assert.equal(loadConfig().cleanCopy, expected));
  }
});

test("a user message's time shows by default and only a boolean hides it", () => {
  for (const [value, expected] of [[undefined, true], [false, false], [true, true], ["no", true]] as const) {
    withSettings({ tidy: { userMessageTime: value } }, () => assert.equal(loadConfig().userMessageTime, expected));
  }
});

test("user message max width takes a fraction or a column count, and falls back to auto", () => {
  withSettings({ tidy: { userMessageMaxWidth: 0.7 } }, () => assert.equal(loadConfig().userMessageMaxWidth, 0.7));
  withSettings({ tidy: { userMessageMaxWidth: 88 } }, () => assert.equal(loadConfig().userMessageMaxWidth, 88));
  for (const value of [undefined, "auto", "88", 0, -5, null, true] as const) {
    withSettings({ tidy: { userMessageMaxWidth: value } }, () =>
      assert.equal(loadConfig().userMessageMaxWidth, "auto", JSON.stringify(value)),
    );
  }
});

test("a user message hugs its text unless userMessageFill is true", () => {
  for (const [value, expected] of [[undefined, false], [true, true], [false, false], ["yes", false]] as const) {
    withSettings({ tidy: { userMessageFill: value } }, () => assert.equal(loadConfig().userMessageFill, expected));
  }
});

test("diffContext takes whole lines from 0 to pi's 4, and anything else keeps pi's 4", () => {
  for (const [value, expected] of [[undefined, 4], [0, 0], [2, 2], [4, 4], [9, 4], [-1, 4], [1.5, 4], ["2", 4]] as const) {
    withSettings({ tidy: { diffContext: value } }, () => assert.equal(loadConfig().diffContext, expected, JSON.stringify(value)));
  }
});

test("the README documents every key, under its real default", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  const section = readme.slice(readme.indexOf("## Configuration\n"), readme.indexOf("## How it works\n"));
  const rows = new Map(
    [...section.matchAll(/^\| `(\w+)` \| `(.+?)` \|/gm)].map((match) => [match[1], JSON.parse(match[2]!)] as const),
  );
  withSettings({ tidy: {} }, () => {
    const defaults = loadConfig() as unknown as Record<string, unknown>;
    assert.deepEqual([...rows.keys()].sort(), Object.keys(defaults).sort());
    for (const [key, value] of rows) assert.deepEqual(value, defaults[key], key);
  });
});
