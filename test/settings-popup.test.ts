import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig, saveTidySettings } from "../src/config.ts";
import { visibleText } from "../src/draw/frame-draw.ts";
import tidy from "../src/index.ts";
import { FOLLOW_STYLE, TidySettingsPopup, type SettingsPopupResult } from "../src/settings-popup.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { harness } from "./renderer-harness.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
};

function withTempAgentDir<T>(initialSettings: unknown | undefined, fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-settings-popup-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  if (initialSettings !== undefined) {
    const raw = typeof initialSettings === "string" ? initialSettings : JSON.stringify(initialSettings, null, 2);
    writeFileSync(join(dir, "settings.json"), raw, "utf-8");
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  const cleanup = () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const out = fn(dir);
    if (out && typeof (out as Promise<T>).then === "function") {
      return (out as Promise<T>).finally(cleanup);
    }
    cleanup();
    return out;
  } catch (error) {
    cleanup();
    throw error;
  }
}

test("saveTidySettings merges changed keys without replacing other top-level or tidy keys", () =>
  withTempAgentDir(
    {
      theme: "catppuccin-mocha",
      defaultProvider: "openai-codex",
      tidy: {
        messageBorderColors: { assistant: "accent" },
        toolColors: {},
        thinkingColor: "accent",
        writeLines: 2,
      },
    },
    (dir) => {
      const updated = saveTidySettings({ collapseTurns: "live", bashResultLines: 3 });
      assert.equal(updated.collapseTurns, "live");
      assert.equal(updated.bashResultLines, 3);
      assert.equal(updated.writeLines, 2);

      const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      assert.equal(onDisk.theme, "catppuccin-mocha");
      assert.equal(onDisk.defaultProvider, "openai-codex");
      assert.deepEqual(onDisk.tidy, {
        messageBorderColors: { assistant: "accent" },
        toolColors: {},
        thinkingColor: "accent",
        writeLines: 2,
        collapseTurns: "live",
        bashResultLines: 3,
      });
    },
  ));

test("saveTidySettings preserves pre-rename toolbox keys and deletes reset overrides", () =>
  withTempAgentDir({ toolbox: { icons: false, userMessageStyle: "frame", frameFinalReply: false } }, (dir) => {
    const updated = saveTidySettings({
      style: "rail",
      userMessageStyle: undefined,
      finalReplyStyle: undefined,
      frameFinalReply: undefined,
    });
    assert.equal(updated.icons, false, "existing toolbox keys are carried over when writing tidy");
    assert.equal(updated.userMessageStyle, "rail");
    assert.equal(updated.finalReplyStyle, "rail");

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    assert.deepEqual(onDisk.tidy, { icons: false, style: "rail" });
  }));

test("saveTidySettings creates missing directories and refuses to clobber malformed JSON", () => {
  withTempAgentDir(undefined, (dir) => {
    const nested = join(dir, "nested", "agent");
    process.env.PI_CODING_AGENT_DIR = nested;
    saveTidySettings({ groupTools: false });
    const saved = JSON.parse(readFileSync(join(nested, "settings.json"), "utf-8"));
    assert.deepEqual(saved, { tidy: { groupTools: false } });
  });

  withTempAgentDir("{ broken json", (dir) => {
    assert.throws(() => saveTidySettings({ style: "frame" }));
    assert.equal(readFileSync(join(dir, "settings.json"), "utf-8"), "{ broken json");
  });
});

test("saveTidySettings writes through a linked settings.json and keeps the link", () =>
  withTempAgentDir(undefined, (dir) => {
    const target = join(dir, "dotfiles-settings.json");
    writeFileSync(target, JSON.stringify({ theme: "dark", tidy: { icons: true } }), "utf-8");
    symlinkSync(target, join(dir, "settings.json"));
    saveTidySettings({ groupTools: false });
    assert.ok(lstatSync(join(dir, "settings.json")).isSymbolicLink(), "still a link");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf-8")), { theme: "dark", tidy: { icons: true, groupTools: false } });
  }));

test("TidySettingsPopup renders within width and height bounds, filters, previews, and cancels cleanly", () =>
  withTempAgentDir({ tidy: { bashResultLines: 23, style: "rail" } }, (dir) => {
    const beforeDisk = readFileSync(join(dir, "settings.json"), "utf-8");
    const previews: string[] = [];
    let finished: SettingsPopupResult | undefined;
    let renderRequests = 0;

    const popup = new TidySettingsPopup(
      { bashResultLines: 23, style: "rail" },
      { requestRender: () => { renderRequests++; }, terminal: { rows: 18 } },
      theme,
      {
        onPreview: (cfg) => previews.push(`${cfg.collapseTurns}:${cfg.style}:${cfg.bashResultLines}`),
        needsReload: () => false,
      },
      (res) => { finished = res; },
    );

    const initialLines = popup.render(56);
    assert.ok(initialLines.every((line) => visibleWidth(line) <= 56), "every line fits the popup width");
    assert.match(visibleText(initialLines[0]!), /^╭─ tidy settings .*╮$/);
    assert.match(visibleText(initialLines.at(-1)!), /^╰─+╯$/, "bottom border is intact on short 18-row terminals");
    const initialText = initialLines.map(visibleText).join("\n");
    assert.match(initialText, /collapseTurns\s+◂ afterRun ▸/);
    assert.match(initialText, /bashResultLines\s+23/, "custom numeric values are shown and preserved");

    // Cycle collapseTurns: afterRun -> live
    popup.handleInput(KEYS.right);
    assert.ok(renderRequests > 0);
    assert.equal(previews.at(-1), "live:rail:23");

    // Filter to `style`, cycle rail -> frame, then clear filter with Backspace
    for (const ch of "style") popup.handleInput(ch);
    const filteredText = popup.render(56).map(visibleText).join("\n");
    assert.match(filteredText, /filter: style/);
    assert.match(filteredText, /style\s+◂ rail ▸/);
    popup.handleInput(KEYS.right);
    assert.equal(previews.at(-1), "live:frame:23");

    for (let i = 0; i < "style".length; i++) popup.handleInput(KEYS.backspace);

    // Cancel with Escape: live preview reverts to initial config and disk stays untouched
    popup.handleInput(KEYS.escape);
    assert.deepEqual(finished, { action: "cancelled" });
    assert.equal(previews.at(-1), "afterRun:rail:23", "cancel restores initial live preview");
    assert.equal(readFileSync(join(dir, "settings.json"), "utf-8"), beforeDisk, "cancel leaves settings.json unchanged");
  }));

test("TidySettingsPopup tracks surface inheritance (`follow style`) without pinning unset surfaces", () =>
  withTempAgentDir({ tidy: {} }, () => {
    let result: SettingsPopupResult | undefined;
    const patches: Record<string, unknown>[] = [];
    const popup = new TidySettingsPopup(
      {},
      { requestRender() {}, terminal: { rows: 32 } },
      theme,
      {
        onPreview() {},
        needsReload: () => false,
        save: (patch) => {
          patches.push(patch);
          return saveTidySettings(patch);
        },
      },
      (res) => { result = res; },
    );

    // Filter to `userMessageStyle` — initially `follow style (rail)`
    for (const ch of "userMessageStyle") popup.handleInput(ch);
    assert.match(popup.render(70).map(visibleText).join("\n"), /follow style \(rail\)/);

    // Clear filter, move to `style` (row index 2), change `rail` -> `frame`, and save
    for (let i = 0; i < "userMessageStyle".length; i++) popup.handleInput(KEYS.backspace);
    popup.handleInput(KEYS.down); // groupTools
    popup.handleInput(KEYS.down); // style
    popup.handleInput(KEYS.space); // rail -> frame
    popup.handleInput(KEYS.enter);

    assert.equal(result?.action, "saved");
    assert.deepEqual(patches, [{ style: "frame" }], "unset surface overrides stay unset so they follow style");
    assert.equal(loadConfig().userMessageStyle, "frame");
    assert.equal(loadConfig().finalReplyStyle, "frame");
    assert.equal(FOLLOW_STYLE, "__follow_style__");
  }));

test("/tidy settings applies live to real pi components, reverts on cancel, and saves on confirm", async () =>
  await withTempAgentDir(
    {
      theme: "dark",
      tidy: { groupTools: false, style: "rail", bashResultLines: 1, icons: false },
    },
    async (dir) => {
      resetGroups();
      const h = harness();
      tidy(h.pi);

      assert.ok(h.commands.has("tidy"));
      const completions = h.commands.get("tidy").getArgumentCompletions("");
      assert.deepEqual(completions.map((c: any) => c.label), ["settings", "turn"]);

      const bashDef = createBashToolDefinition(process.cwd());
      const resolvedDef = { ...bashDef, ...h.resolve("bash", bashDef as any) };
      const box = new ToolExecutionComponent(
        "bash",
        "call-live-1",
        { command: "echo hi" },
        {},
        resolvedDef as any,
        { requestRender() {} } as any,
        process.cwd(),
      );
      box.setArgsComplete();
      box.markExecutionStarted();
      box.updateResult(
        { content: [{ type: "text", text: "line-1\nline-2\nline-3" }], isError: false, durationMs: 5 } as any,
        false,
      );

      const railRender = box.render(80).map(visibleText);
      assert.doesNotMatch(railRender[0]!, /^╭/, "starts in rail style");
      assert.doesNotMatch(railRender.join("\n"), /line-2/, "starts with bashResultLines: 1");

      // 1) Open `/tidy settings`, preview `style: frame` + `bashResultLines: 3`, then CANCEL with Esc
      const notifications: Array<{ message: string; level: string }> = [];
      let overlayUsed = false;
      const cancelCtx: any = {
        mode: "tui",
        sessionManager: { getBranch: () => [] },
        ui: {
          notify: (message: string, level = "info") => notifications.push({ message, level }),
          custom: async (factory: any, options: any) => {
            overlayUsed = Boolean(options?.overlay);
            return await new Promise((resolve) => {
              const tui = {
                terminal: { rows: 30 },
                invalidate: () => box.invalidate(),
                requestRender: () => {},
              };
              const comp = factory(tui, theme, undefined, resolve);
              comp.render(72);
              comp.handleInput(KEYS.down); // groupTools
              comp.handleInput(KEYS.down); // style
              comp.handleInput(KEYS.right); // rail -> frame (live preview!)
              const previewFrame = box.render(80).map(visibleText);
              assert.match(previewFrame[0]!, /^╭/, "live preview switches real ToolExecutionComponent to rounded frame");

              comp.handleInput(KEYS.down); // bashResultLines
              comp.handleInput(KEYS.right); // 1 -> 2
              comp.handleInput(KEYS.right); // 2 -> 3
              const previewLines = box.render(80).map(visibleText).join("\n");
              assert.match(previewLines, /line-3/, "live preview updates bashResultLines on existing component");

              comp.handleInput(KEYS.escape); // cancel!
            });
          },
        },
      };

      await h.commands.get("tidy").handler("settings", cancelCtx);
      assert.equal(overlayUsed, true, "settings opens as an overlay popup");
      assert.equal(notifications.length, 0, "cancel emits no save notice");
      const revertedRender = box.render(80).map(visibleText);
      assert.deepEqual(revertedRender, railRender, "cancel restores live rendering back to rail + 1 line");
      const afterCancelDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      assert.equal(afterCancelDisk.tidy.style, "rail");
      assert.equal(afterCancelDisk.tidy.bashResultLines, 1);

      // 2) Open `/tidy` (shortcut for `/tidy settings`), change `style: frame` + `bashResultLines: 3`, SAVE with Enter
      const saveCtx: any = {
        ...cancelCtx,
        ui: {
          ...cancelCtx.ui,
          custom: async (factory: any) =>
            await new Promise((resolve) => {
              const tui = {
                terminal: { rows: 30 },
                invalidate: () => box.invalidate(),
                requestRender: () => {},
              };
              const comp = factory(tui, theme, undefined, resolve);
              comp.render(72);
              comp.handleInput(KEYS.down); // groupTools
              comp.handleInput(KEYS.down); // style
              comp.handleInput(KEYS.space); // rail -> frame
              comp.handleInput(KEYS.down); // bashResultLines
              comp.handleInput(KEYS.right); // 1 -> 2
              comp.handleInput(KEYS.right); // 2 -> 3
              comp.handleInput(KEYS.enter); // save!
            }),
        },
      };

      await h.commands.get("tidy").handler("", saveCtx);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /saved \(style, bashResultLines\)/);
      assert.doesNotMatch(notifications[0]!.message, /\/reload/, "live-applied changes do not ask for /reload");

      const savedFrame = box.render(80).map(visibleText);
      assert.match(savedFrame[0]!, /^╭/);
      assert.match(savedFrame.join("\n"), /line-3/);

      const afterSaveDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      assert.equal(afterSaveDisk.theme, "dark", "unrelated top-level keys remain intact");
      assert.deepEqual(afterSaveDisk.tidy, {
        groupTools: false,
        style: "frame",
        bashResultLines: 3,
        icons: false,
      });
    },
  ));

test("/tidy settings prompts for /reload when enabling Tidy from a disabled startup state", async () =>
  await withTempAgentDir({ tidy: { enabled: false } }, async (dir) => {
    const h = harness();
    tidy(h.pi);
    assert.equal(h.resolvers.length, 0, "disabled startup registers no renderers");
    assert.equal(h.commands.has("tidy"), true, "/tidy settings is still registered so the user can re-enable it");

    const notifications: string[] = [];
    await h.commands.get("tidy").handler("settings", {
      mode: "tui",
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (msg: string) => notifications.push(msg),
        custom: async (factory: any) =>
          await new Promise((resolve) => {
            const comp = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, undefined, resolve);
            for (const ch of "enabled") comp.handleInput(ch);
            comp.handleInput(KEYS.space); // false -> true
            comp.handleInput(KEYS.enter);
          }),
      },
    });

    assert.equal(existsSync(join(dir, "settings.json")), true);
    assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")).tidy.enabled, true);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /\/reload/);
  }));

test("/tidy settings handles mouse clicks, wheel scrolling, and non-interactive modes", async () =>
  await withTempAgentDir({ tidy: { groupTools: true } }, async () => {
    const previews: boolean[] = [];
    const popup = new TidySettingsPopup(
      { groupTools: true },
      { requestRender() {}, terminal: { rows: 30 } },
      theme,
      { onPreview: (cfg) => previews.push(cfg.groupTools), needsReload: () => false },
      () => {},
    );
    popup.render(64);
    // Row 0 is top border, row 1 is `collapseTurns` (index 0), row 2 is `groupTools` (index 1).
    popup.handleMouse({ type: "press", button: "left", x: 6, y: 2, width: 64, height: 20 } as any);
    popup.handleMouse({ type: "click", button: "left", x: 6, y: 2, width: 64, height: 20 } as any);
    assert.deepEqual(previews, [false], "left-clicking row 2 selects and toggles groupTools");

    const wheelResult = popup.handleMouse({ type: "wheel", wheelDelta: 1, x: 6, y: 2, width: 64, height: 20 } as any);
    assert.equal(wheelResult?.handled, true);
    assert.equal(wheelResult?.render, true);

    const h = harness();
    tidy(h.pi);
    const warnings: string[] = [];
    await h.commands.get("tidy").handler("settings", {
      mode: "rpc",
      ui: { notify: (msg: string) => warnings.push(msg) },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /interactive mode/);
  }));

