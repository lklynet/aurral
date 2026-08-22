import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  getDownloadStatusesForAlbumIds,
  getLidarrStatusSnapshot,
  hasActiveLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "../../backend/routes/library/handlers/downloads.js";
import { LidarrClient, lidarrClient } from "../../backend/services/lidarrClient.js";
import { buildLidarrRequests } from "../../backend/services/lidarrRequestBuilder.js";

test("Lidarr status consumers share refreshes, idle, failure, and recovery state", async (t) => {
  let active = false;
  let fail = false;
  let queueGate = null;
  let albumCalls = 0;
  const calls = { queue: 0, history: 0, command: 0 };
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "isCircuitOpen", () => false);
  t.mock.method(lidarrClient, "getQueue", async (options) => {
    assert.equal(options.forceRefresh, true);
    calls.queue += 1;
    if (fail) throw new Error("provider unavailable");
    if (queueGate) await queueGate.promise;
    return active ? [{ id: 1, albumId: 10, status: "downloading", size: 10, sizeleft: 5 }] : [];
  });
  t.mock.method(lidarrClient, "getHistory", async (...args) => {
    assert.deepEqual(args, [1, 200, "date", "descending", { forceRefresh: true }]);
    calls.history += 1;
    if (fail) throw new Error("provider unavailable");
    return { records: [] };
  });
  t.mock.method(lidarrClient, "request", async (endpoint, method, data, skip, options) => {
    assert.equal(endpoint, "/command");
    assert.deepEqual([method, data, skip, options], ["GET", null, false, { forceRefresh: true }]);
    calls.command += 1;
    if (fail) throw new Error("provider unavailable");
    return [];
  });
  t.mock.method(lidarrClient, "getAllAlbums", async () => {
    albumCalls += 1;
    return [];
  });

  invalidateAllDownloadStatusesCache();
  const [first, concurrent] = await Promise.all([
    getLidarrStatusSnapshot({ force: true }),
    getLidarrStatusSnapshot({ force: true }),
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
  assert.match(stale.error, /provider unavailable/);
  assert.equal((await getLidarrStatusSnapshot()).stale, true);
  assert.deepEqual(calls, { queue: 3, history: 3, command: 3 });

  fail = false;
  active = false;
  const recovered = await getLidarrStatusSnapshot({ force: true });
  assert.equal(recovered.stale, false);
  assert.equal(recovered.active, false);
  assert.deepEqual(calls, { queue: 4, history: 4, command: 4 });

  queueGate = Promise.withResolvers();
  const pending = getLidarrStatusSnapshot({ force: true });
  while (calls.queue < 5) await new Promise((resolve) => setImmediate(resolve));
  invalidateAllDownloadStatusesCache();
  queueGate.resolve();
  await pending;
  queueGate = null;
  await getLidarrStatusSnapshot();
  assert.deepEqual(calls, { queue: 6, history: 6, command: 6 });
});

test("invalidating a failed refresh allows immediate recovery", async (t) => {
  let fail = false;
  let refreshGate = null;
  const calls = { queue: 0, history: 0, command: 0 };
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "isCircuitOpen", () => false);
  t.mock.method(lidarrClient, "getQueue", async () => {
    calls.queue += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return [];
  });
  t.mock.method(lidarrClient, "getHistory", async () => {
    calls.history += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return { records: [] };
  });
  t.mock.method(lidarrClient, "request", async () => {
    calls.command += 1;
    if (refreshGate) await refreshGate.promise;
    if (fail) throw new Error("provider unavailable");
    return [];
  });

  invalidateAllDownloadStatusesCache();
  await getLidarrStatusSnapshot({ force: true });
  assert.deepEqual(calls, { queue: 1, history: 1, command: 1 });

  fail = true;
  refreshGate = Promise.withResolvers();
  const pending = getLidarrStatusSnapshot({ force: true });
  while (calls.queue < 2 || calls.history < 2 || calls.command < 2) {
    await new Promise((resolve) => setImmediate(resolve));
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

test("forced Lidarr status reads bypass the client cache", async (t) => {
  let calls = 0;
  const server = http.createServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ id: calls }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  assert.equal((await client.getQueue())[0].id, 1);
  assert.equal((await client.getQueue())[0].id, 1);
  assert.equal((await client.getQueue({ forceRefresh: true }))[0].id, 2);
  assert.equal(calls, 2);
});

test("failed or stale history verifies albums with one bulk read", async (t) => {
  const now = Date.now();
  const calls = { bulk: 0, detail: 0 };
  let bulkFailure = false;
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getAllAlbums", async () => {
    calls.bulk += 1;
    if (bulkFailure) throw new Error("provider unavailable");
    return [
      { id: 101, statistics: { trackFileCount: 2 } },
      { id: 102, statistics: { trackFileCount: 0 } },
    ];
  });
  t.mock.method(lidarrClient, "getAlbum", async () => {
    calls.detail += 1;
    return null;
  });

  const normal = await getDownloadStatusesForAlbumIds(["100"], {
    queue: [],
    history: {
      records: [{ albumId: 100, eventType: "AlbumGrabbed", date: new Date(now).toISOString() }],
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
          albumId: 101,
          eventType: "AlbumImportIncomplete",
          date: new Date(now).toISOString(),
        },
        {
          albumId: 102,
          eventType: "AlbumGrabbed",
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
        { albumId: 101, eventType: "DownloadFailed", date: new Date(now).toISOString() },
        { albumId: 102, eventType: "AlbumImportIncomplete", date: new Date(now).toISOString() },
      ],
    },
    commands: [],
  });
  assert.equal(failedVerification[101].status, "failed");
  assert.equal(failedVerification[102].status, "failed");
  assert.deepEqual(calls, { bulk: 2, detail: 0 });
});
