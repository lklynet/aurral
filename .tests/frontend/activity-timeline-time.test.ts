import { test, afterEach } from "vite-plus/test";
import assert from "node:assert/strict";

import { formatTimelineTime } from "../../frontend/src/pages/activity/activityListUtils.ts";
import { setDateTimeFormat } from "../../frontend/src/utils/dateTime.ts";

afterEach(() => setDateTimeFormat("browser"));

test("formatTimelineTime shows nothing when there is no time", () => {
  assert.equal(formatTimelineTime(null), "");
  assert.equal(formatTimelineTime(undefined), "");
  assert.equal(formatTimelineTime("not a date"), "");
});

test("formatTimelineTime uses the selected time format", () => {
  setDateTimeFormat("day-first");
  const date = new Date(2025, 2, 4, 15, 30);
  assert.equal(formatTimelineTime(date.toISOString()), "15:30");
  assert.equal(formatTimelineTime(date.getTime()), "15:30");
});
