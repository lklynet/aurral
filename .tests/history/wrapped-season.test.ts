import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isWrappedPreviewBuild, wrappedSeason } from "../../lib/wrapped.ts";

test("stable Wrapped opens on December 1 and closes after December 31", () => {
  assert.equal(wrappedSeason("2.0.0", Date.parse("2026-11-30T23:59:59Z")), null);
  assert.deepEqual(wrappedSeason("2.0.0", Date.parse("2026-12-01T00:00:00Z")), {
    year: 2026,
    cutoff: Date.parse("2026-12-01T00:00:00Z"),
    preview: false,
  });
  assert.equal(wrappedSeason("2.0.0", Date.parse("2026-12-31T23:59:59Z"))?.year, 2026);
  assert.equal(wrappedSeason("2.0.0", Date.parse("2027-01-01T00:00:00Z")), null);
  assert.equal(wrappedSeason("2.0.0", Date.parse("2027-12-01T00:00:00Z"))?.year, 2027);
});

test("nightly Wrapped opens three days early on November 28", () => {
  const nightly = "nightly.512+abc1234";
  assert.equal(wrappedSeason(nightly, Date.parse("2026-11-27T23:59:59Z")), null);
  assert.equal(
    wrappedSeason(nightly, Date.parse("2026-11-28T00:00:00Z"))?.cutoff,
    Date.parse("2026-11-28T00:00:00Z"),
  );
  assert.equal(wrappedSeason(nightly, Date.parse("2027-01-01T00:00:00Z")), null);
});

test("PR preview images open a year-to-date Wrapped at any time", () => {
  const now = Date.parse("2026-10-27T15:00:00Z");
  assert.deepEqual(wrappedSeason("pr.1355+7fa28b6", now), {
    year: 2026,
    cutoff: now,
    preview: true,
  });
  assert.equal(isWrappedPreviewBuild("pr.1355+7fa28b6"), true);
  assert.equal(isWrappedPreviewBuild("pr.1355"), false);
  assert.equal(isWrappedPreviewBuild("dev"), false);
  assert.equal(wrappedSeason("dev", now), null);
});
