import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { getListenbrainzRange } from "../backend/services/discovery/helpers.ts";
import {
  buildDiscoverySeedList,
  rerankRecommendations,
} from "../backend/services/discovery/recommendationPipeline.ts";
import { testDownloadClient } from "../backend/services/download/downloadClientSettings.ts";
import { getLinkedArtistProviderIds } from "../backend/services/providers/brainzmashMappers.ts";
import { getCapabilities } from "../backend/services/trackMatching/candidateNormalizer.ts";

test("testDownloadClient reports an unknown client for inherited object keys", async () => {
  for (const key of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(testDownloadClient(key), {
      message: `Unknown download client: ${key}`,
    });
  }
});

test("a listen history period named like an object member falls back to month", () => {
  assert.equal(getListenbrainzRange("constructor"), "month");
});

test("a discovery mode named like an object member ranks as balanced", () => {
  const recommendations = [
    { id: "a", name: "A", scoreSimilarity: 0.4, scoreTagAffinity: 0.2 },
    { id: "b", name: "B", scoreSimilarity: 0.1, scoreTagAffinity: 0.9 },
  ];
  const odd = rerankRecommendations(recommendations, 10, { discoveryMode: "constructor" });
  const balanced = rerankRecommendations(recommendations, 10, { discoveryMode: "balanced" });
  assert.deepEqual(
    odd.map((entry) => entry.id),
    balanced.map((entry) => entry.id),
  );
  assert.ok(odd.every((entry) => Number.isFinite(Number(entry.scoreTotal))));
});

test("a link host named like an object member yields no provider id", () => {
  assert.deepEqual(getLinkedArtistProviderIds([{ target: "https://constructor/artist/1" }]), []);
});

test("capabilities for a source named like an object member are the defaults", () => {
  assert.deepEqual(getCapabilities("constructor"), getCapabilities(""));
});

test("a seed source named like an object member weighs the same as any unknown source", () => {
  const [odd] = buildDiscoverySeedList({
    historyArtists: [{ artistName: "A", source: "constructor", playcount: 10 }],
  });
  const [unknown] = buildDiscoverySeedList({
    historyArtists: [{ artistName: "A", source: "unlisted", playcount: 10 }],
  });
  assert.ok(Number.isFinite(odd.weight));
  assert.equal(odd.weight, unknown.weight);
});
