import { test } from "vite-plus/test";
import assert from "node:assert/strict";

test("tag inheritance requires three seed tags and skips directly hydrated candidates", async () => {
  const { canInheritTagsFromSeeds } = await import("../../backend/services/discovery/index.ts");

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

test("tag inheritance: ranking scores are equivalent between inherited and direct tags with same tag data", async () => {
  const { applyHydratedCandidateTags } =
    await import("../../backend/services/discovery/recommendationPipeline.ts");

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
  assert.ok(inherited.matchedTags != null);
  assert.ok(direct.matchedTags != null);
  assert.deepEqual(inherited.matchedTags.sort(), direct.matchedTags.sort());
});
