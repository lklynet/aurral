import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  importFromRepo,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "library-search-index",
  "backend/config/db-sqlite.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("search index service remains usable when the FTS schema is unavailable", async () => {
  db.exec(`
    DROP TRIGGER IF EXISTS library_search_documents_ai;
    DROP TRIGGER IF EXISTS library_search_documents_au;
    DROP TRIGGER IF EXISTS library_search_documents_ad;
    DROP TABLE IF EXISTS library_search_fts;
    DROP TABLE IF EXISTS library_search_documents;
  `);

  const searchIndex = await importFromRepo("backend/services/librarySearchIndex.js");

  assert.equal(searchIndex.getLibrarySearchMatch("artist"), null);
  assert.equal(searchIndex.syncLibrarySearchArtist(1), false);
  assert.equal(searchIndex.syncLibrarySearchAlbum(1), false);
  assert.equal(searchIndex.syncLibrarySearchTrack(1), false);
  assert.equal(searchIndex.rebuildLibrarySearchIndex(), false);
});
