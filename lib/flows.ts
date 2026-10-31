export const FLOW_SOURCES = ["discover", "mix", "trending", "focus", "newReleases"] as const;

export type FlowSource = (typeof FLOW_SOURCES)[number];
export type FlowMix = Record<FlowSource, number>;

export const DEFAULT_FLOW_MIX: FlowMix = {
  discover: 34,
  mix: 33,
  trending: 33,
  focus: 0,
  newReleases: 0,
};

const shareOf = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

export const splitFlowTotal = (
  weights: Partial<Record<FlowSource, unknown>> | null | undefined,
  total: number,
): FlowMix | null => {
  const shares = FLOW_SOURCES.map((source) => shareOf(weights?.[source]));
  const sum = shares.reduce((acc, share) => acc + share, 0);
  if (sum <= 0) return null;
  const parts = shares.map((share, index) => {
    const exact = (share / sum) * total;
    return { index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = total - parts.reduce((acc, part) => acc + part.count, 0);
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break;
    part.count += 1;
    left -= 1;
  }
  const counts = { ...DEFAULT_FLOW_MIX };
  FLOW_SOURCES.forEach((source, index) => {
    counts[source] = parts[index].count;
  });
  return counts;
};

export const normalizeFlowMix = (mix: Partial<Record<FlowSource, unknown>> | null | undefined) => {
  const sum = FLOW_SOURCES.reduce((acc, source) => acc + shareOf(mix?.[source]), 0);
  if (sum <= 0) return { ...DEFAULT_FLOW_MIX };
  const percents = { ...DEFAULT_FLOW_MIX };
  for (const source of FLOW_SOURCES) {
    percents[source] = Math.round((shareOf(mix?.[source]) / sum) * 10000) / 100;
  }
  return percents;
};

export const DEFAULT_FLOW_SIZE = 30;
export const DEFAULT_SCHEDULE_TIME = "00:00";

export const normalizeTextList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

export const normalizeScheduleDays = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isFinite(day)) continue;
    const rounded = Math.round(day);
    if (rounded < 0 || rounded > 6) continue;
    out.add(rounded);
  }
  return [...out].sort((a, b) => a - b);
};

export const normalizeScheduleTime = (value: unknown) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DEFAULT_SCHEDULE_TIME;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    return DEFAULT_SCHEDULE_TIME;
  }
  return `${String(hours).padStart(2, "0")}:00`;
};

export const normalizeYearBound = (value: unknown) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const year = Math.trunc(parsed);
  if (year < 1000 || year > 9999) return null;
  return year;
};

export const normalizeYearRange = (yearFrom: unknown, yearTo: unknown) => {
  let from = normalizeYearBound(yearFrom);
  let to = normalizeYearBound(yearTo);
  if (from != null && to != null && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return { yearFrom: from, yearTo: to };
};
