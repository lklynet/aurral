import { readFileSync, writeFileSync } from "node:fs";
import * as v from "valibot";
import { startPerfApp } from "./harness.ts";
import { scenarios } from "./scenarios.ts";

export const BASELINE_PATH = new URL("./baseline.json", import.meta.url);
const BUDGET_ARTISTS = 120;

const budget = v.object({
  queries: v.object({ cold: v.number(), warm: v.number() }),
  bytes: v.number(),
  scans: v.array(v.string()),
});
const baselineFile = v.record(v.string(), budget);

export type Budgets = v.InferOutput<typeof baselineFile>;

export function readBaseline(): Budgets {
  return v.parse(baselineFile, JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
}

export function writeBaseline(budgets: Budgets) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
}

export async function measureBudgets(): Promise<Budgets> {
  const app = await startPerfApp({ artists: BUDGET_ARTISTS });
  try {
    const budgets: Budgets = {};
    for (const scenario of scenarios) {
      const cold = await app.run(scenario);
      const warm = await app.run(scenario);
      budgets[scenario.name] = {
        queries: { cold: cold.queries, warm: warm.queries },
        bytes: warm.bytes,
        scans: [...new Set([...cold.scans, ...warm.scans])].sort(),
      };
    }
    return budgets;
  } finally {
    await app.close();
  }
}

const drift = (label: string, measured: number, baseline: number, tolerance: number) => {
  const allowed = Math.ceil(baseline * tolerance);
  if (measured > baseline + allowed) return `${label} rose from ${baseline} to ${measured}`;
  if (measured < baseline - allowed) return `${label} fell from ${baseline} to ${measured}`;
  return null;
};

export function compareBudgets(baseline: Budgets, measured: Budgets) {
  const problems: string[] = [];
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(measured)])) {
    const expected = baseline[name];
    const actual = measured[name];
    if (!expected || !actual) {
      problems.push(`${name}: ${expected ? "no longer measured" : "has no baseline"}`);
      continue;
    }
    const tolerance = scenarios.find((scenario) => scenario.name === name)?.random ? 0.25 : 0.05;
    const changes = [
      drift("cold queries", actual.queries.cold, expected.queries.cold, tolerance),
      drift("warm queries", actual.queries.warm, expected.queries.warm, tolerance),
      drift("response bytes", actual.bytes, expected.bytes, tolerance),
      ...actual.scans
        .filter((table) => !expected.scans.includes(table))
        .map((table) => `now scans all of ${table}`),
      ...expected.scans
        .filter((table) => !actual.scans.includes(table))
        .map((table) => `no longer scans all of ${table}`),
    ].filter((change) => change !== null);
    if (changes.length) problems.push(`${name}: ${changes.join(", ")}`);
  }
  return problems;
}
