import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { pathToFileURL } from "url";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "discovery-cache-hydration",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

test.after(async () => {
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

  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "backend/services/discovery/index.js"),
  ).href;
  const { getDiscoveryCache } = await import(`${moduleUrl}?t=${Date.now()}`);
  const cache = getDiscoveryCache();

  assert.ok(cache.lastUpdated);
  assert.deepEqual(cache.recommendations, []);
  assert.deepEqual(cache.globalTop, []);
  assert.deepEqual(cache.topGenres, []);
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
