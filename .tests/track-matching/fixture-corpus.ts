import { readFileSync } from "node:fs";

export type FixtureMetadata = {
  title: string;
  artist: string;
  duration_ms: number;
  recording_mbid?: string;
};

export type FixtureFile = {
  key: string;
  path: string;
  duration_ms: number;
};

export type Fixture = {
  id: string;
  flow: string;
  actionable: boolean;
  correctIds: string[];
  contradictedIds: string[];
  identities: string[];
  provenance: { source: string; license: string };
  input: {
    expected?: { metadata: FixtureMetadata };
    target_recording_mbid?: string;
    release_mbids?: string[];
    observed?: { title: string; artists: string[]; duration_ms: number; recording_mbid?: string };
    folders?: { key: string; files: FixtureFile[] }[];
    candidates?: (FixtureFile | { key: string; metadata: FixtureMetadata })[];
  };
};

type FixtureDecision = Pick<Fixture, "flow" | "actionable" | "correctIds" | "contradictedIds">;
type Metrics = {
  total: number;
  actionable: number;
  correct: number;
  wrong: number;
  contradictionAcceptances: number;
  abstentions: number;
  yield: number | null;
};

const SPLITS = new Set(["development", "acceptance"]);

export function loadFixtureSet(split: string) {
  if (!SPLITS.has(split)) throw new Error(`Unknown fixture split: ${split}`);
  const file = new URL(`./fixtures/${split}.jsonl`, import.meta.url);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line): Fixture => JSON.parse(line));
}

export function measureFixtureDecisions<T extends FixtureDecision>(
  cases: T[],
  decide: (item: T) => string | null | undefined,
) {
  const report: Record<string, Metrics> = {};
  for (const item of cases) {
    const metrics = (report[item.flow] ||= {
      total: 0,
      actionable: 0,
      correct: 0,
      wrong: 0,
      contradictionAcceptances: 0,
      abstentions: 0,
      yield: null,
    });
    metrics.total += 1;
    if (item.actionable) metrics.actionable += 1;
    const selected = decide(item);
    if (selected == null) metrics.abstentions += 1;
    else if (item.correctIds.includes(selected)) metrics.correct += 1;
    else metrics.wrong += 1;
    if (selected != null && item.contradictedIds.includes(selected))
      metrics.contradictionAcceptances += 1;
  }
  for (const metrics of Object.values(report)) {
    if (metrics.actionable > 0) metrics.yield = metrics.correct / metrics.actionable;
  }
  return report;
}
