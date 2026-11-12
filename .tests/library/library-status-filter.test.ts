import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { isUnreleased } from "../../lib/releaseDate.ts";
import type { LibraryStatus } from "../../lib/libraryStatus.ts";

const [state, store, { setLibraryManagement }, { getLibraryPage, LIBRARY_VIEW }] =
  await setupIsolatedBackend(
    "library-status-filter",
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/libraryManagementStore.ts"),
    () => import("../../backend/services/libraryQueryService.ts"),
  );
afterAll(() => cleanupIsolatedState(state));

const addAlbum = (
  artistId: number,
  title: string,
  {
    tracks,
    files,
    managed = null,
    metadata = null,
    releaseDate = null,
  }: {
    tracks: number;
    files: number;
    managed?: string | null;
    metadata?: Record<string, unknown> | null;
    releaseDate?: string | null;
  },
) => {
  const album = store.upsertLibraryAlbum({
    identityKey: `status:${title}`,
    artistId,
    title,
    releaseDate,
    metadata,
  });
  for (let index = 0; index < tracks; index += 1) {
    const track = store.upsertLibraryTrack({
      identityKey: `status:${title}:${index}`,
      title: `${title} ${index}`,
    });
    store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
    if (index < files) {
      store.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "aurral",
        path: `/status/${title}/${index}.flac`,
      });
    }
  }
  if (managed)
    setLibraryManagement({ entityKind: "album", entityId: album.id, monitorMode: managed });
  return album;
};

test("status filters split albums and artists by monitoring and by the partial count cards show", () => {
  const followed = store.upsertLibraryArtist({ identityKey: "status:followed", name: "Followed" });
  setLibraryManagement({
    entityKind: "artist",
    entityId: followed.id,
    monitorRules: { default: true },
  });
  const imported = store.upsertLibraryArtist({ identityKey: "status:imported", name: "Imported" });
  const finished = store.upsertLibraryArtist({ identityKey: "status:finished", name: "Finished" });

  const monitored = { monitored: true, librarySource: "aurral" };
  addAlbum(followed.id, "Complete", {
    tracks: 2,
    files: 2,
    managed: "monitored",
    metadata: monitored,
  });
  addAlbum(followed.id, "Partial", {
    tracks: 3,
    files: 1,
    managed: "monitored",
    metadata: monitored,
  });
  addAlbum(followed.id, "Upcoming", {
    tracks: 2,
    files: 0,
    managed: "monitored",
    metadata: monitored,
    releaseDate: "2999-01-01",
  });
  addAlbum(imported.id, "Loose", { tracks: 2, files: 1 });
  addAlbum(imported.id, "Paused", {
    tracks: 1,
    files: 1,
    managed: "unmonitored",
    metadata: { monitored: true },
  });
  addAlbum(finished.id, "Whole", { tracks: 1, files: 1 });

  const titles = (status?: LibraryStatus) =>
    getLibraryPage({ kind: "albums", availableOnly: LIBRARY_VIEW, pageSize: 100, status })
      .items.map((album) => album.title)
      .sort();
  const names = (status?: LibraryStatus) =>
    getLibraryPage({ kind: "artists", availableOnly: LIBRARY_VIEW, pageSize: 100, status })
      .items.map((artist) => artist.name)
      .sort();

  assert.deepEqual(titles("monitored"), ["Complete", "Partial", "Upcoming"]);
  assert.deepEqual(titles("unmonitored"), ["Loose", "Paused", "Whole"]);
  assert.deepEqual(titles("missing"), ["Loose", "Partial"]);
  assert.deepEqual(
    titles("missing"),
    getLibraryPage({ kind: "albums", availableOnly: LIBRARY_VIEW, pageSize: 100 })
      .items.filter(
        (album) =>
          album.availableTrackCount < album.trackCount &&
          !(album.managed && isUnreleased(album.releaseDate)),
      )
      .map((album) => album.title)
      .sort(),
  );

  assert.deepEqual(names("monitored"), ["Followed"]);
  assert.deepEqual(names("unmonitored"), ["Finished", "Imported"]);
  assert.deepEqual(names("missing"), ["Followed", "Imported"]);
  assert.deepEqual(names(), ["Finished", "Followed", "Imported"]);
});
