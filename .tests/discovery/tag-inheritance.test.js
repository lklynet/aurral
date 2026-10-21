import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { importFromRepo } from "../helpers/backendTestHarness.js";

test("tag inheritance requires three seed tags and skips directly hydrated candidates", async () => {
  const { canInheritTagsFromSeeds } = await importFromRepo("backend/services/discovery/index.js");

  assert.equal(canInheritTagsFromSeeds({ tags: ["shoegaze", "indie"] }), false);
  assert.equal(canInheritTagsFromSeeds({ tags: ["shoegaze", "dream-pop", "indie"] }), true);
  assert.equal(
    canInheritTagsFromSeeds({
      tags: ["shoegaze", "dream-pop", "indie"],
      candidateTagsHydrated: true,
      tagSource: "lastfm_artist",
    }),
    false,
  );
});

test("tag inheritance: inherited tags produce tagSource: inherited and keep existing scores stable", async () => {
  const { applyHydratedCandidateTags } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );

  const profileTagWeights = new Map([
    ["shoegaze", 5],
    ["dream-pop", 3],
    ["noise-rock", 2],
    ["indie", 8],
  ]);

  const candidate = {
    id: "cand-4",
    name: "Inherit Test",
    tags: ["shoegaze", "dream-pop", "noise-rock"],
    matchedTags: ["shoegaze", "dream-pop"],
    scoreTagAffinity: 35,
    scoreTotal: 180,
    scoreSeedCoverage: 12,
    scoreNovelty: 8,
    scorePopularityPenalty: 4,
    seedCount: 1,
    discoveryDepth: 1,
    sourceType: "lastfm",
    supportingSeeds: [{ artistName: "Seed", weight: 1 }],
  };

  const inherited = applyHydratedCandidateTags(candidate, candidate.tags, profileTagWeights, {
    source: "inherited",
  });

  assert.equal(inherited.tagSource, "inherited");
  assert.equal(inherited.candidateTagsHydrated, true);
  assert.ok(inherited.scoreTagAffinity >= 30);
  assert.ok(inherited.matchedTags.includes("shoegaze"));

  const direct = applyHydratedCandidateTags(candidate, candidate.tags, profileTagWeights);

  assert.equal(direct.tagSource, "lastfm_artist");
});

test("tag inheritance: multi-seed candidate merges tags from all contributing seeds", async () => {
  const { addRecommendationCandidate, finalizeRecommendationAccumulator } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );

  const accumulator = new Map();
  const profileTagWeights = new Map([
    ["shoegaze", 5],
    ["dream-pop", 3],
    ["indie", 8],
    ["post-punk", 4],
  ]);

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "multi-mbid-1",
      name: "Multi Seed Candidate",
      match: 0.75,
      discoveryDepth: 1,
    },
    seed: {
      artistName: "Seed A",
      mbid: "seed-a-mbid",
      source: "library",
      weight: 1.2,
      profileBucket: "top",
    },
    sourceTags: ["shoegaze", "dream-pop", "noise-rock"],
    profileTagWeights,
  });

  addRecommendationCandidate(accumulator, {
    candidate: {
      mbid: "multi-mbid-1",
      name: "Multi Seed Candidate",
      match: 0.68,
      discoveryDepth: 1,
    },
    seed: {
      artistName: "Seed B",
      mbid: "seed-b-mbid",
      source: "history",
      weight: 1,
      profileBucket: "high",
    },
    sourceTags: ["indie", "post-punk"],
    profileTagWeights,
  });

  const final = finalizeRecommendationAccumulator(accumulator, 50, {
    discoveryMode: "balanced",
  });

  assert.equal(final.length, 1);
  const entry = final[0];
  assert.ok(entry.tags.includes("shoegaze"));
  assert.ok(entry.tags.includes("indie"));
  assert.ok(entry.supportingSeeds.length >= 2);
  assert.ok(entry.scoreSimilarity > 0);
});

test("tag inheritance: ranking scores are equivalent between inherited and direct tags with same tag data", async () => {
  const { applyHydratedCandidateTags } = await importFromRepo(
    "backend/services/discovery/recommendationPipeline.js",
  );

  const profileTagWeights = new Map([
    ["shoegaze", 5],
    ["dream-pop", 3],
    ["indie", 8],
  ]);

  const tags = ["shoegaze", "dream-pop", "indie"];

  const candidateA = {
    id: "rank-a",
    name: "Rank A",
    tags,
    matchedTags: ["shoegaze", "dream-pop"],
    scoreTagAffinity: 33,
    scoreTotal: 180,
    scoreSeedCoverage: 12,
    scoreNovelty: 8,
    scorePopularityPenalty: 4,
    seedCount: 1,
    discoveryDepth: 1,
    sourceType: "lastfm",
    supportingSeeds: [{ artistName: "Seed", weight: 1 }],
  };

  const candidateB = {
    ...candidateA,
    id: "rank-b",
    name: "Rank B",
  };

  const inherited = applyHydratedCandidateTags(candidateA, tags, profileTagWeights, {
    source: "inherited",
  });
  const direct = applyHydratedCandidateTags(candidateB, tags, profileTagWeights);

  assert.equal(inherited.scoreTagAffinity, direct.scoreTagAffinity);
  assert.equal(inherited.scoreTotal, direct.scoreTotal);
  assert.deepEqual(inherited.matchedTags.sort(), direct.matchedTags.sort());
});
