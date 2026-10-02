import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAlbumRequestPayload,
  buildArtistAddPayload,
  canRemoveLibraryAlbum,
  getAddToManagerLabel,
  getLibraryOwnerConflict,
  getMonitorOptionsForManager,
  resolveAlbumManager,
  resolveLibraryDestination,
} from "../../frontend/src/utils/libraryDestination.js";

test("Lidarr manages artists and albums when it is connected, otherwise Aurral does", () => {
  assert.deepEqual(resolveLibraryDestination({ lidarrConfigured: true }), { primary: "lidarr" });
  assert.deepEqual(resolveLibraryDestination({ lidarrConfigured: false }), { primary: "aurral" });
});

test("albums can only be removed through the active manager", () => {
  const aurralAlbum = { managedBy: "aurral", mbid: "rg1" };
  const lidarrAlbum = { managedBy: null, sources: ["lidarr"], mbid: "rg2" };
  assert.equal(canRemoveLibraryAlbum(aurralAlbum, "aurral"), true);
  assert.equal(canRemoveLibraryAlbum(aurralAlbum, "lidarr"), false);
  assert.equal(canRemoveLibraryAlbum(lidarrAlbum, "lidarr"), true);
  assert.equal(canRemoveLibraryAlbum(lidarrAlbum, "aurral"), false);
  assert.equal(canRemoveLibraryAlbum({ sources: ["lidarr"] }, "lidarr"), false);
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

test("an album without a recorded manager belongs to Lidarr when Lidarr has its files", () => {
  assert.equal(resolveAlbumManager({ managedBy: "aurral", sources: ["lidarr"] }), "aurral");
  assert.equal(resolveAlbumManager({ managedBy: null, sources: ["lidarr", "aurral"] }), "lidarr");
  assert.equal(resolveAlbumManager({ managedBy: null, sources: ["flow"] }), null);
  assert.equal(resolveAlbumManager(null), null);
});
