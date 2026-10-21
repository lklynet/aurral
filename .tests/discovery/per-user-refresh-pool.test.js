import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { importFromRepo } from "../helpers/backendTestHarness.js";
import { createDiscoveryArtistBatcher } from "../helpers/discoveryFixtures.js";

test("per-user refresh: rerankCachedRecommendations produces a personalized slice from the global pool", async () => {
  const { rerankCachedRecommendations } = await importFromRepo(
    "backend/services/discovery/index.js",
  );

  const globalPool = Array.from({ length: 300 }, (_, index) => {
    const padded = String(index).padStart(12, "0");
    return {
      id: `00000000-0000-4000-8000-${padded}`,
      name: `Global-Artist-${index}`,
      matchedTags: index % 3 === 0 ? ["shoegaze"] : ["indie"],
      supportingSeeds: [
        {
          artistName: index % 2 === 0 ? "Library-Seed" : "History-Seed-A",
          weight: 1,
        },
      ],
      scoreSimilarity: 200 - index,
      scoreTagAffinity: 15,
      scoreSeedCoverage: 10,
      scoreNovelty: 5,
      scorePopularityPenalty: 2,
      scoreTotal: 228 - index,
      seedCount: 1,
      sourceType: "lastfm",
    };
  });

  const userFeedback = [
    {
      id: "feedback-1",
      artistId: "00000000-0000-4000-8000-000000000000",
      action: "less_like_this",
    },
  ];

  const personalized = rerankCachedRecommendations({
    recommendations: globalPool,
    feedback: userFeedback,
    discoveryMode: "balanced",
    limit: 50,
  });

  assert.equal(personalized.length, 50);
  assert.equal(
    personalized.some((item) => item.id === "00000000-0000-4000-8000-000000000000"),
    true,
  );
  assert.ok(personalized[0].name !== "Global-Artist-0");
});

test("per-user refresh: user-specific feedback is isolated from global feedback", async () => {
  const { addDiscoveryFeedback, getDiscoveryFeedback, resetDiscoveryFeedback } =
    await importFromRepo("backend/services/discovery/index.js");

  resetDiscoveryFeedback("global");
  resetDiscoveryFeedback("user-abc");

  addDiscoveryFeedback("global", {
    id: "global-fb",
    artistId: "11111111-1111-1111-1111-111111111111",
    artistName: "Global Dislike",
    action: "less_like_this",
  });

  addDiscoveryFeedback("user-abc", {
    id: "user-fb",
    artistId: "22222222-2222-2222-2222-222222222222",
    artistName: "User Dislike",
    action: "less_like_this",
  });

  const globalFeedback = getDiscoveryFeedback("global");
  const userFeedback = getDiscoveryFeedback("user-abc");

  assert.ok(globalFeedback.some((entry) => entry.artistName === "Global Dislike"));
  assert.ok(userFeedback.some((entry) => entry.artistName === "User Dislike"));
  assert.equal(
    userFeedback.some((entry) => entry.artistName === "Global Dislike"),
    false,
  );

  resetDiscoveryFeedback("global");
  resetDiscoveryFeedback("user-abc");
});

test("per-user refresh: mergeRetainedRecommendationPool preserves per-user retained pool across refreshes", async () => {
  const { mergeRetainedRecommendationPool } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );
  const { rerankCachedRecommendations } = await importFromRepo(
    "backend/services/discovery/index.js",
  );

  const runStartedAt = "2026-06-22T00:00:00.000Z";

  const artists = createDiscoveryArtistBatcher("aaaaaaaa-aaaa-4000-8000");

  const perUserRetained = artists.makeBatch(80, 160, "per-user-retained");

  const globalPoolReranked = rerankCachedRecommendations({
    recommendations: artists.makeBatch(200, 220, "global-fresh"),
    feedback: [
      {
        id: "user-fb",
        artistId: "global-dislike",
        artistName: "Global Dislike",
        action: "less_like_this",
      },
    ],
    discoveryMode: "balanced",
    limit: 50,
  });

  const merged = mergeRetainedRecommendationPool({
    freshRecommendations: globalPoolReranked,
    existingRecommendations: perUserRetained,
    limit: 130,
    runStartedAt,
    discoveryMode: "balanced",
    feedback: [
      {
        id: "user-fb",
        artistId: "global-dislike",
        artistName: "Global Dislike",
        action: "less_like_this",
      },
    ],
  });

  assert.equal(merged.length, 130);

  const freshInOutput = merged.filter((item) => item.recommendationPoolState === "fresh");
  const retainedInOutput = merged.filter((item) => item.recommendationPoolState === "retained");

  assert.ok(freshInOutput.length > 0);
  assert.ok(retainedInOutput.length > 0);
  assert.equal(
    freshInOutput.every((item) => item.name.startsWith("global-fresh-")),
    true,
  );
  assert.equal(
    retainedInOutput.every((item) => item.name.startsWith("per-user-retained-")),
    true,
  );
});

test("per-user refresh: addDiscoveryFeedback deduplicates feedback per user", async () => {
  const { addDiscoveryFeedback, getDiscoveryFeedback } = await importFromRepo(
    "backend/services/discovery/index.js",
  );

  addDiscoveryFeedback("user-dedup", {
    id: "dedup-1",
    artistId: "artist-1",
    artistName: "Artist One",
    action: "more_like_this",
  });

  addDiscoveryFeedback("user-dedup", {
    id: "dedup-2",
    artistId: "artist-1",
    artistName: "Artist One",
    action: "more_like_this",
  });

  const deduped = getDiscoveryFeedback("user-dedup");
  const matches = deduped.filter(
    (entry) => entry.artistId === "artist-1" && entry.action === "more_like_this",
  );

  assert.equal(matches.length, 1);
});

test("per-user refresh: feedback boost affects reranking for per-user pool", async () => {
  const { rerankRecommendations } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );

  const recPool = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "MLR Target",
      matchedTags: ["shoegaze"],
      supportingSeeds: [{ artistName: "Seed", weight: 1 }],
      scoreSimilarity: 80,
      scoreTagAffinity: 20,
      scoreSeedCoverage: 10,
      scoreNovelty: 8,
      scorePopularityPenalty: 4,
      scoreTotal: 114,
      seedCount: 1,
      sourceType: "lastfm",
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Neutral Artist",
      matchedTags: ["indie"],
      supportingSeeds: [{ artistName: "Other Seed", weight: 1 }],
      scoreSimilarity: 80,
      scoreTagAffinity: 20,
      scoreSeedCoverage: 10,
      scoreNovelty: 8,
      scorePopularityPenalty: 4,
      scoreTotal: 114,
      seedCount: 1,
      sourceType: "lastfm",
    },
  ];

  const rankedWithFeedback = rerankRecommendations(recPool, 10, {
    discoveryMode: "balanced",
    feedback: [
      {
        id: "fb-mlr",
        artistId: "11111111-1111-1111-1111-111111111111",
        action: "more_like_this",
      },
    ],
  });

  assert.equal(rankedWithFeedback.length, 2);
  assert.equal(rankedWithFeedback[0].name, "MLR Target");
  assert.ok(rankedWithFeedback[0].scoreTotal > rankedWithFeedback[1].scoreTotal);
});
