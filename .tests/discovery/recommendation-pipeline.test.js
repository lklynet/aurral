import test from "node:test";
import assert from "node:assert/strict";

import {
  addRecommendationCandidate,
  buildDiscoverySeedList,
  finalizeRecommendationAccumulator,
  filterRecommendationsForServe,
  mergeRetainedRecommendationPool,
  mergeResolvedRecommendations,
  rerankRecommendations,
} from "../../backend/services/discovery/recommendationPipeline.js";

test("buildDiscoverySeedList prefers listening-history weight when the same artist exists in library and history", () => {
  const seeds = buildDiscoverySeedList({
    libraryArtists: [
      {
        mbid: "11111111-1111-1111-1111-111111111111",
        artistName: "Library Artist",
        source: "library",
      },
    ],
    historyArtists: [
      {
        mbid: "11111111-1111-1111-1111-111111111111",
        artistName: "Library Artist",
        source: "listenbrainz",
        playcount: 42,
      },
      {
        mbid: "22222222-2222-2222-2222-222222222222",
        artistName: "History Only",
        source: "lastfm",
        playcount: 12,
      },
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].mbid, "11111111-1111-1111-1111-111111111111");
  assert.equal(seeds[0].source, "listenbrainz");
  assert.ok(seeds[0].weight > 1.3);
  assert.equal(seeds[1].source, "lastfm");
});

test("recommendation candidates aggregate across multiple seeds", () => {
  const accumulator = new Map();
  const existingArtistKeys = new Set();
  const profileTagWeights = new Map([
    ["dream-pop", 3],
    ["shoegaze", 4],
  ]);

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "33333333-3333-3333-3333-333333333333",
      name: "Candidate Artist",
      match: 0.81,
    },
    seed: {
      artistName: "Seed One",
      source: "library",
      weight: 1.2,
    },
    sourceTags: ["Dream-Pop", "Indie"],
    profileTagWeights,
    existingArtistKeys,
  });

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "33333333-3333-3333-3333-333333333333",
      name: "Candidate Artist",
      match: 0.73,
    },
    seed: {
      artistName: "Seed Two",
      source: "listenbrainz",
      weight: 1.5,
    },
    sourceTags: ["Shoegaze"],
    profileTagWeights,
    existingArtistKeys,
  });

  const [recommendation] = finalizeRecommendationAccumulator(accumulator, 10);
  assert.equal(recommendation.name, "Candidate Artist");
  assert.equal(recommendation.seedCount, 2);
  assert.equal(recommendation.sourceType, "blended");
  assert.deepEqual(
    recommendation.sourceArtists.sort(),
    ["Seed One", "Seed Two"],
  );
  assert.ok(recommendation.scoreTotal > 150);
  assert.ok(recommendation.tags.includes("dream-pop"));
  assert.ok(recommendation.tags.includes("shoegaze"));
  assert.ok(recommendation.matchedTags.includes("dream-pop"));
  assert.ok(recommendation.matchedTags.includes("shoegaze"));
  assert.ok(recommendation.reasonCodes.length > 0);
});

test("mergeResolvedRecommendations collapses name and mbid variants of the same artist", () => {
  const merged = mergeResolvedRecommendations([
    {
      name: "Slowdive",
      score: 140,
      sourceArtist: "Seed One",
      sourceType: "library",
      tags: ["shoegaze"],
    },
    {
      id: "44444444-4444-4444-4444-444444444444",
      navigateTo: "44444444-4444-4444-4444-444444444444",
      name: "Slowdive",
      score: 155,
      sourceArtists: ["Seed Two"],
      sourceTypes: ["lastfm"],
      tags: ["dream-pop"],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "44444444-4444-4444-4444-444444444444");
  assert.equal(merged[0].sourceType, "blended");
  assert.deepEqual(
    merged[0].tags.sort(),
    ["dream-pop", "shoegaze"],
  );
});

test("mergeResolvedRecommendations does not expose provider IDs as artist routes", () => {
  const [recommendation] = mergeResolvedRecommendations([
    { id: 2278254, navigateTo: 2278254, name: "Discovery Artist" },
  ]);

  assert.equal(recommendation.id, null);
  assert.equal(recommendation.navigateTo, null);

  const [cachedRecommendation] = filterRecommendationsForServe([
    { id: 2278254, navigateTo: 2278254, name: "Cached Discovery Artist" },
  ]);
  assert.equal(cachedRecommendation.id, null);
  assert.equal(cachedRecommendation.navigateTo, null);
});


test("rerankRecommendations softens less-like feedback, hard-blocks exact artists, and favors deeper mode diversification", () => {
  const recommendations = [
    {
      id: "55555555-5555-5555-5555-555555555555",
      name: "Safe Pick",
      matchedTags: ["shoegaze", "dream-pop"],
      supportingSeeds: [{ artistName: "Slowdive", weight: 2 }],
      scoreSimilarity: 110,
      scoreTagAffinity: 30,
      scoreSeedCoverage: 20,
      scoreNovelty: 8,
      scorePopularityPenalty: 12,
      scoreTotal: 156,
      seedCount: 3,
      sourceType: "lastfm",
    },
    {
      id: "66666666-6666-6666-6666-666666666666",
      name: "Deeper Pick",
      matchedTags: ["shoegaze", "ethereal"],
      supportingSeeds: [{ artistName: "Curve", weight: 1.4 }],
      scoreSimilarity: 80,
      scoreTagAffinity: 26,
      scoreSeedCoverage: 14,
      scoreNovelty: 26,
      scorePopularityPenalty: 4,
      scoreTotal: 142,
      seedCount: 1,
      sourceType: "lastfm",
    },
  ];

  const deprioritized = rerankRecommendations(recommendations, 10, {
    discoveryMode: "balanced",
    feedback: [
      {
        id: "less-safe",
        artistId: "55555555-5555-5555-5555-555555555555",
        action: "less_like_this",
      },
    ],
  });
  assert.equal(deprioritized.length, 2);
  assert.equal(deprioritized[0].name, "Deeper Pick");
  assert.equal(
    deprioritized.some((item) => item.name === "Safe Pick"),
    true,
  );

  const blocked = rerankRecommendations(recommendations, 10, {
    discoveryMode: "balanced",
    feedback: [
      {
        id: "block-safe",
        artistId: "55555555-5555-5555-5555-555555555555",
        action: "block_artist",
      },
    ],
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].name, "Deeper Pick");

  const deeper = rerankRecommendations(recommendations, 2, {
    discoveryMode: "deeper",
  });
  assert.equal(deeper[0].name, "Deeper Pick");
});

test("mergeRetainedRecommendationPool preserves repeats and trims stale low scores", () => {
  const runStartedAt = "2026-06-18T00:00:00.000Z";
  const existingRecommendations = [
    {
      id: "77777777-7777-7777-7777-777777777777",
      name: "Returning Pick",
      matchedTags: ["dream-pop"],
      supportingSeeds: [{ artistName: "Seed One", weight: 1.6 }],
      scoreSimilarity: 80,
      scoreTagAffinity: 22,
      scoreSeedCoverage: 14,
      scoreNovelty: 6,
      scorePopularityPenalty: 4,
      scoreTotal: 118,
      seedCount: 2,
      firstDiscoveredAt: "2026-05-01T00:00:00.000Z",
      lastRecommendedAt: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "88888888-8888-8888-8888-888888888888",
      name: "Stale Weak Pick",
      matchedTags: ["indie"],
      supportingSeeds: [{ artistName: "Old Seed", weight: 0.8 }],
      scoreSimilarity: 8,
      scoreTagAffinity: 2,
      scoreSeedCoverage: 2,
      scoreNovelty: 1,
      scorePopularityPenalty: 0,
      scoreTotal: 13,
      seedCount: 1,
      firstDiscoveredAt: "2025-01-01T00:00:00.000Z",
      lastRecommendedAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  const freshRecommendations = [
    {
      id: "77777777-7777-7777-7777-777777777777",
      name: "Returning Pick",
      matchedTags: ["dream-pop", "shoegaze"],
      supportingSeeds: [{ artistName: "Seed Two", weight: 1.8 }],
      scoreSimilarity: 85,
      scoreTagAffinity: 24,
      scoreSeedCoverage: 16,
      scoreNovelty: 7,
      scorePopularityPenalty: 4,
      scoreTotal: 128,
      seedCount: 2,
    },
    {
      id: "99999999-9999-9999-9999-999999999999",
      name: "Fresh Pick",
      matchedTags: ["ethereal"],
      supportingSeeds: [{ artistName: "Fresh Seed", weight: 1.4 }],
      scoreSimilarity: 44,
      scoreTagAffinity: 12,
      scoreSeedCoverage: 8,
      scoreNovelty: 14,
      scorePopularityPenalty: 2,
      scoreTotal: 76,
      seedCount: 1,
    },
  ];

  const merged = mergeRetainedRecommendationPool({
    freshRecommendations,
    existingRecommendations,
    limit: 2,
    runStartedAt,
    discoveryMode: "balanced",
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((item) => item.name).sort(),
    ["Fresh Pick", "Returning Pick"],
  );
  const returning = merged.find((item) => item.name === "Returning Pick");
  assert.equal(returning.firstDiscoveredAt, "2026-05-01T00:00:00.000Z");
  assert.equal(returning.lastRecommendedAt, runStartedAt);
  assert.equal(
    merged.some((item) => item.name === "Stale Weak Pick"),
    false,
  );
});
