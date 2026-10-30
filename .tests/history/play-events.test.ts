import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, playEvents, scrobbleStore, honkerDbModule] = await setupIsolatedBackend(
  "play-events",
  () => import("../../backend/services/playEventService.ts"),
  () => import("../../backend/services/scrobbleConnectionStore.ts"),
  () => import("../../backend/services/honkerDb.ts"),
);
const { db } = await import("../../backend/config/db-sqlite.ts");

beforeEach(() => {
  resetDatabase(db);
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("listener", "test");
});

afterAll(async () => cleanupIsolatedState(isolatedState));

test("records local plays and aggregates artists without provider access", () => {
  const first = playEvents.recordPlayEvent(1, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
    album: "Album",
    albumKey: "history-album",
    durationMs: 180000,
    playedAt: 1700000000,
    source: "subsonic",
  });
  assert.ok(first != null);
  playEvents.recordPlayEvent(1, {
    trackId: "song:two",
    title: "Two",
    artist: "Artist A",
    playedAt: 1700000001,
    source: "native-player",
  });

  assert.equal(first.playedAt, 1700000000000);
  assert.equal(playEvents.getPlayHistory(1).length, 2);
  assert.deepEqual(playEvents.getTopPlayedArtists(1)[0], {
    artistName: "Artist A",
    mbid: null,
    playcount: 2,
    lastPlayedAt: 1700000001000,
  });
  assert.deepEqual(
    db
      .prepare<
        unknown[],
        {
          album_key: import("../../backend/db/rows.ts").PlayAlbumStatsRow["album_key"];
          play_count: import("../../backend/db/rows.ts").PlayAlbumStatsRow["play_count"];
        }
      >("SELECT album_key, play_count FROM play_album_stats WHERE user_id = ?")
      .all(1),
    [{ album_key: "history-album", play_count: 1 }],
  );
});

test("pins each scrobble delivery to the connection active when the play was recorded", () => {
  const userId = db
    .prepare<unknown[], { id: import("../../backend/db/rows.ts").UsersRow["id"] }>(
      "SELECT id FROM users WHERE username = ?",
    )
    .get("listener")!.id;
  const connection = scrobbleStore.scrobbleConnectionStore.saveConnection(userId, "lastfm", {
    token: "session-token",
    displayName: "listener",
  });
  assert.ok(connection != null);
  const event = playEvents.recordPlayEvent(userId, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
  });
  assert.ok(event != null);
  const row = honkerDbModule
    .getHonkerDb()
    .query("SELECT payload FROM _honker_live WHERE queue = ?", ["_outbox:play-events"])[0];

  assert.equal(JSON.parse(row.payload).eventId, event.id);
  assert.equal(JSON.parse(row.payload).connectionRevision, connection.connectionRevision);
});

test("one unreadable user entry keeps every other user's scrobble connections", () => {
  const { scrobbleConnectionStore } = scrobbleStore;
  scrobbleConnectionStore.saveConnection(1, "lastfm", { token: "first-token" });
  const stored = db
    .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'scrobbleConnections'")
    .get();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'scrobbleConnections'").run(
    JSON.stringify({ ...JSON.parse(stored!.value), 2: null }),
  );

  assert.equal(scrobbleConnectionStore.getConnection(1, "lastfm")?.token, "first-token");
  scrobbleConnectionStore.saveConnection(3, "listenbrainz", { token: "third-token" });
  assert.equal(scrobbleConnectionStore.getConnection(1, "lastfm")?.token, "first-token");
  assert.equal(scrobbleConnectionStore.getConnection(3, "listenbrainz")?.token, "third-token");
});
