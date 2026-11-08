import { expect, test } from "vite-plus/test";
import { judge, type MetricKind } from "./judge.ts";

const rounds = (...medians: number[]) => medians.map((median) => [median - 1, median, median + 1]);
const KIB = 1024;

test.each<[string, MetricKind, number[][], number[][], string]>([
  ["noise", "time", rounds(21, 22), rounds(23, 22), "same"],
  ["a steady slowdown", "time", rounds(21, 22), rounds(28, 29), "slower"],
  ["one noisy round", "time", rounds(21, 31), rounds(31, 30), "same"],
  ["a big ratio under the floor", "time", rounds(2, 2), rounds(3.5, 3.5), "same"],
  ["a steady speedup", "time", rounds(41, 42), rounds(21, 22), "faster"],
  ["a few KiB of bundle", "size", rounds(300 * KIB), rounds(303 * KIB), "same"],
  ["a heavy new import", "size", rounds(300 * KIB), rounds(330 * KIB), "slower"],
])("%s", (_, kind, base, head, verdict) => {
  expect(judge(kind, base, head).verdict).toBe(verdict);
});
