import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { lidarrClient },
  { default: requestsRouter },
  { recordAlbumSearchFailed },
  { invalidateAllDownloadStatusesCache },
] = await setupIsolatedBackend(
  "activity-requests-lidarr-reads",
  "backend/config/db-sqlite.js",
  "backend/services/lidarrClient.js",
  "backend/routes/requests.js",
  "backend/services/aurralHistoryService.js",
  "backend/routes/library/handlers/downloads.js",
);

let app;

test.before(async () => {
  resetDatabase(db);
  const expressApp = express();
  expressApp.use((req, _res, next) => {
    req.user = { id: 1, username: "admin", role: "admin", permissions: {} };
    next();
  });
  expressApp.use("/api/requests", requestsRouter);
  await new Promise((resolve) => {
    const server = expressApp.listen(0, "127.0.0.1", () => {
      app = { url: `http://127.0.0.1:${server.address().port}`, server };
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("Activity refreshes reuse recent Lidarr status and album reads", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T12:00:00Z") });
  const statusReads = [];
  const albumReads = [];
  const failedAt = new Date().toISOString();
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "isCircuitOpen", () => false);
  t.mock.method(lidarrClient, "getQueue", async (options) => {
    if (options?.forceRefresh) statusReads.push("queue");
    return [];
  });
  t.mock.method(lidarrClient, "getHistory", async (...args) => {
    if (args[4]?.forceRefresh) statusReads.push("history");
    return {
      records: [201, 202, 203].map((albumId) => ({
        id: albumId,
        albumId,
        eventType: "downloadFailed",
        date: failedAt,
        album: { title: `Album ${albumId}` },
      })),
    };
  });
  t.mock.method(lidarrClient, "request", async (endpoint, _method, _data, _skip, options) => {
    if (endpoint === "/command" && options?.forceRefresh) statusReads.push("command");
    return [];
  });
  t.mock.method(lidarrClient, "getAllAlbums", async () => []);
  t.mock.method(lidarrClient, "getAlbum", async (albumId) => {
    albumReads.push(String(albumId));
    if (String(albumId) === "203") throw new Error("Lidarr album not found");
    return {
      id: Number(albumId),
      statistics: { trackFileCount: String(albumId) === "201" ? 2 : 0 },
    };
  });
  recordAlbumSearchFailed({ albumId: "202", albumName: "Album 202", artistName: "Artist" });
  invalidateAllDownloadStatusesCache();

  const refresh = async () => {
    const response = await fetch(`${app.url}/api/requests?refresh=1`);
    assert.equal(response.status, 200);
    return (await response.json())
      .filter((request) => request.status === "failed")
      .map((request) => request.albumId)
      .sort();
  };

  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.equal(statusReads.length, 3);
  assert.deepEqual(albumReads.sort(), ["201", "202", "203"]);

  t.mock.timers.tick(10_000);
  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.equal(statusReads.length, 6);
  assert.equal(albumReads.length, 3);

  t.mock.timers.tick(20_000);
  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.equal(albumReads.length, 6);
});
