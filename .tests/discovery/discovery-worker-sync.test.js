import assert from "node:assert/strict";
import { test } from "node:test";
import { getDiscoveryCapabilities } from "../../backend/services/listenbrainzDiscoveryFallback.js";

test("discovery worker progress and completed data reach the API without shared memory", async () => {
  const { dbOps } = await import("../../backend/db/helpers/index.js");
  const persistence = await import("../../backend/services/discovery/persistence.js");
  const { getDiscoveryStatus } = await import("../../backend/services/discovery/userDiscovery.js");
  const { forwardWorkerBroadcast } = await import("../../backend/services/appRuntime.js");
  const { getDiscoveryCache, resetDiscoveryModuleCache } = persistence;

  persistence.markDiscoveryRefreshStarted();
  persistence.recordDiscoveryUpdateProgress("loading_sources", "Loading library artists", 12);
  resetDiscoveryModuleCache();
  const running = getDiscoveryStatus(null);
  assert.equal(running.isUpdating, true);
  assert.equal(running.updateProgress, 12);
  assert.equal(running.updateProgressMessage, "Loading library artists");

  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "worker-artist", name: "Worker Artist" }],
    provider: "listenbrainz-fallback",
  });
  persistence.markDiscoveryRefreshFinished();
  await forwardWorkerBroadcast({
    type: "websocket-broadcast",
    channel: "discovery",
    data: { isUpdating: false, phase: "completed", progress: 100 },
  });
  assert.equal(getDiscoveryStatus(null).isUpdating, false);
  assert.equal(getDiscoveryStatus(null).lastUpdated, dbOps.getDiscoveryCache().lastUpdated);
  assert.equal(getDiscoveryCache().recommendations[0].name, "Worker Artist");
  assert.equal(getDiscoveryCache().provider, "listenbrainz-fallback");
  assert.deepEqual(getDiscoveryCache().capabilities, getDiscoveryCapabilities(false));
});

test("a personal refresh in a worker shows as updating only for its user", async () => {
  const { dbOps } = await import("../../backend/db/helpers/index.js");
  const persistence = await import("../../backend/services/discovery/persistence.js");
  const { getDiscoveryStatus } = await import("../../backend/services/discovery/userDiscovery.js");
  const { websocketService } = await import("../../backend/services/websocketService.js");
  const { forwardWorkerBroadcast } = await import("../../backend/services/appRuntime.js");

  const originalLastfmApiKey = process.env.LASTFM_API_KEY;
  process.env.LASTFM_API_KEY = "test-key";
  const sent = { alice: [], bob: [] };
  const client = (id, inbox) => ({
    user: { id },
    subscriptions: new Set(["discovery"]),
    ws: { readyState: 1, send: (message) => inbox.push(JSON.parse(message)) },
  });
  const clients = [client(7, sent.alice), client(8, sent.bob)];
  clients.forEach((entry) => websocketService.clients.add(entry));
  const { db } = await import("../../backend/config/db-sqlite.js");
  dbOps.updateDiscoveryCache({ recommendations: [{ name: "Stale" }] }, "user:7");
  assert.equal(dbOps.getDiscoveryCache("user:7").recommendations[0].name, "Stale");
  db.prepare("UPDATE discovery_cache SET value = ? WHERE key = ?")
    .run(JSON.stringify([{ name: "Fresh" }]), "user:7:recommendations");

  try {
    persistence.markDiscoveryRefreshStarted("user:7");
    persistence.saveDiscoveryRefreshProgress("user:7", "collecting_seeds", "Collecting your seed artists", 10);
    await forwardWorkerBroadcast({
      type: "websocket-broadcast",
      channel: "discovery",
      data: { type: "discovery_update", isUpdating: true, phase: "collecting_seeds" },
      userId: 7,
    });
    assert.equal(getDiscoveryStatus(7).isUpdating, true);
    assert.equal(getDiscoveryStatus(7).updateProgressMessage, "Collecting your seed artists");
    assert.equal(getDiscoveryStatus(8).isUpdating, false);
    assert.equal(sent.alice.length, 1);
    assert.equal(sent.bob.length, 0);
    assert.equal(dbOps.getDiscoveryCache("user:7").recommendations[0].name, "Fresh");
  } finally {
    clients.forEach((entry) => websocketService.clients.delete(entry));
    if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  }
});
