import { readFileSync } from "node:fs";
import { judge, type MetricKind } from "../.tests/perf/judge.ts";

type Metric = { kind: MetricKind; samples: number[]; queries?: number };
export type RunResult = {
  version: 1;
  seed: { artists: number; albums: number; tracks: number };
  metrics: Record<string, Metric>;
};
export type Comparison = { base: RunResult[]; head: RunResult[] };

const NAME = /^[\w ,.-]{1,80}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e12;
const isKind = (value: unknown): value is MetricKind =>
  value === "time" || value === "size" || value === "memory";

function parseMetric(name: string, value: unknown): Metric {
  if (!NAME.test(name) || !isRecord(value)) throw new Error(`Unreadable perf metric: ${name}`);
  const { kind, samples, queries } = value;
  if (
    !isKind(kind) ||
    !Array.isArray(samples) ||
    !samples.length ||
    samples.length > 1000 ||
    !samples.every(isAmount) ||
    (queries !== undefined && !isAmount(queries))
  ) {
    throw new Error(`Unreadable perf metric: ${name}`);
  }
  return queries === undefined ? { kind, samples } : { kind, samples, queries };
}

export function parseRun(value: unknown): RunResult {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.seed) || !isRecord(value.metrics))
    throw new Error("Not a perf run result");
  const { artists, albums, tracks } = value.seed;
  const entries = Object.entries(value.metrics);
  if (!isAmount(artists) || !isAmount(albums) || !isAmount(tracks) || entries.length > 100)
    throw new Error("Not a perf run result");
  return {
    version: 1,
    seed: { artists, albums, tracks },
    metrics: Object.fromEntries(entries.map(([name, metric]) => [name, parseMetric(name, metric)])),
  };
}

export function parseComparison(value: unknown): Comparison {
  if (
    !isRecord(value) ||
    !Array.isArray(value.base) ||
    !Array.isArray(value.head) ||
    !value.head.length ||
    value.head.length > 10 ||
    value.base.length !== value.head.length
  ) {
    throw new Error("Not a perf comparison");
  }
  return { base: value.base.map(parseRun), head: value.head.map(parseRun) };
}

function format(kind: MetricKind, value: number) {
  if (kind === "time") return value >= 100 ? `${value.toFixed(0)} ms` : `${value.toFixed(1)} ms`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function queryChange(base: number | undefined, head: number | undefined) {
  if (head === undefined) return "";
  if (base === undefined || Math.abs(head - base) > base * 0.05) return `${base ?? "?"} → ${head}`;
  return String(head);
}

export function renderComparison({ base, head }: Comparison) {
  const [firstHead] = head;
  if (!firstHead) throw new Error("Not a perf comparison");
  const rows = Object.entries(firstHead.metrics).map(([name, { kind }]) => {
    const baseRounds = base.map((result) => result.metrics[name]?.samples ?? []);
    if (baseRounds.some((samples) => !samples.length)) return `| ${name} | | | new | |`;
    const headRounds = head.map((result) => result.metrics[name]?.samples ?? []);
    const { baseMedian, headMedian, verdict } = judge(kind, baseRounds, headRounds);
    const percent = ((headMedian - baseMedian) / baseMedian) * 100;
    const change =
      verdict === "same" ? "" : `${verdict} (${percent > 0 ? "+" : ""}${percent.toFixed(0)}%)`;
    const queries = queryChange(base[0]?.metrics[name]?.queries, firstHead.metrics[name]?.queries);
    return {
      verdict,
      line: `| ${name} | ${format(kind, baseMedian)} | ${format(kind, headMedian)} | ${change} | ${queries} |`,
    };
  });
  const slower = rows.filter((row) => typeof row !== "string" && row.verdict === "slower").length;
  const markdown = [
    "## Performance",
    "",
    slower
      ? `${slower} ${slower === 1 ? "measurement is" : "measurements are"} slower than main.`
      : "Nothing is slower than main.",
    "",
    `${firstHead.seed.tracks.toLocaleString("en-US")} tracks, ${head.length} alternating rounds per side, medians.`,
    "",
    "| | main | this PR | change | queries |",
    "| --- | ---: | ---: | --- | ---: |",
    ...rows.map((row) => (typeof row === "string" ? row : row.line)),
    "",
  ].join("\n");
  return { markdown, slower };
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("Usage: node scripts/perf-report.mts <comparison.json>");
  const { markdown } = renderComparison(parseComparison(JSON.parse(readFileSync(file, "utf8"))));
  process.stdout.write(markdown);
}
