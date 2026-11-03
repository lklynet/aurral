import { requireFixture } from "../playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import Database from "better-sqlite3";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { db }, store, { getLibraryPage }] = await setupIsolatedBackend(
  "library-page-totals",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test("page totals stay exact after local writes, worker commits, and rollbacks", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "totals:artist", name: "Totals Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: "totals:album",
    artistId: artist.id,
    title: "Totals Album",
  });
  const track = store.upsertLibraryTrack({ identityKey: "totals:track", title: "Totals Track" });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const options = { kind: "tracks", artistId: artist.id, pageSize: 1, availableOnly: true };
  const read = () => getLibraryPage(options);
  assert.equal(read().total, 0);
  assert.equal(read().total, 0);

  store.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: "/totals/track.flac",
  });
  assert.equal(read().total, 1);
  assert.equal(read().hasMore, false);
  assert.equal(getLibraryPage({ ...options, source: "lidarr" }).total, 0);
  assert.equal(read().total, 1);

  const worker = new Database(state.dbPath);
  try {
    worker.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 0);
    assert.deepEqual([...read().items], []);
    assert.equal(getLibraryPage({ ...options, availableOnly: false }).total, 1);
    worker.prepare("UPDATE library_media_files SET available = 1 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 1);

    db.exec("BEGIN");
    db.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 0);
    db.exec("ROLLBACK");
    assert.equal(read().total, 1);
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    worker.close();
  }
});

test("broad search keeps stable ordering, page boundaries, and playable source filters", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "broad:artist", name: "Broad Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: "broad:album",
    artistId: artist.id,
    title: "Broad Album",
  });
  const tracks: { id: number; title: string; source: string; available: boolean }[] = [];
  db.transaction(() => {
    for (let index = 0; index < 1105; index += 1) {
      const title = `${index % 2 ? "match" : "Match"} ${String(Math.floor(index / 3)).padStart(4, "0")}`;
      const track = store.upsertLibraryTrack({ identityKey: `broad:${index}`, title });
      store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
      const source = index % 4 === 0 ? "lidarr" : "aurral";
      const available = index % 11 !== 0;
      store.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source,
        available,
        path: `/broad/${index}.flac`,
      });
      tracks.push({ id: track.id, title, source, available });
    }
  })();
  const ordered = tracks.sort(
    (left, right) =>
      left.title.toLowerCase().localeCompare(right.title.toLowerCase()) || left.id - right.id,
  );
  for (const direction of ["asc", "desc"]) {
    for (const filters of [{}, { source: "aurral", availableOnly: true }]) {
      const eligible = ordered.filter(
        (track) => !filters.source || (track.source === filters.source && track.available),
      );
      if (direction === "desc") eligible.reverse();
      for (const page of [1, 6, 11, 12]) {
        const result = getLibraryPage({
          kind: "tracks",
          query: "match",
          direction,
          page,
          pageSize: 100,
          ...filters,
        });
        assert.equal(result.total, eligible.length);
        assert.equal(result.hasMore, page * 100 < eligible.length);
        assert.deepEqual(
          result.items.map((item) => item.id),
          eligible.slice((page - 1) * 100, page * 100).map((track) => track.id),
        );
      }
    }
  }
});

test("an album track page carries the album's provider id and monitored state", () => {
  const artist = store.upsertLibraryArtist({
    identityKey: "summary:artist",
    name: "Summary Artist",
    metadata: { id: 41, monitored: true },
  });
  const album = store.upsertLibraryAlbum({
    identityKey: "summary:album",
    artistId: artist.id,
    title: "Summary Album",
    metadata: { id: 512, monitored: true, monitor: "all" },
  });
  const track = store.upsertLibraryTrack({ identityKey: "summary:track", title: "Summary Track" });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });

  const page = getLibraryPage({ kind: "tracks", albumId: album.id, availableOnly: false });
  const summaryAlbum = requireFixture(page.albums[0]);
  assert.equal(summaryAlbum.canonicalId, String(album.id));
  assert.equal(summaryAlbum.providerId, 512);
  assert.equal(summaryAlbum.monitored, true);
  assert.equal(summaryAlbum.monitorOption, "all");
  const summaryArtist = requireFixture(page.artists[0]);
  assert.equal("providerId" in summaryArtist && summaryArtist.providerId, 41);
  assert.equal("monitored" in summaryArtist && summaryArtist.monitored, true);
});

test("an album track page opens by its release-group MBID, and an unknown MBID finds nothing", () => {
  const releaseGroupMbid = "c3333333-3333-4333-8333-333333333301";
  const artist = store.upsertLibraryArtist({ identityKey: "rg:artist", name: "RG Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: `release-group:${releaseGroupMbid}`,
    artistId: artist.id,
    title: "RG Album",
    releaseGroupMbid,
  });
  const track = store.upsertLibraryTrack({ identityKey: "rg:track", title: "RG Track" });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });

  const page = getLibraryPage({ kind: "tracks", albumId: releaseGroupMbid, availableOnly: false });
  assert.deepEqual(
    page.albums.map((entry) => entry.canonicalId),
    [String(album.id)],
  );
  assert.deepEqual(
    page.tracks.map((entry) => entry.title),
    ["RG Track"],
  );
  const missing = getLibraryPage({
    kind: "tracks",
    albumId: "c3333333-3333-4333-8333-333333333399",
    availableOnly: false,
  });
  assert.equal(missing.albums.length, 0);
  assert.equal(missing.tracks.length, 0);
});
