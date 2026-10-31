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

export const normalizeFlowMix = (mix: Partial<Record<FlowSource, unknown>> | null | undefined) =>
  splitFlowTotal(mix, 100) ?? { ...DEFAULT_FLOW_MIX };
