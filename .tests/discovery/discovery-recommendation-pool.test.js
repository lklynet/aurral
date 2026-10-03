import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";
import { createDiscoveryArtistBatcher } from "../helpers/discoveryFixtures.js";

const [
  isolatedState,
  recommendationPipeline,
  discoveryIndex,
] = await setupIsolatedBackend(
  "discovery-recommendation-pool",
  "backend/services/discovery/recommendationPipeline.js",
  "backend/services/discovery/index.js",
);

const { mergeRetainedRecommendationPool, serveRecommendations } =
  recommendationPipeline;
const {
  getDiscoveryRecommendationsPerRefresh,
  getDiscoveryRecommendationPoolLimit,
  rerankCachedRecommendations,
} = discoveryIndex;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const PER_REFRESH = getDiscoveryRecommendationsPerRefresh();
const POOL_LIMIT = getDiscoveryRecommendationPoolLimit();

const artists = createDiscoveryArtistBatcher();

function simulatePhase({
  existingRecommendations = [],
  candidateCount = PER_REFRESH * 2,
  baseScore = 200,
  prefix = "artist",
  runStartedAt = new Date().toISOString(),
} = {}) {
  const candidates = artists.makeBatch(candidateCount, baseScore, prefix);
  const freshRecommendations = rerankCachedRecommendations({
    recommendations: candidates,
    discoveryMode: "balanced",
    limit: PER_REFRESH,
  });
  return mergeRetainedRecommendationPool({
    freshRecommendations,
    existingRecommendations,
    limit: POOL_LIMIT,
    runStartedAt,
    discoveryMode: "balanced",
  });
}

test("two-phase refresh grows pool from initial hydration through enrichment", () => {
  artists.reset();
  const runStartedAt = "2026-06-18T00:00:00.000Z";
  const phaseOnePool = simulatePhase({
    existingRecommendations: [],
    candidateCount: PER_REFRESH + 40,
    baseScore: 220,
    prefix: "phase1",
    runStartedAt,
  });
  assert.equal(phaseOnePool.length, PER_REFRESH);
  assert.equal(
    phaseOnePool.every((item) => item.recommendationPoolState === "fresh"),
    true,
  );

  const phaseTwoPool = simulatePhase({
    existingRecommendations: phaseOnePool,
    candidateCount: PER_REFRESH + 40,
    baseScore: 210,
    prefix: "phase2",
    runStartedAt: "2026-06-18T01:00:00.000Z",
  });
  assert.equal(phaseTwoPool.length, PER_REFRESH * 2);
  assert.equal(
    phaseTwoPool.filter((item) => item.recommendationPoolState === "fresh").length,
    PER_REFRESH,
  );
  assert.equal(
    phaseTwoPool.filter((item) => item.recommendationPoolState === "retained").length,
    PER_REFRESH,
  );
  assert.equal(
    phaseTwoPool.some((item) => item.name.startsWith("phase1-")),
    true,
  );
  assert.equal(
    phaseTwoPool.some((item) => item.name.startsWith("phase2-")),
    true,
  );
});

test("repeated refreshes build the pool to the 500 cap", () => {
  artists.reset();
  let pool = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    pool = simulatePhase({
      existingRecommendations: pool,
      candidateCount: PER_REFRESH + 20,
      baseScore: 300 - cycle * 10,
      prefix: `cycle-${cycle}`,
      runStartedAt: `2026-06-${10 + cycle}T00:00:00.000Z`,
    });
  }

  const oldestRemaining = pool.filter((item) =>
    item.name.startsWith("cycle-0-"),
  ).length;
  const newestRemaining = pool.filter((item) =>
    item.name.startsWith("cycle-3-"),
  ).length;

  assert.equal(pool.length, POOL_LIMIT);
  assert.ok(oldestRemaining > 0);
  assert.ok(oldestRemaining < PER_REFRESH);
  assert.ok(newestRemaining > 0);
});

test("rotation drops lowest retained artists when fresh batch arrives", () => {
  artists.reset();
  const weakRetained = artists.makeBatch(POOL_LIMIT, 40, "weak");
  const freshBatch = artists.makeBatch(PER_REFRESH, 250, "fresh");
  const freshRecommendations = rerankCachedRecommendations({
    recommendations: freshBatch,
    discoveryMode: "balanced",
    limit: PER_REFRESH,
  });

  const rotated = mergeRetainedRecommendationPool({
    freshRecommendations,
    existingRecommendations: weakRetained,
    limit: POOL_LIMIT,
    runStartedAt: "2026-06-18T12:00:00.000Z",
    discoveryMode: "balanced",
  });

  assert.equal(rotated.length, POOL_LIMIT);
  assert.equal(
    rotated.filter((item) => item.name.startsWith("fresh-")).length,
    PER_REFRESH,
  );
  assert.equal(
    rotated.filter((item) => item.name.startsWith("weak-")).length,
    POOL_LIMIT - PER_REFRESH,
  );
  assert.equal(
    rotated.some((item) => item.name === `weak-${POOL_LIMIT - 1}`),
    false,
  );
  assert.equal(rotated.some((item) => item.name === "weak-0"), true);
});

test("serveRecommendations ranks less-like artists lower and hides only exact blocks", () => {
  const storedPool = artists.makeBatch(5, 180, "stored");
  const hidden = storedPool[2];
  const unchanged = serveRecommendations(storedPool);
  const lessLike = serveRecommendations(storedPool, {
    feedback: [{ artistId: hidden.id, action: "less_like_this" }],
  });

  assert.deepEqual(
    lessLike.map((item) => item.name).sort(),
    storedPool.map((item) => item.name).sort(),
  );
  assert.ok(
    lessLike.findIndex((item) => item.id === hidden.id) >
      unchanged.findIndex((item) => item.id === hidden.id),
  );

  const filtered = serveRecommendations(storedPool, {
    feedback: [{ artistId: hidden.id, action: "block_artist" }],
  });

  assert.equal(filtered.length, 4);
  assert.deepEqual(
    filtered.map((item) => item.name),
    storedPool.filter((item) => item.id !== hidden.id).map((item) => item.name),
  );
});

test("rerankCachedRecommendations still trims refresh batches to the per-refresh limit", () => {
  artists.reset();
  const storedPool = artists.makeBatch(350, 180, "stored");
  const servedWithRefreshLimit = rerankCachedRecommendations({
    recommendations: storedPool,
    discoveryMode: "balanced",
  });
  const servedWithPoolLimit = rerankCachedRecommendations({
    recommendations: storedPool,
    discoveryMode: "balanced",
    limit: POOL_LIMIT,
  });

  assert.equal(servedWithRefreshLimit.length, PER_REFRESH);
  assert.equal(servedWithPoolLimit.length, 350);
});

test("enrichment marks returning artists as fresh while preserving firstDiscoveredAt", () => {
  artists.reset();
  const runStartedAt = "2026-06-18T00:00:00.000Z";
  const initialPool = simulatePhase({
    existingRecommendations: [],
    candidateCount: PER_REFRESH,
    baseScore: 200,
    prefix: "seed",
    runStartedAt,
  });
  const returningArtist = initialPool[0];
  const enrichedCandidate = {
    ...returningArtist,
    scoreTotal: returningArtist.scoreTotal + 25,
    scoreSimilarity: returningArtist.scoreSimilarity + 25,
    matchedTags: ["indie", "shoegaze"],
  };
  const enrichmentFresh = rerankCachedRecommendations({
    recommendations: [
      enrichedCandidate,
      ...artists.makeBatch(PER_REFRESH - 1, 190, "enriched"),
    ],
    discoveryMode: "balanced",
    limit: PER_REFRESH,
  });
  const enrichedPool = mergeRetainedRecommendationPool({
    freshRecommendations: enrichmentFresh,
    existingRecommendations: initialPool,
    limit: POOL_LIMIT,
    runStartedAt: "2026-06-18T01:00:00.000Z",
    discoveryMode: "balanced",
  });
  const updatedReturning = enrichedPool.find(
    (item) => item.id === returningArtist.id,
  );

  assert.ok(updatedReturning);
  assert.equal(
    updatedReturning.firstDiscoveredAt,
    returningArtist.firstDiscoveredAt || runStartedAt,
  );
  assert.equal(updatedReturning.lastRecommendedAt, "2026-06-18T01:00:00.000Z");
  assert.equal(updatedReturning.recommendationPoolState, "fresh");
});

test("merge retains existing artists alongside fresh when fresh batch falls short of pool limit", () => {
  artists.reset();
  const runStartedAt = "2026-06-22T00:00:00.000Z";

  const existing = artists.makeBatch(100, 160, "existing");
  const freshFull = artists.makeBatch(250, 220, "fresh-full");
  const freshRanked = rerankCachedRecommendations({
    recommendations: freshFull,
    discoveryMode: "balanced",
    limit: 200,
  });

  const merged = mergeRetainedRecommendationPool({
    freshRecommendations: freshRanked,
    existingRecommendations: existing,
    limit: 500,
    runStartedAt,
    discoveryMode: "balanced",
  });

  assert.equal(merged.length, 300);
  assert.ok(merged.filter((item) => item.recommendationPoolState === "fresh").length > 0);
  assert.ok(merged.filter((item) => item.recommendationPoolState === "retained").length > 0);
  assert.equal(
    merged.filter((item) => item.name.startsWith("fresh-full-")).length,
    200,
  );
  assert.equal(
    merged.filter((item) => item.name.startsWith("existing-")).length,
    100,
  );
});
