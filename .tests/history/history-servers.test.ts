import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";

const [state, { db }, { userOps }, servers, { getPlayHistory }, plex] = await setupIsolatedBackend(
  "history-servers",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/historyServers.ts"),
  () => import("../../backend/services/playEventService.ts"),
  () => import("../../backend/services/plex.ts"),
);

const originalFetch = globalThis.fetch;
const DAY = 24 * 60 * 60;
let userId: number;

beforeEach(async () => {
  resetDatabase(db);
  userId = userOps.createUser("listener", "hash")!.id;
  const discovery = await import("../../backend/services/discovery/index.ts");
  vi.spyOn(discovery, "requestUserDiscoveryRefresh").mockReturnValue({
    enqueued: false,
    reason: "test",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const importedPlays = () =>
  db
    .prepare<[number], { title: string; source: string; track_id: string; played_at: number }>(
      "SELECT title, source, track_id, played_at FROM play_events WHERE user_id = ? ORDER BY played_at",
    )
    .all(userId);

test("Navidrome plays import once, stay out of the app's play list, and leave on disconnect", async () => {
  const now = Math.floor(Date.now() / 1000);
  const navidrome = createFakeNavidrome({
    songs: [{ id: "song-1", title: "Roygbiv", artist: "Boards of Canada", duration: 151 }],
    scrobbles: [
      { id: 1, mediaFileId: "song-1", submissionTime: now - 2 * DAY },
      { id: 2, mediaFileId: "song-1", submissionTime: now - DAY / 2 },
    ],
  });
  globalThis.fetch = navidrome.fetch;
  const connection = { url: "http://navidrome.test", username: "listener", secret: "wrong" };

  await assert.rejects(
    servers.connectHistoryServer(userId, "navidrome", connection),
    servers.HistoryServerError,
  );
  await servers.connectHistoryServer(userId, "navidrome", { ...connection, secret: "password" });
  assert.deepEqual(await servers.syncHistoryServer(userId, "navidrome"), { imported: 2 });
  assert.deepEqual(await servers.syncHistoryServer(userId, "navidrome"), { imported: 0 });

  assert.deepEqual(
    importedPlays().map((play) => [play.title, play.source, play.track_id]),
    [
      ["Roygbiv", "navidrome", "navidrome:song-1"],
      ["Roygbiv", "navidrome", "navidrome:song-1"],
    ],
  );
  assert.deepEqual(getPlayHistory(userId), []);
  assert.equal(servers.listHistoryServers(userId)[0]?.plays, 2);

  await servers.disconnectHistoryServer(userId, "navidrome");
  assert.deepEqual(importedPlays(), []);
  assert.deepEqual(servers.listHistoryServers(userId), []);
});

test("Jellyfin play times convert from the server's local clock on their own date", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    const body = (value: unknown) => Response.json(value);
    if (url.pathname === "/Users") return body([{ Name: "Listener", Id: "user-1" }]);
    if (url.pathname === "/Items") {
      return body({
        Items: [{ Id: "song", Name: "Song", Artists: ["Artist"], RunTimeTicks: 1_800_000_000 }],
      });
    }
    const sql = String(JSON.parse(String(init?.body)).CustomQueryString);
    if (sql.includes("localtime")) return body({ results: [["-18000"]] });
    return body({
      results: [
        ["2026-01-01 07:00:00.1234567", "song", "1767268800"],
        ["2026-07-01 08:00:00.1234567", "song", "1782907200"],
      ],
    });
  };

  await servers.connectHistoryServer(userId, "jellyfin", {
    url: "http://jellyfin.test",
    username: "listener",
    secret: "key",
  });
  await servers.syncHistoryServer(userId, "jellyfin");

  assert.deepEqual(
    importedPlays().map((play) => play.played_at),
    [Date.parse("2026-01-01T12:00:00Z"), Date.parse("2026-07-01T12:00:00Z")],
  );
  assert.ok(requests.includes("/user_usage_stats/submit_custom_query"));
});

test("a Jellyfin server without Playback Reporting says so and keeps the error visible", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/Users") return Response.json([{ Name: "listener", Id: "user-1" }]);
    return new Response("Not found", { status: 404 });
  };

  await assert.rejects(
    servers.connectHistoryServer(userId, "jellyfin", {
      url: "http://jellyfin.test",
      username: "listener",
      secret: "key",
    }),
    /Install the Playback Reporting plugin/,
  );
});

test("Plex imports only the signed-in account's tracks, using the server owner's token", async () => {
  const seen: (string | null)[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(
      `${new Headers(init?.headers).get("x-plex-token")} ${url.searchParams.get("accountID")}`,
    );
    if (url.searchParams.has("type")) return Response.json({ MediaContainer: { size: 0 } });
    return Response.json({
      MediaContainer: {
        size: 2,
        Metadata: [
          {
            type: "track",
            historyKey: "/status/sessions/history/9",
            ratingKey: "42",
            viewedAt: 1_767_268_800,
            title: "Song",
            grandparentTitle: "Artist",
            parentTitle: "Album",
          },
          { type: "episode", historyKey: "/status/sessions/history/10", title: "Podcast" },
        ],
      },
    });
  };

  plex.savePlexServer({ url: "http://plex.test", token: "owner-token", sendPlaylists: false });
  await servers.connectPlexHistory(userId, {
    url: "http://plex.test",
    username: "listener",
    accountId: "7",
  });
  await servers.syncHistoryServer(userId, "plex");

  assert.deepEqual(seen, ["owner-token 7"]);
  assert.deepEqual(
    importedPlays().map((play) => [play.title, play.track_id, play.played_at]),
    [["Song", "plex:42", 1_767_268_800_000]],
  );
});

test("a Plex reply without history fails the sync instead of skipping it", async () => {
  globalThis.fetch = async () => Response.json({});
  plex.savePlexServer({ url: "http://plex.test", token: "owner-token", sendPlaylists: false });
  await servers.connectPlexHistory(userId, {
    url: "http://plex.test",
    username: "owner",
    accountId: "1",
  });

  await assert.rejects(servers.syncHistoryServer(userId, "plex"));
});

test("Plex history says so when the server is disconnected", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "owner-token", sendPlaylists: false });
  await servers.connectPlexHistory(userId, {
    url: "http://plex.test",
    username: "owner",
    accountId: "1",
  });
  plex.removePlexServer();

  await assert.rejects(servers.syncHistoryServer(userId, "plex"), /Plex isn't connected/);
});

test("connecting another account replaces the previous account's plays", async () => {
  const now = Math.floor(Date.now() / 1000);
  const navidrome = createFakeNavidrome({
    songs: [{ id: "song-1", title: "Roygbiv", artist: "Boards of Canada" }],
    scrobbles: [{ id: 1, mediaFileId: "song-1", submissionTime: now - 30 * DAY }],
  });
  globalThis.fetch = navidrome.fetch;
  const connection = { url: "http://navidrome.test", username: "first", secret: "password" };
  await servers.connectHistoryServer(userId, "navidrome", connection);
  await servers.syncHistoryServer(userId, "navidrome");

  await servers.connectHistoryServer(userId, "navidrome", { ...connection, username: "second" });
  assert.deepEqual(importedPlays(), []);
  assert.deepEqual(await servers.syncHistoryServer(userId, "navidrome"), { imported: 1 });
});

test("a disconnect during an import keeps the imported plays removed", async () => {
  const now = Math.floor(Date.now() / 1000);
  const navidrome = createFakeNavidrome({
    songs: [{ id: "song-1", title: "Roygbiv", artist: "Boards of Canada" }],
    scrobbles: [{ id: 1, mediaFileId: "song-1", submissionTime: now - DAY }],
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/song") await servers.disconnectHistoryServer(userId, "navidrome");
    return navidrome.fetch(input, init);
  };
  await servers.connectHistoryServer(userId, "navidrome", {
    url: "http://navidrome.test",
    username: "listener",
    secret: "password",
  });

  assert.deepEqual(await servers.syncHistoryServer(userId, "navidrome"), { imported: 0 });
  assert.deepEqual(importedPlays(), []);
  assert.deepEqual(servers.listHistoryServers(userId), []);
});
