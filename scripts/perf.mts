import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import * as v from "valibot";
import { judge } from "../.tests/perf/judge.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const metric = v.object({
  kind: v.picklist(["time", "size", "memory"]),
  samples: v.array(v.number()),
  queries: v.optional(v.number()),
});
const runResult = v.object({
  version: v.literal(1),
  seed: v.object({ artists: v.number(), albums: v.number(), tracks: v.number() }),
  metrics: v.record(v.string(), metric),
});

type Metric = v.InferOutput<typeof metric>;
type RunResult = v.InferOutput<typeof runResult>;

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    artists: { type: "string", default: "1200" },
    samples: { type: "string", default: "10" },
    rounds: { type: "string", default: "2" },
    out: { type: "string" },
    "report-only": { type: "boolean", default: false },
  },
});

function initialLoadBytes() {
  const dist = path.join(repoRoot, "frontend", "dist");
  const indexPath = path.join(dist, "index.html");
  if (!existsSync(indexPath)) return null;
  const html = readFileSync(indexPath, "utf8");
  const assets = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g),
  ].map((match) => match[1]!);
  return [indexPath, ...assets.map((asset) => path.join(dist, asset))].reduce(
    (total, file) => total + gzipSync(readFileSync(file), { level: 9 }).length,
    0,
  );
}

function residentBytes(pid: number) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kilobytes = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1]);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

async function run(): Promise<RunResult> {
  const { startPerfApp } = await import("../.tests/perf/harness.ts");
  const { scenarios } = await import("../.tests/perf/scenarios.ts");
  const { startServerProcess } = await import("../.tests/helpers/backendTestHarness.ts");
  const samples = Number(options.samples);
  const app = await startPerfApp({ artists: Number(options.artists) });
  const metrics: RunResult["metrics"] = {};
  try {
    for (let warmup = 0; warmup < 2; warmup += 1) {
      for (const scenario of scenarios) await app.run(scenario);
    }
    for (let sample = 0; sample < samples; sample += 1) {
      for (const scenario of scenarios) {
        const result = await app.run(scenario);
        const entry = (metrics[scenario.name] ??= { kind: "time", samples: [] });
        entry.samples.push(Number(result.ms.toFixed(3)));
        entry.queries = result.queries;
      }
    }
    const startup: Metric = { kind: "time", samples: [] };
    const memory: Metric = { kind: "memory", samples: [] };
    const guard = pathToFileURL(path.join(repoRoot, ".tests", "offline-guard.ts")).href;
    for (let sample = 0; sample < 3; sample += 1) {
      const started = performance.now();
      const server = await startServerProcess({ extraEnv: { NODE_OPTIONS: `--import=${guard}` } });
      startup.samples.push(Number((performance.now() - started).toFixed(1)));
      const rss = server.child.pid ? residentBytes(server.child.pid) : null;
      if (rss) memory.samples.push(rss);
      await server.stop();
    }
    metrics["server startup"] = startup;
    if (memory.samples.length) metrics["server memory at startup"] = memory;
  } finally {
    await app.close();
  }
  const bundle = initialLoadBytes();
  if (bundle) metrics["initial JS and CSS, gzip"] = { kind: "size", samples: [bundle] };
  return { version: 1, seed: app.seed, metrics };
}

function format(kind: Metric["kind"], value: number) {
  if (kind === "time") return value >= 100 ? `${value.toFixed(0)} ms` : `${value.toFixed(1)} ms`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function report(base: RunResult[], head: RunResult[]) {
  const names = Object.keys(head[0]!.metrics);
  const rows = names.map((name) => {
    const kind = head[0]!.metrics[name]!.kind;
    const baseRounds = base.map((result) => result.metrics[name]?.samples ?? []);
    if (baseRounds.some((samples) => !samples.length))
      return { name, kind, verdict: "new" as const };
    const headRounds = head.map((result) => result.metrics[name]!.samples);
    const queries = [base[0]!.metrics[name]!.queries, head[0]!.metrics[name]!.queries];
    return { name, kind, queries, ...judge(kind, baseRounds, headRounds) };
  });
  const regressions = rows.filter((row) => row.verdict === "slower");
  const { tracks } = head[0]!.seed;
  const lines = [
    "## Performance",
    "",
    regressions.length
      ? `${regressions.length} ${regressions.length === 1 ? "measurement is" : "measurements are"} slower than main.`
      : "Nothing is slower than main.",
    "",
    `${tracks.toLocaleString("en-US")} tracks, ${head.length} alternating rounds per side, medians.`,
    "",
    "| | main | this PR | change | queries |",
    "| --- | ---: | ---: | --- | ---: |",
    ...rows.map((row) => {
      if (row.verdict === "new") return `| ${row.name} | | | new | |`;
      const percent = ((row.headMedian - row.baseMedian) / row.baseMedian) * 100;
      const change =
        row.verdict === "same"
          ? ""
          : `${row.verdict} (${percent > 0 ? "+" : ""}${percent.toFixed(0)}%)`;
      const [baseQueries, headQueries] = row.queries;
      const queries =
        headQueries === undefined
          ? ""
          : baseQueries === undefined || Math.abs(headQueries - baseQueries) > baseQueries * 0.05
            ? `${baseQueries ?? "?"} → ${headQueries}`
            : String(headQueries);
      return `| ${row.name} | ${format(row.kind, row.baseMedian)} | ${format(row.kind, row.headMedian)} | ${change} | ${queries} |`;
    }),
    "",
  ];
  return { markdown: lines.join("\n"), regressions };
}

function runIn(checkout: string, out: string) {
  execFileSync(
    process.execPath,
    [
      "scripts/perf.mts",
      "run",
      "--artists",
      options.artists,
      "--samples",
      options.samples,
      "--out",
      out,
    ],
    { cwd: checkout, stdio: ["ignore", "ignore", "inherit"] },
  );
  return v.parse(runResult, JSON.parse(readFileSync(out, "utf8")));
}

async function compare(baseCheckout: string) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!existsSync(path.join(baseCheckout, "scripts", "perf.mts"))) {
    throw new Error(`${baseCheckout} has no scripts/perf.mts to compare against`);
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "aurral-perf-"));
  try {
    const base: RunResult[] = [];
    const head: RunResult[] = [];
    for (let round = 0; round < Number(options.rounds); round += 1) {
      base.push(runIn(baseCheckout, path.join(scratch, `base-${round}.json`)));
      head.push(runIn(repoRoot, path.join(scratch, `head-${round}.json`)));
    }
    const { markdown, regressions } = report(base, head);
    console.log(markdown);
    if (summary) appendFileSync(summary, markdown);
    if (regressions.length && !options["report-only"]) process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [command = "run", target] = positionals;
if (command === "run") {
  const result = await run();
  const json = JSON.stringify(result, null, 2);
  if (options.out) writeFileSync(options.out, json);
  else console.log(json);
} else if (command === "compare") {
  if (!target) throw new Error("Usage: node scripts/perf.mts compare <base checkout>");
  await compare(path.resolve(target));
} else if (command === "baseline") {
  const { measureBudgets, writeBaseline } = await import("../.tests/perf/budgets.ts");
  writeBaseline(await measureBudgets());
  console.log("Wrote .tests/perf/baseline.json");
} else {
  throw new Error(`Unknown command: ${command}. Use run, compare, or baseline.`);
}
process.exit();
