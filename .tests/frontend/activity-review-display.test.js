import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { formatReviewReasonSummary } from "../../frontend/src/pages/activity/activityListUtils.js";

test("formatReviewReasonSummary turns blocked reason into a readable line", () => {
  assert.equal(
    formatReviewReasonSummary(
      "blocked-duration-mismatch: title=100, artist=70, album=100, actualDurationMs=207752, expectedDurationMs=282973",
    ),
    "Blocked duration mismatch · title 100 · artist 70 · album 100 · 3:28 vs 4:43",
  );
});
