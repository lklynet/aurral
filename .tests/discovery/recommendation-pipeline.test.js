import test from "node:test";
import assert from "node:assert/strict";

import {
  addRecommendationCandidate,
  buildDiscoverySeedList,
  finalizeRecommendationAccumulator,
  mergeResolvedRecommendations,
  rerankRecommendations,
} from "../../backend/services/discoveryRecommendations.js";

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

test("rerankRecommendations can deprioritize feedback and favor deeper mode diversification", () => {
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

  const deeper = rerankRecommendations(recommendations, 2, {
    discoveryMode: "deeper",
  });
  assert.equal(deeper[0].name, "Deeper Pick");
});
