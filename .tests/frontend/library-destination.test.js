import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAlbumRequestPayload,
  buildArtistAddPayload,
  getAddToManagerLabel,
  getLibraryOwnerConflict,
  getMonitorOptionsForManager,
  resolveLibraryDestination,
} from "../../frontend/src/utils/libraryDestination.js";

test("resolveLibraryDestination keeps Lidarr first for connected users without a preference", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: null, lidarrConfigured: true }),
    { primary: "lidarr", alternative: "aurral" },
  );
});

test("resolveLibraryDestination puts a saved Aurral preference first", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "aurral", lidarrConfigured: true }),
    { primary: "aurral", alternative: "lidarr" },
  );
});

test("resolveLibraryDestination offers only Aurral when Lidarr is unavailable", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: null, lidarrConfigured: false }),
    { primary: "aurral", alternative: null },
  );
});

test("resolveLibraryDestination falls back when the saved manager is unavailable", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "lidarr", lidarrConfigured: false }),
    { primary: "aurral", alternative: null },
  );
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "plex", lidarrConfigured: true }),
    { primary: "lidarr", alternative: "aurral" },
  );
});

test("add labels name each manager", () => {
  assert.equal(getAddToManagerLabel("aurral"), "Add to Aurral");
  assert.equal(getAddToManagerLabel("lidarr"), "Add to Lidarr");
});

const conflictError = (data, status = 409) => ({ response: { status, data } });

test("getLibraryOwnerConflict maps album and artist owner conflicts to the current manager", () => {
  assert.deepEqual(
    getLibraryOwnerConflict(conflictError({
      code: "album_owner_conflict",
      managedBy: "lidarr",
      availability: { available: false, trackCount: 12, availableTrackCount: 8 },
    })),
    { managedBy: "lidarr", label: "Managed by Lidarr", message: "Managed by Lidarr · 8 of 12 tracks" },
  );
  assert.deepEqual(
    getLibraryOwnerConflict(conflictError({ code: "artist_owner_conflict", managedBy: "aurral" })),
    { managedBy: "aurral", label: "Managed by Aurral", message: "Managed by Aurral" },
  );
  assert.equal(
    getLibraryOwnerConflict(conflictError({
      code: "album_owner_conflict",
      conflict: { managedBy: "aurral", availability: { available: true } },
    }))?.message,
    "Managed by Aurral · Available",
  );
});

test("getLibraryOwnerConflict leaves other failures as errors", () => {
  assert.equal(getLibraryOwnerConflict(conflictError({ code: "album_owner_conflict", managedBy: "lidarr" }, 500)), null);
  assert.equal(getLibraryOwnerConflict(conflictError({ code: "invalid_library_manager" })), null);
  assert.equal(getLibraryOwnerConflict(conflictError({ code: "album_owner_conflict", managedBy: null })), null);
  assert.equal(getLibraryOwnerConflict(new Error("Network Error")), null);
});

test("buildArtistAddPayload sends the chosen manager and keeps Lidarr options away from Aurral", () => {
  const lidarrOptions = { rootFolderPath: "/music", qualityProfileId: 2, tagId: 5 };
  assert.deepEqual(
    buildArtistAddPayload({ artistMbid: "a1", artistName: "Artist", managedBy: "aurral", lidarrOptions }),
    { foreignArtistId: "a1", artistName: "Artist", managedBy: "aurral" },
  );
  assert.deepEqual(
    buildArtistAddPayload({ artistMbid: "a1", artistName: "Artist", managedBy: "lidarr", lidarrOptions }),
    { foreignArtistId: "a1", artistName: "Artist", managedBy: "lidarr", ...lidarrOptions },
  );
});

test("buildAlbumRequestPayload sends the chosen manager", () => {
  assert.deepEqual(
    buildAlbumRequestPayload({
      albumMbid: "rg1",
      albumName: "Album",
      artistMbid: "a1",
      artistName: "Artist",
      managedBy: "aurral",
    }),
    {
      albumMbid: "rg1",
      albumName: "Album",
      artistMbid: "a1",
      artistName: "Artist",
      managedBy: "aurral",
      triggerSearch: false,
    },
  );
});

test("getMonitorOptionsForManager never offers existing to Aurral", () => {
  const options = [{ value: "none" }, { value: "existing" }, { value: "all" }];
  assert.deepEqual(
    getMonitorOptionsForManager(options, "aurral").map((option) => option.value),
    ["none", "all"],
  );
  assert.deepEqual(getMonitorOptionsForManager(options, "lidarr"), options);
});
