import { expect, test } from "vite-plus/test";
import { compareBudgets, measureBudgets, readBaseline } from "./budgets.ts";

test("every page load stays within its committed query, size, and scan baseline", async () => {
  const problems = compareBudgets(readBaseline(), await measureBudgets());
  expect(
    problems,
    "If the change is intended, run `pnpm run perf:baseline` and commit .tests/perf/baseline.json",
  ).toEqual([]);
});
