import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  importFromRepo,
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("single-pass-refresh");

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
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
