import assert from "node:assert/strict";
import { test, beforeAll, afterAll, vi } from "vite-plus/test";
import express from "express";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { lidarrClient },
  { default: requestsRouter },
  { recordAlbumSearchFailed },
  { invalidateAllDownloadStatusesCache },
] = await setupIsolatedBackend(
  "activity-requests-lidarr-reads",
  "backend/config/db-sqlite.ts",
  "backend/services/lidarrClient.ts",
  "backend/routes/requests.ts",
  "backend/services/aurralHistoryService.ts",
  "backend/routes/library/handlers/downloads.ts",
);

let app;

beforeAll(async () => {
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

afterAll(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("Activity refreshes reuse recent Lidarr status and album reads", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-01T12:00:00Z") });
  const statusReads = [];
  const albumReads = [];
  const failedAt = new Date().toISOString();
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "isCircuitOpen").mockImplementation(() => false);
  vi.spyOn(lidarrClient, "getQueue").mockImplementation(async (options) => {
    if (options?.forceRefresh) statusReads.push("queue");
    return [];
  });
  vi.spyOn(lidarrClient, "getHistory").mockImplementation(async (...args) => {
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
  vi.spyOn(lidarrClient, "request").mockImplementation(
    async (endpoint, _method, _data, _skip, options) => {
      if (endpoint === "/command" && options?.forceRefresh) statusReads.push("command");
      return [];
    },
  );
  vi.spyOn(lidarrClient, "getAllAlbums").mockImplementation(async () => []);
  vi.spyOn(lidarrClient, "getAlbum").mockImplementation(async (albumId) => {
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

  vi.advanceTimersByTime(10_000);
  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.equal(statusReads.length, 6);
  assert.equal(albumReads.length, 3);

  vi.advanceTimersByTime(20_000);
  assert.deepEqual(await refresh(), ["202", "203"]);
  assert.equal(albumReads.length, 6);
});
