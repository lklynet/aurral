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

test("startup restores a missing search index trigger", async () => {
  const { initializeLibrarySearchIndex } = await importFromRepo(
    "backend/config/library-search-index.js",
  );
  db.exec("DROP TRIGGER library_search_documents_ai");

  assert.equal(initializeLibrarySearchIndex(db), true);
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'library_search_documents_ai'",
  ).get());
});

test("startup rebuilds search documents when their version is outdated", async () => {
  const { initializeLibrarySearchIndex } = await importFromRepo(
    "backend/config/library-search-index.js",
  );
  db.prepare(
    "INSERT INTO library_search_documents (entity_kind, entity_id, title) VALUES ('artist', 999, 'Stale Artist')",
  ).run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'librarySearchIndexVersion'").run();

  assert.equal(initializeLibrarySearchIndex(db), true);
  assert.equal(db.prepare("SELECT 1 FROM library_search_documents WHERE entity_id = 999").get(), undefined);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'librarySearchIndexVersion'").get().value, "2");
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
