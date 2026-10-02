import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, persistedDiscovery, { getUserDiscovery }, discovery] = await setupIsolatedBackend(
  "user-discovery", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/discovery/persistence.js", "backend/services/discovery/userDiscovery.js", "backend/services/discovery/index.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
test.after(() => cleanupIsolatedState(state));

test("cached discovery excludes library identities and paginates the remaining recommendations", async () => {
  db.prepare(`INSERT INTO library_artists (id, identity_key, mbid, name, metadata_json, created_at, updated_at)
    VALUES (41, 'provider-key', 'library-mbid', 'Library Artist', ?, 1, 1)`)
    .run(JSON.stringify({ foreignArtistId: "provider-id" }));
  dbOps.updateDiscoveryCache({
    recommendations: [
      { id: "41", name: "Canonical Alias" }, { id: "library-mbid", name: "Mbid Alias" },
      { foreignArtistId: "provider-id", name: "Provider Alias" }, { name: "library artist" },
      { id: "first", name: "First", scoreTotal: 10 }, { id: "second", name: "Second", scoreTotal: 1 },
    ], globalTop: [{ name: "Library Artist" }, { name: "Global" }],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const { body } = await getUserDiscovery(7, 1, 1);
  assert.equal(body.recommendationCount, 2);
  assert.deepEqual(body.recommendations.map((artist) => artist.name), ["Second"]);
  assert.deepEqual(body.globalTop.map((artist) => artist.name), ["Global"]);
  db.prepare("DELETE FROM library_artists").run();
  assert.equal((await getUserDiscovery(7, 0)).body.recommendationCount, 6);
});

test("cached discovery applies per-user blocks to recommendations and fallback sections", async () => {
  dbOps.updateDiscoveryCache({
    recommendations: [{ name: "Allowed" }, { name: "Blocked" }],
    globalTop: [{ name: "Blocked" }],
    fallbackGenres: [{ name: "Genre", artists: [{ name: "Blocked" }, { name: "Allowed" }] }],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const block = discovery.addDiscoveryFeedback(7, { artistName: "Blocked", action: "block_artist" });
  const { body } = await getUserDiscovery(7, 0);
  assert.deepEqual(body.recommendations.map((artist) => artist.name), ["Allowed"]);
  assert.equal(body.globalTop.length, 0);
  assert.deepEqual(body.fallbackGenres[0].artists.map((artist) => artist.name), ["Allowed"]);
  assert.equal((await getUserDiscovery(8, 0)).body.globalTop.length, 1);
  discovery.removeDiscoveryFeedback(7, block.id);
  assert.equal((await getUserDiscovery(7, 0)).body.globalTop.length, 1);
});
