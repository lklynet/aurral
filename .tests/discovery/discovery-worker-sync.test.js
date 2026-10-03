import assert from "node:assert/strict";
import { test } from "node:test";
import { getDiscoveryCapabilities } from "../../backend/services/listenbrainzDiscoveryFallback.js";

test("discovery worker progress and completed data reach the API cache", async () => {
  const { dbOps } = await import("../../backend/db/helpers/index.js");
  const {
    getDiscoveryCache,
    resetDiscoveryModuleCache,
  } = await import("../../backend/services/discovery/persistence.js");
  const { forwardWorkerBroadcast } = await import("../../backend/services/appRuntime.js");

  const emit = (data) => forwardWorkerBroadcast({
    type: "websocket-broadcast",
    channel: "discovery",
    data,
  });

  resetDiscoveryModuleCache();
  await emit({
    isUpdating: true,
    phase: "loading_sources",
    progress: 12,
    progressMessage: "Loading library artists",
  });
  assert.equal(getDiscoveryCache().isUpdating, true);
  assert.equal(getDiscoveryCache().updateProgress, 12);

  const lastUpdated = new Date().toISOString();
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "worker-artist", name: "Worker Artist" }],
    provider: "listenbrainz-fallback",
    lastUpdated,
  });
  await emit({ isUpdating: false, phase: "completed", progress: 100 });
  assert.equal(getDiscoveryCache().isUpdating, false);
  assert.equal(getDiscoveryCache().lastUpdated, dbOps.getDiscoveryCache().lastUpdated);
  assert.equal(getDiscoveryCache().recommendations[0].name, "Worker Artist");
  assert.equal(getDiscoveryCache().provider, "listenbrainz-fallback");
  assert.deepEqual(getDiscoveryCache().capabilities, getDiscoveryCapabilities(false));
});

test("a personal refresh in a worker does not mark discovery as updating for everyone", async () => {
  const { dbOps } = await import("../../backend/db/helpers/index.js");
  const { getDiscoveryCache, resetDiscoveryModuleCache } = await import(
    "../../backend/services/discovery/persistence.js"
  );
  const { websocketService } = await import("../../backend/services/websocketService.js");
  const { forwardWorkerBroadcast } = await import("../../backend/services/appRuntime.js");

  resetDiscoveryModuleCache();
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
    await forwardWorkerBroadcast({
      type: "websocket-broadcast",
      channel: "discovery",
      data: { type: "discovery_update", isUpdating: true, phase: "collecting_seeds" },
      userId: 7,
    });
    assert.equal(getDiscoveryCache().isUpdating, false);
    assert.equal(sent.alice.length, 1);
    assert.equal(sent.bob.length, 0);
    assert.equal(dbOps.getDiscoveryCache("user:7").recommendations[0].name, "Fresh");
  } finally {
    clients.forEach((entry) => websocketService.clients.delete(entry));
  }
});
