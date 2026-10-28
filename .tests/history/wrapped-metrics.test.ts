import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  calculateWrapped,
  mergeWrappedPlays,
  wrappedPeriod,
  type WrappedPlay,
} from "../../backend/services/wrapped/metrics.ts";

const period = wrappedPeriod(2026, "UTC", Date.parse("2027-01-01T00:00:00Z"));
const at = (iso: string) => Date.parse(iso);
let id = 0;
const play = (overrides: Partial<WrappedPlay>): WrappedPlay => ({
  source: "aurral",
  account: "1",
  id: String(++id),
  playedAt: at("2026-03-01T12:00:00Z"),
  title: "Song",
  artist: "Artist",
  ...overrides,
});

test("a play mirrored to a scrobbler counts once, and repeat listens still count", () => {
  const plays = [
    play({ playedAt: at("2026-03-01T12:00:00Z"), durationMs: 200_000 }),
    play({ playedAt: at("2026-03-01T12:03:20Z"), durationMs: 200_000 }),
    play({ source: "lastfm", account: "me", playedAt: at("2026-03-01T12:00:00Z") }),
    play({ source: "lastfm", account: "me", playedAt: at("2026-03-01T12:03:20Z") }),
  ];
  assert.equal(mergeWrappedPlays(plays).length, 2);
});

test("a server that stamps plays at the end still matches the scrobble stamped at the start", () => {
  const merged = mergeWrappedPlays([
    play({ source: "lastfm", account: "me", playedAt: at("2026-03-01T12:00:00Z") }),
    play({
      source: "navidrome",
      account: "me",
      playedAt: at("2026-03-01T12:05:00Z"),
      durationMs: 300_000,
      album: "Album",
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].album, "Album");
  assert.equal(merged[0].durationMs, 300_000);
});

test("the same song across sources groups together even when their MBIDs disagree", () => {
  const summary = calculateWrapped(
    [
      play({ trackMbid: "aaa", playedAt: at("2026-03-01T12:00:00Z") }),
      play({
        source: "lastfm",
        account: "me",
        trackMbid: "bbb",
        title: "song",
        playedAt: at("2026-04-01T12:00:00Z"),
      }),
    ],
    period,
  );
  assert.equal(summary.uniqueSongs, 1);
  assert.equal(summary.topSongs[0].plays, 2);
});

test("days, streaks and months follow the listener's timezone", () => {
  const newYork = wrappedPeriod(2026, "America/New_York", at("2027-01-01T05:00:00Z"));
  const summary = calculateWrapped(
    [
      play({ playedAt: at("2026-03-07T23:00:00Z") }),
      play({ playedAt: at("2026-03-08T12:00:00Z"), title: "Two" }),
      play({ playedAt: at("2026-03-09T12:00:00Z"), title: "Three" }),
      play({ playedAt: at("2027-01-01T04:30:00Z"), title: "Still 2026" }),
    ],
    newYork,
  );
  assert.equal(summary.totalPlays, 4);
  assert.deepEqual(summary.longestStreak, { days: 3, start: "2026-03-07", end: "2026-03-09" });
  assert.equal(summary.months.length, 12);
  assert.equal(summary.months[11].plays, 1);
  assert.equal(summary.hours[18], 1);
});

test("plays without a duration are estimated from the average known track length", () => {
  const summary = calculateWrapped(
    [
      play({ durationMs: 240_000 }),
      play({ playedAt: at("2026-05-01T12:00:00Z"), durationMs: 120_000, title: "Short" }),
      play({ source: "lastfm", account: "me", playedAt: at("2026-06-01T12:00:00Z") }),
    ],
    period,
  );
  assert.equal(summary.minutes, 9);
  assert.equal(summary.minutesMeasured, false);
  assert.equal(calculateWrapped([play({ source: "lastfm" })], period).minutes, null);
});

test("an empty year produces an empty recap", () => {
  const summary = calculateWrapped([], period);
  assert.equal(summary.totalPlays, 0);
  assert.equal(summary.longestStreak, null);
  assert.equal(summary.busiestDay, null);
  assert.deepEqual(summary.topSongs, []);
});

test("the calendar counts each local day and albums count the songs heard from them", () => {
  const summary = calculateWrapped(
    [
      play({ playedAt: at("2026-01-02T12:00:00Z"), album: "Record" }),
      play({ playedAt: at("2026-01-02T13:00:00Z"), album: "Record" }),
      play({ playedAt: at("2026-01-04T12:00:00Z"), title: "Other", album: "Record" }),
    ],
    wrappedPeriod(2026, "UTC", at("2026-01-05T00:00:00Z")),
  );
  assert.deepEqual(summary.calendar, [0, 2, 0, 1]);
  assert.equal(summary.topAlbums[0].songs, 2);
});
