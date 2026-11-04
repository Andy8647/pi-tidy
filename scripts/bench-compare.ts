import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Measurement {
  count: number;
  mode: string;
  rows: number;
  samples: number[];
}

/** First line of the PR comment, so the next run patches it instead of adding one. */
export const COMMENT_MARKER = "<!-- pi-tidy-bench -->";

export function percentile(samples: number[], fraction: number): number {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid timing samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function comparisonRow(base: Measurement, head: Measurement): string {
  if (base.count !== head.count || base.mode !== head.mode) throw new Error("Benchmark scenarios do not match");
  const before = percentile(base.samples, 0.5);
  const after = percentile(head.samples, 0.5);
  const signed = (n: number, digits: number) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
  const percent = before > 0 ? `${signed((after / before - 1) * 100, 1)}%` : "n/a";
  return `| ${base.mode} | ${base.count} | ${base.rows} → ${head.rows} | ${before.toFixed(3)} | ${after.toFixed(3)} | ${signed(after - before, 3)} ms (${percent}) | ${percentile(base.samples, 0.95).toFixed(3)} → ${percentile(head.samples, 0.95).toFixed(3)} |`;
}

/**
 * A scenario the base revision cannot render — turn folding arrived in 0.7.0,
 * so a PR against an older base has no number to compare with. Its absolute
 * cost is still worth reporting, and the table keeps its shape.
 */
export function headOnlyRow(head: Measurement): string {
  return `| ${head.mode} | ${head.count} | — → ${head.rows} | — | ${percentile(head.samples, 0.5).toFixed(3)} | — | — |`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseRoot = process.argv[2];
  if (!baseRoot) throw new Error("Usage: node scripts/bench-compare.ts <base-checkout> [head-checkout]");
  const headRoot = resolve(process.argv[3] ?? ".");
  const roots = [resolve(baseRoot), headRoot];
  const sha = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 }).trim();
  const revisions = roots.map(sha);
  const worker = fileURLToPath(new URL("bench-render.ts", import.meta.url));
  // Turn folding arrived in 0.7.0: an older base has no module to render it with.
  const baseHasTurns = ["turn-state.ts", "src/turns/turn-state.ts"].some((file) => existsSync(resolve(roots[0]!, file)));
  const results: ({ base: Measurement; head: Measurement } | { head: Measurement })[] = [];
  const measure = (index: number, count: number, mode: string): Measurement =>
    JSON.parse(execFileSync(process.execPath, [worker, roots[index]!, String(count), mode], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
    }));
  for (const count of [100, 500, 1500]) {
    for (const mode of ["folded", "turns", "expanded"]) {
      if (mode === "turns" && !baseHasTurns) {
        const runs = [measure(1, count, mode), measure(1, count, mode)];
        results.push({ head: { ...runs[0]!, samples: runs.flatMap((run) => run.samples) } });
        console.error(`Measured ${count} components, ${mode} (PR only)`);
        continue;
      }
      const measurements: Measurement[][] = [[], []];
      // Reverse the order in round two so one revision is not always measured first.
      for (const order of [[0, 1], [1, 0]]) for (const index of order) {
        measurements[index]!.push(measure(index, count, mode));
      }
      const [base, head] = measurements.map((runs) => {
        if (runs.some((run) => run.count !== count || run.mode !== mode || run.rows !== runs[0]!.rows)) {
          throw new Error("Benchmark worker returned an inconsistent scenario");
        }
        return { ...runs[0]!, samples: runs.flatMap((run) => run.samples) };
      });
      results.push({ base: base!, head: head! });
      console.error(`Measured ${count} components, ${mode}`);
    }
  }
  const metadata = {
    base: revisions[0], head: revisions[1], node: process.version,
    platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model,
    width: 120, warmupFrames: 20, sampledFramesPerWorker: 80, rounds: 2,
  };
  const report = [
    "## Transcript render benchmark", "",
    `Base: \`${metadata.base}\` · PR: \`${metadata.head}\``, "",
    `${metadata.node} · ${metadata.platform} · ${metadata.cpu} · width ${metadata.width}`, "",
    "| State | Components | Rows base → PR | Base median (ms) | PR median (ms) | Median change | P95 base → PR (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((result) => "base" in result ? comparisonRow(result.base, result.head) : headOnlyRow(result.head)), "",
    ...("base" in results[0]! ? [] : ["Turn folding is newer than this PR's base; its rows only carry the PR's own numbers.", ""]),
    "Same PR-owned fixture and installed dependencies for both revisions; separate processes, alternating order.",
    "Each worker warms up 20 frames, then samples 80 frames; two workers per revision and scenario.",
    "Measures warm transcript render() only, not terminal drawing or scroll latency.",
    "Folded means every tool output closed, turns means each run folded to its summary, expanded means all tool outputs open.",
    "Positive changes mean slower. Small differences may be runner noise; timing changes do not fail CI.", "",
  ].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  // One comment per PR that each run overwrites; the marker is how it is found again.
  if (process.env.BENCH_COMMENT) writeFileSync(process.env.BENCH_COMMENT, `${COMMENT_MARKER}\n${report}`);
  if (process.env.BENCH_OUTPUT) writeFileSync(process.env.BENCH_OUTPUT, JSON.stringify({ ...metadata, results }, null, 2));
}
