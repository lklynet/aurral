export type MetricKind = "time" | "size" | "memory";

const GATES: Partial<Record<MetricKind, { ratio: number; floor: number }>> = {
  size: { ratio: 1.05, floor: 5 * 1024 },
  memory: { ratio: 1.1, floor: 10 * 1024 * 1024 },
};

const lowerQuartile = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 4)]!;

export function judge(kind: MetricKind, base: number[][], head: number[][]) {
  const baseValue = lowerQuartile(base.flat());
  const headValue = lowerQuartile(head.flat());
  const gate = GATES[kind];
  const rounds = head.map((round, index) =>
    Math.sign(lowerQuartile(round) - lowerQuartile(base[index]!)),
  );
  const grew = (from: number, to: number, everyRound: boolean) =>
    gate !== undefined && to > from * gate.ratio && to - from > gate.floor && everyRound;
  const verdict = grew(
    baseValue,
    headValue,
    rounds.every((sign) => sign > 0),
  )
    ? "bigger"
    : grew(
          headValue,
          baseValue,
          rounds.every((sign) => sign < 0),
        )
      ? "smaller"
      : null;
  return { baseValue, headValue, verdict } as const;
}
