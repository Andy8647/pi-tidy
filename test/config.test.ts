/**
 * Settings: the `tidy` key, and the pre-rename `toolbox` key still honoured.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
