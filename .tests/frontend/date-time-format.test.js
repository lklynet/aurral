import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  formatDateTime,
  formatTime,
  setDateTimeFormat,
} from "../../frontend/src/utils/dateTime.js";

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
