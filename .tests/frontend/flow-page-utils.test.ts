import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  FOCUS_NEEDS_SEEDS,
  buildFlowFromForm,
  describeFlowRecipe,
  flowToForm,
  formatFlowFreshness,
  formatFlowSchedule,
  formatNextRefresh,
} from "../../frontend/src/pages/playlists/flowPageUtils.ts";

const only = (source: string) => ({ mix: { [source]: 100 } });

test("the recipe line names what a flow is built from", () => {
  const cases: [Parameters<typeof describeFlowRecipe>[0], string][] = [
    [only("discover"), "Your recommendations"],
    [only("mix"), "Artists in your Library"],
    [only("newReleases"), "New releases you're missing"],
    [
      {
        ...only("focus"),
        relatedArtists: ["Aphex Twin", "A Tribe Called Quest"],
        recentListening: true,
      },
      "Similar to Aphex Twin, A Tribe Called Quest, and your recent listening",
    ],
    [{ ...only("focus"), tags: ["ambient"] }, "Your tags · ambient"],
    [
      {
        mix: { discover: 10, mix: 10, trending: 0 },
        tags: ["ambient"],
        excludeTags: ["metal", "christmas"],
        yearFrom: 2005,
        yearTo: 1990,
      },
      "Recommendations and Library · ambient · not metal, christmas · 1990 to 2005",
    ],
    [{ ...only("trending"), yearTo: 1999 }, "Trending this week · 1999 and earlier"],
  ];
  for (const [recipe, expected] of cases) assert.equal(describeFlowRecipe(recipe), expected);
});

test("the schedule reads as days and an hour", () => {
  const cases: [number[], string, string | null][] = [
    [[5], "00:00", "Fridays at 12 AM"],
    [[1, 3, 5], "07:00", "Mon, Wed, Fri at 7 AM"],
    [[0, 1, 2, 3, 4, 5, 6], "13:00", "Every day at 1 PM"],
    [[1, 2, 3, 4, 5], "12:00", "Weekdays at 12 PM"],
    [[], "07:00", null],
  ];
  for (const [days, time, expected] of cases)
    assert.equal(formatFlowSchedule(days, time), expected);
});

test("freshness counts calendar days, then falls back to a date", () => {
  const now = new Date(2026, 10, 12, 9).getTime();
  const cases: [Date, string][] = [
    [new Date(2026, 10, 12, 0, 5), "Refreshed today"],
    [new Date(2026, 10, 11, 23, 55), "Refreshed yesterday"],
    [new Date(2026, 10, 9, 12), "Refreshed Monday"],
    [new Date(2026, 10, 3, 12), "Refreshed Nov 3"],
    [new Date(2025, 11, 30, 12), "Refreshed Dec 30, 2025"],
  ];
  for (const [ran, expected] of cases)
    assert.equal(formatFlowFreshness(ran.getTime(), now), expected);
  assert.equal(formatFlowFreshness(null, now), null);
});

test("the next refresh skips today once its hour has passed", () => {
  const thursdayMorning = new Date(2026, 10, 12, 6).getTime();
  const thursdayNight = new Date(2026, 10, 12, 22).getTime();
  assert.equal(formatNextRefresh([4], "07:00", thursdayMorning), "Next refresh today at 7 AM");
  assert.equal(formatNextRefresh([4], "07:00", thursdayNight), "Next refresh Thursday at 7 AM");
  assert.equal(formatNextRefresh([5, 1], "07:00", thursdayNight), "Next refresh tomorrow at 7 AM");
});

test("skipped tags alone do not give Artists and tags anything to start from", () => {
  const draft = {
    ...flowToForm({ name: "Night Bus" }),
    counts: { discover: 0, mix: 0, trending: 0, focus: 10, newReleases: 0 },
    excludeTags: "christmas",
  };

  assert.throws(() => buildFlowFromForm(draft), { message: FOCUS_NEEDS_SEEDS });
});
