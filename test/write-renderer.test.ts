/** The write preview must decorate rendering without taking ownership of execution. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWriteToolDefinition,
  initTheme,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import tidy from "../index.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
];
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/ +$/gm, "");

function harness() {
  const tools = new Map<string, ToolDefinition>();
  const resolvers: ToolRendererResolver[] = [];
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const conflicts: string[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tools.has(tool.name)) {
        conflicts.push(tool.name);
        throw new Error(`Tool "${tool.name}" conflicts with another extension`);
      }
      tools.set(tool.name, tool);
    },
    registerToolRenderer(resolver: ToolRendererResolver) { resolvers.push(resolver); },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  function resolve(name: string, base?: ToolRenderers): ToolRenderers | undefined {
    const visit = (index: number): ToolRenderers | undefined => index < resolvers.length
      ? resolvers[index](name, () => visit(index + 1))
      : base ?? tools.get(name);
    return visit(0);
  }
  return { pi, tools, resolvers, handlers, conflicts, resolve };
}

function loadTidy(pi: ExtensionAPI, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-renderer-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      tidy: { highlightBash: false, backgroundJobs: false, ...config },
    }));
    process.env.PI_CODING_AGENT_DIR = dir;
    tidy(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const tidyFirst of [true, false]) {
  test(`write execution stays sandboxed when Tidy loads ${tidyFirst ? "first" : "last"}`, async () => {
    const h = harness();
    const denied = new Error("Sandbox denied this write");
    const sandboxed = {
      ...createWriteToolDefinition(process.cwd()),
      description: "Sandboxed write",
      execute: async () => { throw denied; },
    };
    if (tidyFirst) loadTidy(h.pi);
    h.pi.registerTool(sandboxed);
    if (!tidyFirst) loadTidy(h.pi);

    assert.deepEqual(h.conflicts, []);
    assert.equal(h.tools.size, 1);
    assert.strictEqual(h.tools.get("write"), sandboxed, "schema, metadata and execute are untouched");
    assert.equal(h.resolvers.length, 1, "only a renderer is registered");
    assert.notStrictEqual(h.resolve("write")?.renderCall, sandboxed.renderCall);
    assert.strictEqual(h.resolve("write")?.renderResult, sandboxed.renderResult);
    await assert.rejects(
      () => h.tools.get("write")!.execute(
        "call", { path: "/denied.txt", content: "test" }, undefined, undefined, {} as any,
      ),
      (error) => error === denied,
    );
  });
}

test("Tidy does not register write even without another execution extension", () => {
  const h = harness();
  loadTidy(h.pi);
  assert.equal(h.tools.size, 0);
  assert.equal(h.resolvers.length, 1);
  assert.equal(typeof h.resolve("write")?.renderCall, "function");
  assert.equal(h.resolve("unregistered"), undefined);
});

test("write rendering preserves the downstream shell and success/error result renderer", () => {
  const h = harness();
  loadTidy(h.pi);
  const original: ToolRenderers = {
    renderShell: "self",
    renderCall: () => new Text("original call", 0, 0),
    renderResult: (_result, _options, _theme, context) =>
      new Text(context.isError ? "sandbox denial" : "sandbox success", 0, 0),
  };
  // Another resolver may be installed later; it must still be consulted via next().
  h.pi.registerToolRenderer((_name, _next) => original);
  const rendered = h.resolve("write")!;
  assert.equal(rendered.renderShell, "self");
  assert.notStrictEqual(rendered.renderCall, original.renderCall);
  assert.strictEqual(rendered.renderResult, original.renderResult);
  for (const isError of [false, true]) {
    const result = rendered.renderResult!(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { isError, state: {} } as any,
    );
    assert.match(result.render(80).join("\n"), isError ? /sandbox denial/ : /sandbox success/);
  }
  assert.strictEqual(h.resolve("read"), original, "unrelated tools pass through unchanged");
});

test("the registered write renderer respects preview limits, expansion and streaming updates", () => {
  for (const lines of [0, 2, 10]) {
    const h = harness();
    loadTidy(h.pi, { writeLines: lines });
    const renderer = h.resolve("write")!.renderCall!;
    const originalCallText = new Text("owned by the execution extension", 0, 0);
    const context = { state: { callText: originalCallText }, expanded: false } as any;
    const args = { path: "/tmp/test.txt", content: "alpha\nbeta\ngamma" };
    const component = renderer(args, theme, context);
    const collapsed = plain(component.render(80).join("\n"));
    if (lines === 0) assert.doesNotMatch(collapsed, /alpha/);
    if (lines === 2) {
      assert.match(collapsed, /alpha\nbeta/);
      assert.doesNotMatch(collapsed, /gamma/);
      assert.match(collapsed, /1 more lines, 3 total/);
    }
    if (lines === 10) assert.match(collapsed, /alpha\nbeta\ngamma/);

    context.expanded = true;
    const expanded = renderer(args, theme, context);
    assert.strictEqual(expanded, component, "reuse the call's Text component");
    assert.match(plain(expanded.render(80).join("\n")), /alpha\nbeta\ngamma/);
    assert.doesNotMatch(plain(expanded.render(80).join("\n")), /more lines/);
    const updated = renderer({ ...args, content: "updated" }, theme, context);
    assert.match(plain(updated.render(80).join("\n")), /updated/);
    assert.match(originalCallText.render(80).join("\n"), /owned by the execution extension/);
  }
});

test("older Pi without the renderer API skips the preview rather than overriding write", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(h.pi);
  assert.equal(h.tools.size, 0, "no unsafe registerTool fallback");
  const warnings: string[] = [];
  for (const handler of h.handlers.get("session_start") ?? []) {
    await handler({}, { ui: { notify: (message: string) => warnings.push(message) } });
  }
  assert.ok(warnings.some((message) => /write.*preview/i.test(message) && /registerToolRenderer/.test(message)));
});

test("disabled Tidy registers neither tools nor renderers", () => {
  const h = harness();
  loadTidy(h.pi, { enabled: false });
  assert.equal(h.tools.size, 0);
  assert.equal(h.resolvers.length, 0);
});
