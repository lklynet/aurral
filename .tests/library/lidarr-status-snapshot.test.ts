import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test, vi } from "vite-plus/test";

import {
  getDownloadStatusesForAlbumIds,
  getLidarrStatusSnapshot,
  hasActiveLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "../../backend/routes/library/handlers/downloads.ts";
import { LidarrClient, lidarrClient } from "../../backend/services/lidarrClient.ts";
import { buildLidarrRequests } from "../../backend/services/lidarrRequestBuilder.ts";

test("disabled status reads stay local", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => false);
  vi.spyOn(lidarrClient, "isCircuitOpen").mockImplementation(() => false);
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("disabled status reads must not call Lidarr");
  });
  invalidateAllDownloadStatusesCache();

  assert.deepEqual(await getDownloadStatusesForAlbumIds([10]), {});
  const snapshot = await getLidarrStatusSnapshot({ refresh: true });
  assert.deepEqual(snapshot.provider, {
    queue: [],
    history: { records: [] },
    commands: [],
  });
  assert.deepEqual(snapshot.statuses, {});
  assert.equal(request.mock.calls.length, 0);
});

test("Lidarr status consumers share refreshes, idle, failure, and recovery state", async () => {
  let active = false;
  let fail = false;
  let queueGate: PromiseWithResolvers<void> | null = null;
  let albumCalls = 0;
  const calls = { queue: 0, history: 0, command: 0 };
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "isCircuitOpen").mockImplementation(() => false);
  vi.spyOn(lidarrClient, "getQueue").mockImplementation(async (options) => {
    assert.equal(options?.forceRefresh, true);
    calls.queue += 1;
    if (fail) throw new Error("provider unavailable");
    if (queueGate) await queueGate.promise;
    return active ? [{ id: 1, albumId: 10, status: "downloading", size: 10, sizeleft: 5 }] : [];
  });
  vi.spyOn(lidarrClient, "getHistory").mockImplementation(async (...args) => {
    assert.deepEqual(args, [1, 200, "date", "descending", { forceRefresh: true }]);
    calls.history += 1;
    if (fail) throw new Error("provider unavailable");
    return { records: [] };
  });
  vi.spyOn(lidarrClient, "getCommands").mockImplementation(async (options) => {
    assert.equal(options?.forceRefresh, true);
    calls.command += 1;
    if (fail) throw new Error("provider unavailable");
    return [];
  });
  vi.spyOn(lidarrClient, "getAllAlbums").mockImplementation(async () => {
    albumCalls += 1;
    return [];
  });

  invalidateAllDownloadStatusesCache();
  const [first, concurrent] = await Promise.all([
    getLidarrStatusSnapshot({ refresh: true }),
    getLidarrStatusSnapshot({ refresh: true }),
  ]);
  assert.deepEqual(calls, { queue: 1, history: 1, command: 1 });
  assert.equal(albumCalls, 0);
  assert.equal(first, concurrent);
  assert.equal(first.active, false);
  assert.equal((await getLidarrStatusSnapshot()).updatedAt, first.updatedAt);
  assert.deepEqual(calls, { queue: 1, history: 1, command: 1 });

  active = true;
  invalidateAllDownloadStatusesCache();
  const activeSnapshot = await getLidarrStatusSnapshot();
  assert.equal(activeSnapshot.active, true);
  assert.equal(hasActiveLidarrStatusSnapshot(), true);
  assert.equal(activeSnapshot.statuses[10].status, "downloading");
  assert.deepEqual(calls, { queue: 2, history: 2, command: 2 });

  const requests = await buildLidarrRequests(lidarrClient, activeSnapshot.provider);
  assert.equal(requests[0].albumId, "10");
  assert.deepEqual(calls, { queue: 2, history: 2, command: 2 });

  fail = true;
  invalidateAllDownloadStatusesCache();
  const stale = await getLidarrStatusSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.statuses[10].status, "downloading");
  assert.match(requireFixture(stale.error), /provider unavailable/);
  assert.equal((await getLidarrStatusSnapshot()).stale, true);
  assert.deepEqual(calls, { queue: 3, history: 3, command: 3 });

  fail = false;
  active = false;
  invalidateAllDownloadStatusesCache();
  const recovered = await getLidarrStatusSnapshot({ refresh: true });
  assert.equal(recovered.stale, false);
  assert.equal(recovered.active, false);
  assert.deepEqual(calls, { queue: 4, history: 4, command: 4 });

  queueGate = Promise.withResolvers<void>();
  invalidateAllDownloadStatusesCache();
  const pending = getLidarrStatusSnapshot({ refresh: true });
  while (calls.queue < 5) await new Promise<void>((resolve) => setImmediate(resolve));
  invalidateAllDownloadStatusesCache();
  queueGate.resolve();
  await pending;
  queueGate = null;
  await getLidarrStatusSnapshot();
  assert.deepEqual(calls, { queue: 6, history: 6, command: 6 });
});

test("invalidating a failed refresh allows immediate recovery", async () => {
  let fail = false;
  let refreshGate: PromiseWithResolvers<void> | null = null;
  const calls = { queue: 0, history: 0, command: 0 };
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "isCircuitOpen").mockImplementation(() => false);
  vi.spyOn(lidarrClient, "getQueue").mockImplementation(async () => {
    calls.queue += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return [];
  });
  vi.spyOn(lidarrClient, "getHistory").mockImplementation(async () => {
    calls.history += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return { records: [] };
  });
  vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    calls.command += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return [];
  });

  invalidateAllDownloadStatusesCache();
  await getLidarrStatusSnapshot({ refresh: true });
  assert.deepEqual(calls, { queue: 1, history: 1, command: 1 });

  fail = true;
  refreshGate = Promise.withResolvers<void>();
  invalidateAllDownloadStatusesCache();
  const pending = getLidarrStatusSnapshot({ refresh: true });
  while (calls.queue < 2 || calls.history < 2 || calls.command < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  invalidateAllDownloadStatusesCache();
  refreshGate.resolve();
  const stale = await pending;
  refreshGate = null;
  assert.equal(stale.stale, true);
  assert.deepEqual(calls, { queue: 2, history: 2, command: 2 });

  fail = false;
  const recovered = await getLidarrStatusSnapshot();
  assert.equal(recovered.stale, false);
  assert.deepEqual(calls, { queue: 3, history: 3, command: 3 });
});

test("forced Lidarr status reads bypass the client cache", async (t: import("vite-plus/test").TestContext) => {
  let calls = 0;
  const server = http.createServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ id: calls }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${listeningAddress(server)!.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
    rootFolderPath: "",
    rootFolderPaths: [],
    insecure: false,
  };
  t.onTestFinished(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  assert.equal((await client.getQueue())[0].id, 1);
  assert.equal((await client.getQueue())[0].id, 1);
  assert.equal((await client.getQueue({ forceRefresh: true }))[0].id, 2);
  assert.equal(calls, 2);
});

test("failed or stale history verifies albums with one bulk read", async () => {
  const now = Date.now();
  const calls = { bulk: 0, detail: 0 };
  let bulkFailure = false;
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getAllAlbums").mockImplementation(async () => {
    calls.bulk += 1;
    if (bulkFailure) throw new Error("provider unavailable");
    return [
      { id: 101, foreignAlbumId: "album-101", statistics: { trackFileCount: 2 } },
      { id: 102, foreignAlbumId: "album-102", statistics: { trackFileCount: 0 } },
    ];
  });
  vi.spyOn(lidarrClient, "getAlbum").mockImplementation(async () => {
    calls.detail += 1;
    return null;
  });

  const normal = await getDownloadStatusesForAlbumIds(["100"], {
    queue: [],
    history: {
      records: [{ id: 100, albumId: 100, eventType: "grabbed", date: new Date(now).toISOString() }],
    },
    commands: [],
  });
  assert.equal(normal[100].status, "processing");
  assert.deepEqual(calls, { bulk: 0, detail: 0 });

  const verified = await getDownloadStatusesForAlbumIds(["101", "102"], {
    queue: [],
    history: {
      records: [
        {
          id: 101,
          albumId: 101,
          eventType: "AlbumImportIncomplete",
          date: new Date(now).toISOString(),
        },
        {
          id: 102,
          albumId: 102,
          eventType: "grabbed",
          date: new Date(now - 16 * 60 * 1000).toISOString(),
        },
      ],
    },
    commands: [],
  });
  assert.equal(verified[101].status, "added");
  assert.equal(verified[102].status, "failed");
  assert.deepEqual(calls, { bulk: 1, detail: 0 });

  bulkFailure = true;
  const failedVerification = await getDownloadStatusesForAlbumIds(["101", "102"], {
    queue: [],
    history: {
      records: [
        { id: 101, albumId: 101, eventType: "DownloadFailed", date: new Date(now).toISOString() },
        {
          id: 102,
          albumId: 102,
          eventType: "AlbumImportIncomplete",
          date: new Date(now).toISOString(),
        },
      ],
    },
    commands: [],
  });
  assert.equal(failedVerification[101].status, "failed");
  assert.equal(failedVerification[102].status, "failed");
  assert.deepEqual(calls, { bulk: 2, detail: 0 });
});

test("album status reads Lidarr event types rather than words in the history", async () => {
  const now = Date.now();
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getAllAlbums").mockImplementation(async () => [
    { id: 201, foreignAlbumId: "album-201", statistics: { trackFileCount: 0 } },
  ]);
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  const statuses = await getDownloadStatusesForAlbumIds(["200", "201", "202", "203", "204"], {
    queue: [
      {
        id: 202,
        albumId: 202,
        trackedDownloadState: "importBlocked",
        trackedDownloadStatus: "warning",
        size: 10,
        sizeleft: 0,
      },
      {
        id: 203,
        albumId: 203,
        trackedDownloadState: "downloading",
        trackedDownloadStatus: "warning",
        size: 10,
        sizeleft: 5,
      },
    ],
    history: {
      records: [
        { id: 200, albumId: 200, eventType: "downloadImported", date: at(30) },
        { id: 200, albumId: 200, eventType: "trackFileRenamed", date: at(1) },
        {
          id: 201,
          albumId: 201,
          eventType: "grabbed",
          sourceTitle: "Epic Fail - Album [FLAC]",
          data: { message: "failover indexer" },
          date: at(1),
        },
        { id: 204, albumId: 204, eventType: "trackFileRetagged", date: at(1) },
      ],
    },
    commands: [],
  });
  assert.equal(statuses[200].status, "added");
  assert.equal(statuses[201].status, "processing");
  assert.equal(statuses[202].status, "failed");
  assert.equal(statuses[203].status, "downloading");
  assert.equal("progress" in statuses[203] ? statuses[203].progress : undefined, 50);
  assert.equal(statuses[204], undefined);
});
