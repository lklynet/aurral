import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { selectDiscoverySeeds, STARTER_SEED_SOURCE },
  discovery,
  { getUserDiscovery },
] = await setupIsolatedBackend(
  "starter-seeds",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/discovery/recommendationPipeline.ts"),
  () => import("../../backend/services/discovery/index.ts"),
  () => import("../../backend/services/discovery/userDiscovery.ts"),
);

const artists = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ artistName: `${prefix} ${index}` }));

const starterNames = (seeds: ReturnType<typeof selectDiscoverySeeds>) =>
  seeds.filter((seed) => seed.source === STARTER_SEED_SOURCE).map((seed) => seed.artistName);

test("chart starters fill empty seed slots and drop out as personal seeds arrive", () => {
  const starterArtists = [{ artistName: "Played 0" }, ...artists("Chart", 40)];

  assert.equal(starterNames(selectDiscoverySeeds({ starterArtists })).length, 24);

  const someHistory = selectDiscoverySeeds({
    historyArtists: artists("Played", 4),
    starterArtists,
    excludedKeys: new Set(["name:chart 0"]),
  });
  assert.equal(someHistory.length, 24);
  assert.deepEqual(
    starterNames(someHistory).sort(),
    artists("Chart", 21)
      .slice(1)
      .map((artist) => artist.artistName)
      .sort(),
  );

  const fullHistory = selectDiscoverySeeds({
    historyArtists: artists("Played", 30),
    starterArtists,
  });
  assert.deepEqual(starterNames(fullHistory), []);
});

const similarMbids = new Map(
  ["Chart Star", "Jazz Lead", "Jazz Second"].map((name, index) => [
    name,
    `00000000-0000-4000-8000-00000000000${index + 1}`,
  ]),
);
const originalFetch = globalThis.fetch;
const originalLastfmApiKey = process.env.LASTFM_API_KEY;

beforeAll(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  process.env.LASTFM_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    const body =
      params.get("method") === "artist.getSimilar"
        ? {
            similarartists: {
              artist: [
                {
                  name: `Like ${params.get("artist")}`,
                  mbid: similarMbids.get(params.get("artist") ?? ""),
                  match: "0.9",
                },
              ],
            },
          }
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const saveChart = db.prepare(
    "INSERT INTO trending_charts (chart, region, updated_at, data) VALUES (?, 'US', 1, ?)",
  );
  saveChart.run(
    "artists",
    JSON.stringify({
      items: [{ key: "1", name: "Chart Star", imageUrl: null, fans: null, mbid: null }],
    }),
  );
  saveChart.run(
    "genre:129",
    JSON.stringify({
      name: "Jazz",
      items: ["Jazz Lead", "Jazz Lead", "Jazz Second"].map((artistName, index) => ({
        key: String(index),
        trackName: `Song ${index}`,
        artistName,
        albumName: null,
        deezerAlbumId: null,
        durationMs: null,
        artworkUrl: null,
        largeArtworkUrl: null,
        preview_url: null,
      })),
    }),
  );
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("a new user with no music or history gets recommendations from current charts", async () => {
  const user = userOps.createUser("newcomer", "hash");
  assert.ok(user);

  await discovery.updateUserDiscoveryCache(user.id);

  const { body } = getUserDiscovery(user.id, 0);
  assert.deepEqual(body.recommendations.map((artist) => artist.name).sort(), [
    "Like Chart Star",
    "Like Jazz Lead",
    "Like Jazz Second",
  ]);
  assert.deepEqual(body.basedOn, []);
});
