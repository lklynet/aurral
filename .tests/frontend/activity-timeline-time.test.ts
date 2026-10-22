import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { formatTimelineTime } from "../../frontend/src/pages/activity/activityListUtils.ts";

test("formatTimelineTime shows nothing when there is no time", () => {
  assert.equal(formatTimelineTime(null), "");
  assert.equal(formatTimelineTime(undefined), "");
  assert.equal(formatTimelineTime("not a date"), "");
});

test("formatTimelineTime formats a real time", () => {
  assert.notEqual(formatTimelineTime("2025-03-04T15:30:00.000Z"), "");
});
