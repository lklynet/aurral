import assert from "node:assert/strict";
import { test } from "node:test";

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
    lastUpdated,
  });
  await emit({ isUpdating: false, phase: "completed", progress: 100 });
  assert.equal(getDiscoveryCache().isUpdating, false);
  assert.equal(getDiscoveryCache().lastUpdated, dbOps.getDiscoveryCache().lastUpdated);
  assert.equal(getDiscoveryCache().recommendations[0].name, "Worker Artist");
});
