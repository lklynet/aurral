import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatTime,
  setDateTimeFormat,
} from "../../frontend/src/utils/dateTime.js";
import { getReleaseMetric } from "../../frontend/src/pages/ArtistDetails/utils.js";

test("formats dates in the selected international order", () => {
  const date = new Date(2026, 7, 9, 14, 5);

  setDateTimeFormat("day-first");
  assert.equal(formatDateTime(date), "14:05 09/08/2026");
  assert.equal(
    formatDateTime(date, { month: "short", day: "numeric", hour: "numeric" }),
    "14:05 09/08/2026",
  );
  assert.equal(formatTime(date, { hour: "numeric", minute: "2-digit" }), "14:05");

  setDateTimeFormat("year-first");
  assert.equal(formatDateTime(date), "2026/08/09 14:05");
  assert.equal(formatDate(date, { month: "numeric", day: "numeric" }), "2026/08/09");

  setDateTimeFormat("browser");
});

test("describes recent moments relative to now", () => {
  const now = new Date(2026, 9, 9, 15, 0);
  const ago = (ms) => new Date(now.getTime() - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  assert.equal(formatRelativeTime(ago(10_000), { now }), "now");
  assert.equal(formatRelativeTime(ago(5 * minute), { now }), "5 minutes ago");
  assert.equal(formatRelativeTime(ago(3 * hour), { now }), "3 hours ago");
  assert.equal(formatRelativeTime(ago(26 * hour), { now }), "yesterday");
  assert.equal(formatRelativeTime(ago(3 * day), { now }), "3 days ago");
  assert.equal(formatRelativeTime(ago(15 * day), { now }), "2 weeks ago");
  assert.equal(formatRelativeTime(ago(95 * day), { now }), "3 months ago");
  assert.equal(formatRelativeTime(ago(800 * day), { now }), "2 years ago");
  assert.equal(formatRelativeTime(new Date(now.getTime() + 2 * day), { now }), "in 2 days");
  assert.equal(formatRelativeTime(new Date("not a date"), { now }), "");
});

test("counts calendar days when the hour does not matter", () => {
  const justAfterMidnight = new Date(2026, 9, 9, 0, 30);

  assert.equal(
    formatRelativeTime(new Date(2026, 9, 9, 0, 5), { now: justAfterMidnight, unit: "day" }),
    "today",
  );
  assert.equal(
    formatRelativeTime(new Date(2026, 9, 8, 23, 50), { now: justAfterMidnight, unit: "day" }),
    "yesterday",
  );
  assert.equal(
    formatRelativeTime(new Date(2026, 9, 5, 21, 6), { now: justAfterMidnight, unit: "day" }),
    "4 days ago",
  );
});

test("release listener counts read compactly with the full count kept for the tooltip", () => {
  const metric = getReleaseMetric({ fans: 1_234_567 });

  assert.equal(metric.label, "1.2M");
  assert.equal(metric.title, "1,234,567 listeners");
  assert.equal(getReleaseMetric({ fans: 950 }).label, "950");
  assert.equal(getReleaseMetric({ fans: 0 }).label, "");
});
