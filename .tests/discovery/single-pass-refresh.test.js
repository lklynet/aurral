import test from "node:test";
import assert from "node:assert/strict";
import {
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("single-pass-refresh");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("single-pass refresh: buildRecommendationsFromSeeds includes candidate tag hydration and second-hop discovery", async () => {
  const {
    buildDiscoverySeedList,
    addRecommendationCandidate,
    finalizeRecommendationAccumulator,
  } = await importFromRepo("backend/services/discovery/recommendationPipeline.js");

  const seeds = buildDiscoverySeedList({
    libraryArtists: [
      {
        mbid: "11111111-1111-1111-1111-111111111111",
        artistName: "Seed Artist",
        source: "library",
      },
    ],
    historyArtists: [],
  });
  assert.equal(seeds.length, 1);

  const accumulator = new Map();
  const existingArtistKeys = new Set();
  const profileTagWeights = new Map([
    ["shoegaze", 4],
    ["dream-pop", 3],
    ["ethereal", 2],
  ]);

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "22222222-2222-2222-2222-222222222222",
      name: "Primary Discovery",
      match: 0.85,
    },
    seed: seeds[0],
    sourceTags: ["Shoegaze", "Dream-Pop"],
    profileTagWeights,
    existingArtistKeys,
  });

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "33333333-3333-3333-3333-333333333333",
      name: "Second Hop Discovery",
      match: 0.55,
      discoveryDepth: 2,
      similarityMultiplier: 0.55,
      tagAffinityMultiplier: 0.55,
    },
    seed: {
      mbid: "22222222-2222-2222-2222-222222222222",
      artistName: "Primary Discovery",
      source: "lastfm_related",
      profileBucket: "two_hop_bridge",
      weight: 0.65,
      affinityWeight: 0.65,
      discoveryDepth: 2,
      similarityMultiplier: 0.55,
      tagAffinityMultiplier: 0.55,
    },
    sourceTags: ["Ethereal"],
    profileTagWeights,
    existingArtistKeys,
  });

  const merged = finalizeRecommendationAccumulator(accumulator, 10);
  assert.equal(merged.length, 2);

  const primary = merged.find((item) => item.name === "Primary Discovery");
  const secondHop = merged.find((item) => item.name === "Second Hop Discovery");

  assert.ok(primary);
  assert.ok(secondHop);
  assert.equal(primary.discoveryDepth, 1);
  assert.equal(secondHop.discoveryDepth, 2);
  assert.ok(primary.scoreTotal > secondHop.scoreTotal);
  assert.ok(primary.seedCount >= secondHop.seedCount);
});

test("single-pass refresh: applyHydratedCandidateTags recalculates score when candidate tags replace seed tags", async () => {
  const { applyHydratedCandidateTags } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );

  const recommendation = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "Hydrated Artist",
    tags: ["shoegaze"],
    matchedTags: ["shoegaze"],
    scoreSimilarity: 80,
    scoreTagAffinity: 24,
    scoreSeedCoverage: 12,
    scoreNovelty: 8,
    scorePopularityPenalty: 4,
    scoreTotal: 120,
    seedCount: 1,
  };

  const profileTagWeights = new Map([
    ["industrial", 5],
    ["noise rock", 3],
    ["shoegaze", 4],
  ]);

  const hydrated = applyHydratedCandidateTags(
    recommendation,
    ["Industrial", "Noise Rock"],
    profileTagWeights,
  );

  assert.deepEqual(hydrated.tags, ["industrial", "noise rock"]);
  assert.deepEqual(hydrated.matchedTags, ["industrial", "noise rock"]);
  assert.equal(hydrated.scoreTagAffinity, 45);
  assert.equal(hydrated.candidateTagsHydrated, true);
  assert.equal(hydrated.tagSource, "lastfm_artist");
  assert.ok(hydrated.scoreTotal > 120);
});

test("single-pass refresh: db discovery cache stores enriched quality after single-pass write", async () => {
  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  const { dbOps } = await importFromRepo("backend/db/helpers/index.js");
  resetDatabase(db);

  const enrichedAt = new Date().toISOString();
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "artist-1", name: "Test Artist" }],
    recommendationQuality: "enriched",
    isEnriching: false,
    discoveryRunId: "run-single-pass",
    enrichmentStartedAt: null,
    enrichmentCompletedAt: enrichedAt,
    enrichmentProgressMessage: null,
    lastUpdated: enrichedAt,
  });

  const cache = dbOps.getDiscoveryCache();
  assert.equal(cache.recommendationQuality, "enriched");
  assert.equal(cache.isEnriching, false);
  assert.equal(cache.enrichmentStartedAt, null);
  assert.equal(cache.enrichmentCompletedAt, enrichedAt);
  assert.equal(cache.enrichmentProgressMessage, null);
  assert.deepEqual(cache.recommendations, [
    { id: "artist-1", name: "Test Artist" },
  ]);
});

