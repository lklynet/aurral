import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "discovery-cache-hydration",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getDiscoveryCache preserves lastUpdated after an empty completed refresh", async () => {
  resetDatabase(db);

  dbOps.updateDiscoveryCache({
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
  });

  const { getDiscoveryCache } = await import("../../backend/services/discovery/index.ts");
  const cache = getDiscoveryCache();

  assert.ok(cache.lastUpdated);
  assert.deepEqual([...cache.recommendations], []);
  assert.deepEqual([...cache.globalTop], []);
  assert.deepEqual([...cache.topGenres], []);
});

test("getDiscoveryCache persists recommendation enrichment metadata", async () => {
  resetDatabase(db);

  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "artist-1", name: "Initial Artist" }],
    recommendationQuality: "initial",
    isEnriching: true,
    discoveryRunId: "run-1",
    enrichmentStartedAt: "2026-06-18T00:00:00.000Z",
    enrichmentProgressMessage: "Improving recommendations",
  });

  const cache = dbOps.getDiscoveryCache();

  assert.equal(cache.recommendationQuality, "initial");
  assert.equal(cache.isEnriching, true);
  assert.equal(cache.discoveryRunId, "run-1");
  assert.equal(cache.enrichmentStartedAt, "2026-06-18T00:00:00.000Z");
  assert.equal(cache.enrichmentProgressMessage, "Improving recommendations");
});

test("a stored discovery list with a broken entry still serves the rest", () => {
  resetDatabase(db);
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "artist-1", name: "Artist" }],
    recommendationQuality: "initial",
  });
  const write = db.prepare("UPDATE discovery_cache SET value = ? WHERE key = ?");
  write.run(
    JSON.stringify([null, "artist-0", { id: "artist-2" }, { id: "artist-1", name: "Artist" }]),
    "recommendations",
  );
  write.run(JSON.stringify({ recommendationQuality: 3, discoveryRunId: "run-1" }), "metadata");

  const cache = dbOps.getDiscoveryCache();

  assert.deepEqual(
    cache.recommendations.map((artist) => artist.id),
    ["artist-1"],
  );
  assert.equal(cache.recommendationQuality, null);
  assert.equal(cache.discoveryRunId, "run-1");
});
