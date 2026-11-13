export type MetricKind = "time" | "size" | "memory";

const RULES: Record<MetricKind, { ratio: number; floor: number }> = {
  time: { ratio: 1.15, floor: 2 },
  size: { ratio: 1.05, floor: 5 * 1024 },
  memory: { ratio: 1.1, floor: 10 * 1024 * 1024 },
};

const lowerQuartile = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 4)]!;

export function judge(kind: MetricKind, base: number[][], head: number[][]) {
  const baseValue = lowerQuartile(base.flat());
  const headValue = lowerQuartile(head.flat());
  const { ratio, floor } = RULES[kind];
  const changed = (from: number, to: number, everyRound: boolean) =>
    to > from * ratio && to - from > floor && everyRound;
  const rounds = head.map((round, index) =>
    Math.sign(lowerQuartile(round) - lowerQuartile(base[index]!)),
  );
  const verdict = changed(
    baseValue,
    headValue,
    rounds.every((sign) => sign > 0),
  )
    ? "slower"
    : changed(
          headValue,
          baseValue,
          rounds.every((sign) => sign < 0),
        )
      ? "faster"
      : "same";
  return { baseValue, headValue, verdict } as const;
}
