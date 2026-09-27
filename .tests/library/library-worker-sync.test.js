import assert from "node:assert/strict";
import { test } from "node:test";

test("completed child scans invalidate the API's library cache", async () => {
  const { db } = await import("../../backend/config/db-sqlite.js");
  const {
    linkLibraryAlbumTrack,
    upsertLibraryAlbum,
    upsertLibraryArtist,
    upsertLibraryMediaFile,
    upsertLibraryTrack,
  } = await import("../../backend/services/libraryMediaStore.js");
  const { getCanonicalLibrary } = await import("../../backend/services/libraryQueryService.js");
  const { forwardWorkerBroadcast } = await import("../../backend/services/appRuntime.js");
  const key = `worker-cache-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Before Scan" });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`, artistId: artist.id, title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`, title: "Track", artistName: "Before Scan",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id, albumId: album.id, source: "aurral",
    path: `/${key}.flac`, available: true,
  });
  const artistName = () => getCanonicalLibrary().artists.find((item) => item.id === artist.id)?.name;
  assert.equal(artistName(), "Before Scan");
  db.prepare("UPDATE library_artists SET name = ? WHERE id = ?").run("After Scan", artist.id);
  assert.equal(artistName(), "Before Scan");

  await forwardWorkerBroadcast({
    type: "websocket-broadcast",
    channel: "library",
    data: { type: "library_scan_completed" },
  });
  assert.equal(artistName(), "After Scan");
});
