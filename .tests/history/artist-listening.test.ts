import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { getArtistListening }] = await setupIsolatedBackend(
  "artist-listening",
  () => import("../../backend/services/artistListening.ts"),
);
const { db } = await import("../../backend/config/db-sqlite.ts");

const MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const NOW = Date.UTC(2026, 10, 11);
const WEEK = 7 * 86_400_000;

const insert = db.prepare(
  `INSERT INTO play_events (user_id, track_id, title, artist, album, artist_mbid, duration_ms, played_at, source, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 200000, ?, 'native-player', 0)`,
);
let userId = 0;
const play = (
  title: string,
  playedAt: number,
  { artist = "Radiohead", mbid = MBID as string | null, album = "In Rainbows" } = {},
) => insert.run(userId, title, title, artist, album, mbid, playedAt);

beforeEach(() => {
  resetDatabase(db);
  userId = Number(
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("listener", "test")
      .lastInsertRowid,
  );
});

afterAll(async () => cleanupIsolatedState(isolatedState));

test("summarizes a user's plays of one artist by week, rank, and top tracks", () => {
  for (let index = 0; index < 6; index += 1) play("Nude", NOW - WEEK / 2 - index);
  for (let index = 0; index < 3; index += 1) play("Reckoner", NOW - 3.5 * WEEK - index);
  play("reckoner", NOW - 60 * WEEK, { artist: "RADIOHEAD", mbid: null });
  play("Creep", NOW - 2.5 * WEEK, { album: "Pablo Honey" });
  play("Creep", NOW, { mbid: "00000000-0000-4000-8000-000000000000" });
  for (let index = 0; index < 20; index += 1) play("Song", NOW - index, { artist: "Busier" });

  const listening = getArtistListening(userId, MBID, "Radiohead", NOW);

  assert.ok(listening);
  assert.equal(listening.plays, 11);
  assert.equal(listening.durationMs, 11 * 200000);
  assert.equal(listening.firstPlayedAt, NOW - 60 * WEEK);
  assert.equal(listening.rank, 2);
  assert.equal(listening.weeks.length, 52);
  assert.equal(listening.weeks[51], 6);
  assert.equal(listening.weeks[49], 1);
  assert.equal(listening.weeks[48], 3);
  assert.deepEqual(
    listening.topTracks.map(({ title, plays, queueTrack }) => [title, plays, queueTrack]),
    [
      ["Nude", 6, null],
      ["Reckoner", 4, null],
      ["Creep", 1, null],
    ],
  );
});

test("stays hidden under 10 plays and drops a rank past 20", () => {
  for (let index = 0; index < 9; index += 1) play("Nude", NOW - index);
  assert.equal(getArtistListening(userId, MBID, "Radiohead", NOW), null);

  play("Nude", NOW - 10);
  for (let artist = 0; artist < 20; artist += 1) {
    for (let index = 0; index < 11; index += 1)
      play("Song", NOW - index, { artist: `Artist ${artist}` });
  }
  assert.equal(getArtistListening(userId, MBID, "Radiohead", NOW)?.rank, null);
});
