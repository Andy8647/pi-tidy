import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Measurement {
  count: number;
  mode: string;
  rows: number;
  samples: number[];
}

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseRoot = process.argv[2];
  if (!baseRoot) throw new Error("Usage: node scripts/bench-compare.ts <base-checkout> [head-checkout]");
  const headRoot = resolve(process.argv[3] ?? ".");
  const roots = [resolve(baseRoot), headRoot];
  const sha = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 }).trim();
  const revisions = roots.map(sha);
  const worker = fileURLToPath(new URL("bench-render.ts", import.meta.url));
  const results: { base: Measurement; head: Measurement }[] = [];
  for (const count of [100, 500, 1500]) {
    for (const mode of ["folded", "expanded"]) {
      const measurements: Measurement[][] = [[], []];
      // Reverse the order in round two so one revision is not always measured first.
      for (const order of [[0, 1], [1, 0]]) for (const index of order) {
        measurements[index].push(JSON.parse(execFileSync(process.execPath, [worker, roots[index], String(count), mode], {
          encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
        })));
      }
      const [base, head] = measurements.map((runs) => {
        if (runs.some((run) => run.count !== count || run.mode !== mode || run.rows !== runs[0].rows)) {
          throw new Error("Benchmark worker returned an inconsistent scenario");
        }
        return { ...runs[0], samples: runs.flatMap((run) => run.samples) };
      });
      results.push({ base, head });
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
    ...results.map(({ base, head }) => comparisonRow(base, head)), "",
    "Same PR-owned fixture and installed dependencies for both revisions; separate processes, alternating order.",
    "Each worker warms up 20 frames, then samples 80 frames; two workers per revision and scenario.",
    "Measures warm transcript render() only, not terminal drawing or scroll latency. Expanded means all tool outputs open.",
    "Positive changes mean slower. Small differences may be runner noise; timing changes do not fail CI.", "",
  ].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.env.BENCH_OUTPUT) writeFileSync(process.env.BENCH_OUTPUT, JSON.stringify({ ...metadata, results }, null, 2));
}
