import { expect, test } from "vite-plus/test";
import { judge, type MetricKind } from "./judge.ts";

const rounds = (...values: number[]) => values.map((value) => [value, value, value]);
const KIB = 1024;
const MIB = 1024 * KIB;

test.each<[string, MetricKind, number[][], number[][], string | null]>([
  ["a doubled time", "time", rounds(21, 22), rounds(42, 44), null],
  ["a few MiB of memory", "memory", rounds(176 * MIB), rounds(180 * MIB), null],
  ["a heavy new startup cost", "memory", rounds(176 * MIB), rounds(215 * MIB), "bigger"],
  [
    "memory that fell in one round",
    "memory",
    rounds(176 * MIB, 210 * MIB),
    rounds(200 * MIB, 209 * MIB),
    null,
  ],
  ["a few KiB of bundle", "size", rounds(300 * KIB), rounds(303 * KIB), null],
  ["a heavy new import", "size", rounds(300 * KIB), rounds(330 * KIB), "bigger"],
  ["a dropped dependency", "size", rounds(330 * KIB), rounds(300 * KIB), "smaller"],
])("%s", (_, kind, base, head, verdict) => {
  expect(judge(kind, base, head).verdict).toBe(verdict);
});
