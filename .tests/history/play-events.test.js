import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, playEvents, scrobbleStore, honkerDbModule] = await setupIsolatedBackend(
  "play-events",
  "backend/services/playEventService.js",
  "backend/services/scrobbleConnectionStore.js",
  "backend/services/honkerDb.js",
);
const { db } = await import("../../backend/config/db-sqlite.js");

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("listener", "test");
});

test.after(async () => cleanupIsolatedState(isolatedState));

test("records local plays and aggregates artists without provider access", () => {
  const first = playEvents.recordPlayEvent(1, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
    album: "Album",
    durationMs: 180000,
    playedAt: 1700000000,
    source: "subsonic",
  });
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
});

test("pins each scrobble delivery to the connection active when the play was recorded", () => {
  const userId = db.prepare("SELECT id FROM users WHERE username = ?").get("listener").id;
  const connection = scrobbleStore.scrobbleConnectionStore.saveConnection(userId, "lastfm", {
    token: "session-token",
    displayName: "listener",
  });
  const event = playEvents.recordPlayEvent(userId, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
  });
  const row = honkerDbModule.getHonkerDb().query(
    "SELECT payload FROM _honker_live WHERE queue = ?",
    ["_outbox:play-events"],
  )[0];

  assert.equal(JSON.parse(row.payload).eventId, event.id);
  assert.equal(JSON.parse(row.payload).connectionRevision, connection.connectionRevision);
});
