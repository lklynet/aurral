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
import { parseRun, renderComparison, type RunResult } from "./perf-report.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    artists: { type: "string", default: "600" },
    samples: { type: "string", default: "5" },
    rounds: { type: "string", default: "2" },
    out: { type: "string" },
    json: { type: "string" },
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
    for (const group of [
      scenarios.filter((scenario) => !scenario.writes),
      scenarios.filter((scenario) => scenario.writes),
    ]) {
      for (const scenario of group) await app.run(scenario);
      for (let sample = 0; sample < samples; sample += 1) {
        for (const scenario of group) {
          const result = await app.run(scenario);
          const entry = (metrics[scenario.name] ??= { kind: "time", samples: [] });
          entry.samples.push(Number(result.ms.toFixed(3)));
          entry.queries = result.queries;
        }
      }
    }
    const guard = pathToFileURL(path.join(repoRoot, ".tests", "offline-guard.ts")).href;
    const started = performance.now();
    const server = await startServerProcess({ extraEnv: { NODE_OPTIONS: `--import=${guard}` } });
    metrics["server startup"] = {
      kind: "time",
      samples: [Number((performance.now() - started).toFixed(1))],
    };
    const rss = server.child.pid ? residentBytes(server.child.pid) : null;
    if (rss) metrics["server memory at startup"] = { kind: "memory", samples: [rss] };
    await server.stop();
  } finally {
    await app.close();
  }
  const bundle = initialLoadBytes();
  if (bundle) metrics["initial JS and CSS, gzip"] = { kind: "size", samples: [bundle] };
  return { version: 1, seed: app.seed, metrics };
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
  return parseRun(JSON.parse(readFileSync(out, "utf8")));
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
    if (options.json) writeFileSync(options.json, JSON.stringify({ base, head }));
    const { markdown, slower } = renderComparison({ base, head });
    console.log(markdown);
    if (summary) appendFileSync(summary, markdown);
    if (slower && !options["report-only"]) process.exitCode = 1;
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
