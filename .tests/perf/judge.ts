export type MetricKind = "time" | "size" | "memory";

const RULES: Record<MetricKind, { ratio: number; floor: number }> = {
  time: { ratio: 1.15, floor: 2 },
  size: { ratio: 1.05, floor: 5 * 1024 },
  memory: { ratio: 1.1, floor: 10 * 1024 * 1024 },
};

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function judge(kind: MetricKind, base: number[][], head: number[][]) {
  const baseMedian = median(base.flat());
  const headMedian = median(head.flat());
  const { ratio, floor } = RULES[kind];
  const changed = (from: number, to: number, everyRound: boolean) =>
    to > from * ratio && to - from > floor && everyRound;
  const rounds = head.map((round, index) => Math.sign(median(round) - median(base[index]!)));
  const verdict = changed(
    baseMedian,
    headMedian,
    rounds.every((sign) => sign > 0),
  )
    ? "slower"
    : changed(
          headMedian,
          baseMedian,
          rounds.every((sign) => sign < 0),
        )
      ? "faster"
      : "same";
  return { baseMedian, headMedian, verdict } as const;
}
