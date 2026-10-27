import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  calculateWrapped,
  mergeWrappedPlays,
  wrappedPeriod,
  type WrappedPlay,
} from "../../backend/services/wrapped/metrics.ts";

const at = (date: string) => Date.parse(date);
const period = wrappedPeriod(2026, "UTC", at("2027-01-01T00:00:00Z"));
const play = (overrides: Partial<WrappedPlay> = {}): WrappedPlay => ({
  source: "aurral",
  account: "1",
  id: "one",
  playedAt: at("2026-06-01T12:00:00Z"),
  title: "Song",
  artist: "Artist",
  ...overrides,
});

test("merges mirrored plays one-to-one while preserving repeat listens", () => {
  const first = play();
  const second = play({ id: "two", playedAt: first.playedAt + 1000 });
  const result = mergeWrappedPlays([
    first,
    second,
    { ...first, source: "lastfm", id: "remote-one" },
    { ...second, source: "lastfm", id: "remote-two" },
    { ...first, source: "listenbrainz", id: "another" },
    first,
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((row) => row.origins.length),
    [3, 2],
  );
});

test("matches a known start timestamp without merging different recording identities", () => {
  const first = play({
    durationMs: 180000,
    startedAt: at("2026-06-01T11:57:00Z"),
    trackMbid: "recording-a",
  });
  assert.equal(
    mergeWrappedPlays([
      first,
      play({ source: "plex", playedAt: first.startedAt!, trackMbid: "recording-a" }),
    ]).length,
    1,
  );
  assert.equal(
    mergeWrappedPlays([first, play({ source: "plex", trackMbid: "recording-b" })]).length,
    2,
  );
});

test("resolves missing IDs only when a name has one unambiguous identity", () => {
  const result = calculateWrapped(
    [
      play({ trackMbid: "recording-a", artistMbid: "artist-a" }),
      play({ id: "two", playedAt: period.start + 1000, title: " song ", artist: "ARTIST" }),
    ],
    period,
  );
  assert.equal(result.uniqueSongs, 1);
  assert.equal(result.uniqueArtists, 1);
  assert.equal(result.topSongs[0].plays, 2);
});

test("uses local calendar boundaries and counts a streak across daylight saving", () => {
  const ny = wrappedPeriod(2026, "America/New_York", at("2027-01-01T05:00:00Z"));
  assert.equal(ny.start, at("2026-01-01T05:00:00Z"));
  assert.equal(ny.end, at("2027-01-01T05:00:00Z"));
  const result = calculateWrapped(
    [
      play({ id: "excluded", playedAt: ny.start - 1 }),
      ...["2026-03-08T04:30:00Z", "2026-03-09T03:30:00Z", "2026-03-10T03:30:00Z"].map((date) =>
        play({ id: date, playedAt: at(date) }),
      ),
      play({ id: "end", playedAt: ny.end }),
    ],
    ny,
  );
  assert.equal(result.totalPlays, 3);
  assert.equal(result.longestStreak, 3);
  assert.equal(result.months[2].plays, 3);
});

test("keeps measured time separate from estimates and does not extrapolate missing durations", () => {
  const result = calculateWrapped(
    [
      play({ durationMs: 180000 }),
      play({ source: "jellyfin", id: "mirror", durationMs: 180000, listenedMs: 60000 }),
      play({ id: "two", playedAt: period.start + 1000, durationMs: 120000 }),
      play({ id: "unknown", playedAt: period.start + 2000 }),
    ],
    period,
  );
  assert.equal(result.totalPlays, 3);
  assert.deepEqual(result.listening, {
    minutes: 3,
    timedPlays: 2,
    measuredPlays: 1,
    estimated: true,
  });
});

test("ranks listened genres, filters incomplete known albums, and handles empty history", () => {
  const result = calculateWrapped(
    [
      play({ album: "Album", albumTrackCount: 10, genres: [" Rock ", "rock", "unknown"] }),
      play({
        id: "two",
        playedAt: period.start + 1000,
        title: "Other song",
        album: "Album",
        albumTrackCount: 10,
      }),
    ],
    period,
  );
  assert.equal(result.topAlbums.length, 0);
  assert.deepEqual(result.topGenres, [{ name: "rock", plays: 1 }]);
  assert.equal(result.genrePlays, 1);
  const empty = calculateWrapped([], period);
  assert.equal(empty.firstPlayedAt, null);
  assert.equal(empty.busiestDay, null);
  assert.equal(empty.listening.minutes, 0);
  assert.throws(() => wrappedPeriod(2026, "invalid/timezone"));
});
