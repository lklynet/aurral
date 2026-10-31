import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeFlowMix, splitFlowTotal } from "../../lib/flows.ts";

test("saved source counts read back the same, including a one-track source", () => {
  const cases = [
    { discover: 100, mix: 0, trending: 100, focus: 1, newReleases: 0 },
    { discover: 7, mix: 2, trending: 0, focus: 1, newReleases: 0 },
    { discover: 20, mix: 0, trending: 0, focus: 10, newReleases: 0 },
  ];
  for (const counts of cases) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    assert.deepEqual(splitFlowTotal(normalizeFlowMix(counts), total), counts);
  }
});
