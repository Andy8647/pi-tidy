/**
 * Settings: the `tidy` key, and the pre-rename `toolbox` key still honoured.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.ts";

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

test("user messages default to the frame; an unknown style falls back to it", () => {
  withSettings({ tidy: {} }, () => {
    const config = loadConfig();
    assert.equal(config.userMessageStyle, "frame");
    assert.equal(config.userMessagePaddingY, 1);
    assert.deepEqual(config.userMessageColors, { rail: "accent", rule: "borderMuted" });
  });
  withSettings({ tidy: { userMessageStyle: "rail" } }, () => assert.equal(loadConfig().userMessageStyle, "rail"));
  withSettings({ tidy: { userMessageStyle: "off" } }, () => assert.equal(loadConfig().userMessageStyle, "off"));
  // pre-0.5: `false` left user messages to pi-starline, which no longer draws them.
  withSettings({ tidy: { frameUserMessages: false } }, () => assert.equal(loadConfig().userMessageStyle, "frame"));
  withSettings({ tidy: { userMessageStyle: "boxed" } }, () => assert.equal(loadConfig().userMessageStyle, "frame"));
});

test("user message padding is clamped and colors merge over the defaults", () => {
  withSettings({ tidy: { userMessagePaddingY: 0, userMessageColors: { rail: "#cba6f7", rule: 3 } } }, () => {
    const config = loadConfig();
    assert.equal(config.userMessagePaddingY, 0);
    assert.deepEqual(config.userMessageColors, { rail: "#cba6f7", rule: "borderMuted" });
  });
  withSettings({ tidy: { userMessagePaddingY: 9 } }, () => assert.equal(loadConfig().userMessagePaddingY, 3));
  withSettings({ tidy: { userMessagePaddingY: -1 } }, () => assert.equal(loadConfig().userMessagePaddingY, 1));
  withSettings({ tidy: { userMessagePaddingY: 1.5 } }, () => assert.equal(loadConfig().userMessagePaddingY, 1));
});
