import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import type { hc, InferResponseType } from "hono/client";
import type discoveryApp from "../../backend/routes/discovery/index.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  persistedDiscovery,
  { getUserDiscovery },
  discovery,
  libraryStore,
  { api },
] = await setupIsolatedBackend(
  "user-discovery",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/discovery/persistence.ts"),
  () => import("../../backend/services/discovery/userDiscovery.ts"),
  () => import("../../backend/services/discovery/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/routes/api.ts"),
);

type DiscoverBody = InferResponseType<
  ReturnType<typeof hc<typeof discoveryApp>>["discover"]["$get"],
  200
>;

beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
afterAll(() => cleanupIsolatedState(state));

test("cached discovery excludes library identities and paginates the remaining recommendations", async () => {
  db.prepare(`INSERT INTO library_artists (id, identity_key, mbid, name, metadata_json, created_at, updated_at)
    VALUES (41, 'provider-key', 'library-mbid', 'Library Artist', ?, 1, 1)`).run(
    JSON.stringify({ foreignArtistId: "provider-id" }),
  );
  dbOps.updateDiscoveryCache({
    recommendations: [
      { id: "41", name: "Canonical Alias" },
      { id: "library-mbid", name: "Mbid Alias" },
      { foreignArtistId: "provider-id", name: "Provider Alias" },
      { name: "library artist" },
      { id: "first", name: "First", scoreTotal: 10 },
      { id: "second", name: "Second", scoreTotal: 1 },
    ],
    globalTop: [{ name: "Library Artist" }, { name: "Global" }],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const { body } = await getUserDiscovery(7, 1, 1);
  assert.equal(body.recommendationCount, 2);
  assert.deepEqual(
    body.recommendations.map((artist) => artist.name),
    ["Second"],
  );
  assert.deepEqual(
    body.globalTop.map((artist) => artist.name),
    ["Global"],
  );
  db.prepare("DELETE FROM library_artists").run();
  assert.equal((await getUserDiscovery(7, 0)).body.recommendationCount, 6);
});

test("cached discovery applies per-user blocks to recommendations and trending artists", async () => {
  dbOps.updateDiscoveryCache({
    recommendations: [{ name: "Allowed" }, { name: "Blocked" }],
    globalTop: [{ name: "Blocked" }],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const block = discovery.addDiscoveryFeedback(7, {
    artistName: "Blocked",
    action: "block_artist",
  });
  const { body } = await getUserDiscovery(7, 0);
  assert.deepEqual(
    body.recommendations.map((artist) => artist.name),
    ["Allowed"],
  );
  assert.equal(body.globalTop.length, 0);
  assert.equal((await getUserDiscovery(8, 0)).body.globalTop.length, 1);
  discovery.removeDiscoveryFeedback(7, block.id);
  assert.equal((await getUserDiscovery(7, 0)).body.globalTop.length, 1);
});

test("cached discovery hides an artist once the library learns its MBID", async () => {
  const mbid = "00000000-0000-4000-8000-000000000041";
  libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildFallbackIdentityKey("artist", "Artist X"),
    name: "Artist X",
  });
  db.prepare(`INSERT INTO library_artists (identity_key, name, created_at, updated_at)
    VALUES ('newest-write', 'Newest Write', 1, 9000000000000000)`).run();
  dbOps.updateDiscoveryCache({ recommendations: [{ id: mbid, name: "Artist X (alias)" }] });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  assert.equal((await getUserDiscovery(7, 0)).body.recommendationCount, 1);

  libraryStore.upsertLibraryArtist({ identityKey: mbid, mbid, name: "Artist X" });
  assert.equal((await getUserDiscovery(7, 0)).body.recommendationCount, 0);
});

test("served picks say whether they came through another pick and when they were first seen", async () => {
  dbOps.updateDiscoveryCache({
    recommendations: [
      {
        id: "direct",
        name: "Direct",
        discoveryDepth: 1,
        firstDiscoveredAt: "2026-10-01T00:00:00.000Z",
      },
      { id: "bridged", name: "Bridged", discoveryDepth: 2 },
    ],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const response = await signedInAs(testUser(7)).route("/", api).request("/discover");
  const body: DiscoverBody = await response.json();
  assert.deepEqual(
    Object.fromEntries(
      body.recommendations.map((artist) => [
        artist.name,
        [artist.discoveryDepth, artist.firstDiscoveredAt],
      ]),
    ),
    { Direct: [1, "2026-10-01T00:00:00.000Z"], Bridged: [2, null] },
  );
});
