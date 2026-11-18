import assert from "node:assert/strict";
import * as v from "valibot";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const [isolatedState, playEvents, scrobbleStore] = await setupIsolatedBackend(
  "play-events",
  () => import("../../backend/services/playEventService.ts"),
  () => import("../../backend/services/scrobbleConnectionStore.ts"),
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
  const connection = scrobbleStore.scrobbleConnectionStore.saveConnection(userId, "listenbrainz", {
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
  const row = requireFixture(
    db
      .prepare<[], { payload: string }>("SELECT payload FROM jobs WHERE queue = 'play-events'")
      .get(),
  );

  assert.equal(JSON.parse(row.payload).eventId, event.id);
  assert.equal(JSON.parse(row.payload).connectionRevision, connection.connectionRevision);
});

test("one unreadable user entry keeps every other user's scrobble connections", () => {
  const { scrobbleConnectionStore } = scrobbleStore;
  scrobbleConnectionStore.saveConnection(1, "koito", {
    token: "first-token",
    baseUrl: "https://koito.example",
  });
  const stored = db
    .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'scrobbleConnections'")
    .get();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'scrobbleConnections'").run(
    JSON.stringify({ ...JSON.parse(stored!.value), 2: null }),
  );

  assert.equal(scrobbleConnectionStore.getConnection(1, "koito")?.token, "first-token");
  scrobbleConnectionStore.saveConnection(3, "listenbrainz", { token: "third-token" });
  assert.equal(scrobbleConnectionStore.getConnection(1, "koito")?.token, "first-token");
  assert.equal(scrobbleConnectionStore.getConnection(3, "listenbrainz")?.token, "third-token");
});

test("now playing reaches a linked scrobbler without recording a play", async (t: import("vite-plus/test").TestContext) => {
  const originalFetch = globalThis.fetch;
  const bodies = new Map<string, string>();
  globalThis.fetch = async (url, options) => {
    bodies.set(new URL(String(url)).host, String(options?.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const { scrobbleConnectionStore } = scrobbleStore;
  scrobbleConnectionStore.saveConnection(1, "listenbrainz", { token: "listenbrainz-token" });

  await playEvents.sendNowPlaying(1, { trackId: "song:one", title: "One", artist: "Artist A" });

  const listenbrainz = v.parse(
    v.object({ listen_type: v.string(), payload: v.array(v.looseObject({})) }),
    JSON.parse(requireFixture(bodies.get("api.listenbrainz.org"))),
  );
  assert.equal(listenbrainz.listen_type, "playing_now");
  assert.equal("listened_at" in requireFixture(listenbrainz.payload[0]), false);
  assert.equal(playEvents.getPlayHistory(1).length, 0);
  assert.equal(
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM jobs").get()?.count,
    0,
  );
});

test("a scrobble shows as now playing only when the app never said what is playing", async () => {
  const NOW = Date.UTC(2026, 10, 5, 12);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const userId = Number(
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("phone", "test")
      .lastInsertRowid,
  );
  const { localNowPlaying } = await import("../../backend/services/localNowPlaying.ts");
  const scrobble = (title: string, playedAt: number) =>
    playEvents.showScrobbleAsNowPlaying(
      userId,
      requireFixture(
        playEvents.recordPlayEvent(userId, {
          trackId: `song:${title}`,
          title,
          artist: "Radiohead",
          durationMs: 60_000,
          playedAt,
          source: "subsonic",
        }),
      ),
      null,
    );
  const nowPlaying = () => localNowPlaying(userId)?.title ?? null;

  scrobble("Airbag", NOW - 61_000);
  assert.equal(nowPlaying(), null);
  scrobble("Nude", NOW);
  assert.equal(nowPlaying(), "Nude");
  scrobble("Reckoner", NOW);
  assert.equal(nowPlaying(), "Reckoner");
  await playEvents.sendNowPlaying(userId, { title: "Lucky", artist: "Radiohead" });
  scrobble("Reckoner", NOW);
  assert.equal(nowPlaying(), "Lucky");
});

test("a Koito connection without a server URL is not connected, so its plays never reach the public ListenBrainz", () => {
  const { scrobbleConnectionStore } = scrobbleStore;
  for (const baseUrl of [null, "invalid", "ftp://koito.local"]) {
    scrobbleConnectionStore.saveConnection(1, "koito", { token: "koito-token", baseUrl });

    assert.equal(scrobbleConnectionStore.getConnection(1, "koito"), null);
    assert.deepEqual(scrobbleConnectionStore.getConnections(1), {});
    assert.equal(scrobbleConnectionStore.getPublicStatus(1).koito.connected, false);
  }
  scrobbleConnectionStore.saveConnection(1, "koito", {
    token: "koito-token",
    baseUrl: "http://koito.local:4110",
  });
  assert.equal(
    scrobbleConnectionStore.getConnection(1, "koito")?.baseUrl,
    "http://koito.local:4110",
  );
});
