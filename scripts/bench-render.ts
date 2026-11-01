import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, initTheme,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createCodemodeExtension,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

// The driver always comes from the PR; only Tidy's modules change between revisions.
const [root, countArg, mode] = process.argv.slice(2);
const count = Number(countArg);
if (!root || !Number.isInteger(count) || count < 10 || count % 10 || !["folded", "expanded"].includes(mode)) {
  throw new Error("Usage: node scripts/bench-render.ts <checkout> <components: multiple of 10> <folded|expanded>");
}
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { patchToolBoxFrames, patchContainerBoxes } = await load("frame.ts");
const { tidyEnabled, agentRunning } = await load("live.ts");
const { resetGroups } = await load("tool-groups.ts");
const { codemodeSections } = await load("codemode-body.ts");
initTheme("dark");
tidyEnabled.set(true);
agentRunning.set(false);
patchToolBoxFrames({ icons: true, groupTools: true, splitDiff: true, diffLines: 20, backgroundJobs: false });
patchContainerBoxes({ user: "toolTitle" }, { icons: true, includeUser: true, enabled: true });
resetGroups();

const cwd = "/workspace/tidy-benchmark";
const ui = { requestRender() {} } as unknown as TUI;
const definitions: Record<string, ToolDefinition<any, any>> = {
  bash: createBashToolDefinition(cwd), read: createReadToolDefinition(cwd), edit: createEditToolDefinition(cwd),
};
createCodemodeExtension()({ registerTool: (tool: ToolDefinition<any, any>) => { definitions.codemode = tool; } } as ExtensionAPI);
const chat = new Container();
const tools: ToolExecutionComponent[] = [];
const scripts: ToolExecutionComponent[] = [];
const assistant = (content: any[], stopReason = "stop") =>
  new AssistantMessageComponent({ role: "assistant", content, stopReason } as any, true);
for (let turn = 0; turn < count / 10; turn++) {
  const path = `${cwd}/src/module-${turn}.ts`;
  chat.addChild(new UserMessageComponent(`Check module ${turn}, inspect its tests, then fix the result. 检查边界情况。`));
  chat.addChild(assistant([{ type: "text", text: `## Module ${turn}\n\nI will inspect the implementation and its tests.` }]));
  for (const name of ["read", "bash", "codemode", "edit"]) {
    const id = `call-${turn}-${name}`;
    const args = name === "bash" ? { command: `pnpm test --filter module-${turn}` }
      : name === "codemode" ? { code: `const source = await tools.read({ path: "${path}" });\nawait tools.bash({ command: "pnpm lint" });\ntext(source);` }
      : name === "edit" ? { path, edits: [{ oldText: `const value = ${turn};`, newText: `const value = ${turn + 1};` }] }
      : { path, offset: 1, limit: 40 };
    if (name !== "edit") chat.addChild(assistant([
      { type: "thinking", thinking: `Check module ${turn}: read the source, verify the boundary condition, then compare the test result.` },
      { type: "toolCall", id, name, arguments: args },
    ], "toolUse"));
    const tool = new ToolExecutionComponent(name, id, args, {}, definitions[name], ui, cwd);
    tool.setArgsComplete();
    tool.markExecutionStarted();
    const diff = Array.from({ length: 40 }, (_, line) =>
      `${line < 20 ? "-" : "+"}${line % 20 + 1} const value${line % 20} = ${turn + (line < 20 ? 0 : 1)};`).join("\n");
    tool.updateResult({
      content: name === "codemode" ? [
        { type: "text", text: "Script completed\nWall time 0.125 seconds\nOutput:\n" },
        { type: "text", text: "==> text 1/1 <==\nSource inspected" },
      ] : [{ type: "text", text: Array.from({ length: 40 }, (_, line) => `const value${line} = ${turn + line};`).join("\n") }],
      isError: name === "bash" && turn % 5 === 0, durationMs: 125,
      details: name === "edit" ? { diff, firstChangedLine: 1 } : name === "codemode" ? { calls: [
        { id: `${id}/1`, name: "read", args: JSON.stringify({ path }), status: "ok", durationMs: 20 },
        { id: `${id}/2`, name: "bash", args: JSON.stringify({ command: "pnpm lint" }), status: "ok", durationMs: 50 },
      ], durationMs: 125 } : undefined,
    });
    tools.push(tool);
    if (name === "codemode") scripts.push(tool);
    chat.addChild(tool);
  }
  chat.addChild(assistant([{ type: "text", text: `Updated module ${turn}.\n\n- Checked the implementation\n- Compared the test output` }]));
}
if (chat.children.length !== count) throw new Error("Fixture component count changed");
const width = 120;
chat.render(width); // Discover groups before expand-all, as in a live transcript.
if (mode === "expanded") {
  for (const tool of tools) tool.setExpanded(true);
  // Nested script/output sections have independent toggles inside a group.
  for (const script of scripts) Object.assign(codemodeSections(script), { script: true, output: true });
}
for (let frame = 0; frame < 20; frame++) chat.render(width);
const preview = chat.render(width).join("\n");
const markers = mode === "folded" ? ["3 calls", "diff"] : ["Source inspected", "value19"];
for (const marker of markers) if (!preview.includes(marker)) throw new Error(`Fixture is missing ${marker}`);
const samples: number[] = [];
let rows = 0;
for (let frame = 0; frame < 80; frame++) {
  const started = performance.now();
  const lines = chat.render(width);
  samples.push(performance.now() - started);
  rows = lines.length;
}
console.log(JSON.stringify({ count, mode, rows, samples }));
process.exit(0); // Theme / UI timers must not keep a benchmark worker alive.
