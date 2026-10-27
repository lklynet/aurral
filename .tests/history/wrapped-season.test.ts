import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isWrappedPreviewBuild, wrappedSeason } from "../../lib/wrapped.ts";

test("stable Wrapped launches on December 1 and remains available until the next release", () => {
  const season = (date: string) => wrappedSeason("2.0.0", Date.parse(date));
  assert.equal(season("2026-11-30T23:59:59Z"), null);
  const first = season("2026-12-01T00:00:00Z");
  assert.deepEqual(first, {
    year: 2026,
    cutoff: Date.parse("2026-12-01T00:00:00Z"),
    expiresAt: Date.parse("2027-12-01T00:00:00Z"),
  });
  assert.deepEqual(season("2027-01-01T00:00:00Z"), first);
  assert.deepEqual(season("2027-11-30T23:59:59Z"), first);
  assert.equal(season("2027-12-01T00:00:00Z")?.year, 2027);
  assert.equal(season("2030-07-01T00:00:00Z")?.year, 2029);
});

test("nightly Wrapped launches three days early on November 28 each year", () => {
  const season = (date: string) => wrappedSeason("nightly.42+abcdef0", Date.parse(date));
  assert.equal(season("2026-11-27T23:59:59Z"), null);
  assert.deepEqual(season("2026-11-28T00:00:00Z"), {
    year: 2026,
    cutoff: Date.parse("2026-11-28T00:00:00Z"),
    expiresAt: Date.parse("2027-11-28T00:00:00Z"),
  });
  const nextRelease = Date.parse("2027-11-28T00:00:00Z");
  assert.equal(season("2027-11-27T23:59:59Z")?.year, 2026);
  assert.equal(wrappedSeason("nightly.42+abcdef0", nextRelease)?.year, 2027);
  assert.equal(wrappedSeason("2.0.0", nextRelease)?.year, 2026);
});

test("development and unknown versions follow the stable schedule", () => {
  for (const version of ["", "unknown", "abcdef0", "pr-123"]) {
    assert.equal(wrappedSeason(version, Date.parse("2026-11-30T23:59:59Z")), null);
    assert.equal(wrappedSeason(version, Date.parse("2026-12-01T00:00:00Z"))?.year, 2026);
  }
});

test("only published PR build identifiers allow the console preview", () => {
  assert.equal(isWrappedPreviewBuild("pr.1355+abcdef0"), true);
  for (const version of ["", "unknown", "2.0.0", "nightly.42+abcdef0", "pr-1355", "pr.1355"])
    assert.equal(isWrappedPreviewBuild(version), false);
});
