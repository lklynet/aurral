import { readFileSync } from "node:fs";

const SPLITS = new Set(["development", "acceptance"]);

export function loadFixtureSet(split) {
  if (!SPLITS.has(split)) throw new Error(`Unknown fixture split: ${split}`);
  const file = new URL(`./fixtures/${split}.jsonl`, import.meta.url);
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

export function measureFixtureDecisions(cases, decide) {
  const report = {};
  for (const item of cases) {
    const metrics = report[item.flow] ||= {
      total: 0,
      actionable: 0,
      correct: 0,
      wrong: 0,
      contradictionAcceptances: 0,
      abstentions: 0,
      yield: null,
    };
    metrics.total += 1;
    if (item.actionable) metrics.actionable += 1;
    const selected = decide(item);
    if (selected == null) metrics.abstentions += 1;
    else if (item.correctIds.includes(selected)) metrics.correct += 1;
    else metrics.wrong += 1;
    if (item.contradictedIds.includes(selected)) metrics.contradictionAcceptances += 1;
  }
  for (const metrics of Object.values(report)) {
    if (metrics.actionable > 0) metrics.yield = metrics.correct / metrics.actionable;
  }
  return report;
}
