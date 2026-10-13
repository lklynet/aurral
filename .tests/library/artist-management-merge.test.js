import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, managementStore] = await setupIsolatedBackend(
  "artist-management-merge",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
);

test.after(() => cleanupIsolatedState(isolatedState));

test("merging an artist into its MBID identity retains management settings", () => {
  resetDatabase(db);
  const mbid = "11111111-1111-4111-8111-111111111111";
  const fallback = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildFallbackIdentityKey("artist", "Example Artist"),
    name: "Example Artist",
    syncSearch: false,
  });
  const resolved = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Former Name",
    syncSearch: false,
  });
  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: fallback.id,
    managedBy: "aurral",
    monitorMode: "all",
  });

  libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Example Artist",
    syncSearch: false,
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM library_artists").get().count, 1);
  const management = managementStore.getLibraryManagementEntry("artist", resolved.id);
  assert.equal(management?.managedBy, "aurral");
  assert.equal(management?.monitorMode, "all");
  assert.equal(managementStore.getLibraryManagementEntry("artist", fallback.id), null);
});

test("a canonical artist's management choice wins during a merge", () => {
  resetDatabase(db);
  const mbid = "22222222-2222-4222-8222-222222222222";
  const fallback = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildFallbackIdentityKey("artist", "Example Artist"),
    name: "Example Artist",
    syncSearch: false,
  });
  const resolved = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Former Name",
    syncSearch: false,
  });
  managementStore.setLibraryManagement({
    entityKind: "artist", entityId: fallback.id, managedBy: "aurral", monitorMode: "all",
  });
  managementStore.setLibraryManagement({
    entityKind: "artist", entityId: resolved.id, managedBy: "lidarr",
  });

  libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Example Artist",
    syncSearch: false,
  });

  assert.equal(managementStore.getLibraryManagementEntry("artist", resolved.id)?.managedBy, "lidarr");
  assert.equal(managementStore.getLibraryManagementEntry("artist", fallback.id), null);
});
