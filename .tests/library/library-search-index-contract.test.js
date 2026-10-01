import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupIsolatedState,
  importFromRepo,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, searchIndex] = await setupIsolatedBackend(
  "library-search-index-contract",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/librarySearchIndex.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("album and track search syncs report changed and unchanged documents", () => {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "search-contract:artist",
    mbid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Search Contract Artist",
    syncSearch: false,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "search-contract:album",
    artistId: artist.id,
    title: "Search Contract Album",
    albumArtist: artist.name,
    syncSearch: false,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "search-contract:track",
    title: "Search Contract Track",
    artistName: artist.name,
    syncSearch: false,
  });
  libraryStore.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: track.id,
    syncSearch: false,
  });

  assert.equal(searchIndex.syncLibrarySearchAlbum(album.id), true);
  assert.equal(searchIndex.syncLibrarySearchAlbum(album.id), false);
  assert.equal(searchIndex.syncLibrarySearchTrack(track.id), true);
  assert.equal(searchIndex.syncLibrarySearchTrack(track.id), false);

  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM library_search_documents WHERE entity_id IN (?, ?)",
    ).get(album.id, track.id).count,
    2,
  );
});

test("targeted configured rescans update related searches and preserve failed or untouched files", async () => {
  const { getCanonicalLibraryPage } = await importFromRepo("backend/services/libraryQueryService.js");
  const { scanConfiguredLibrary } = await importFromRepo("backend/services/libraryIndexService.js");
  const root = path.join(isolatedState.dataDir, "music");
  await mkdir(root, { recursive: true });
  const files = [path.join(root, "first.flac"), path.join(root, "second.flac")];
  const writeAudio = async (index, album, title, genre) => {
    const word = (value) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(value);
      return buffer;
    };
    const tags = [
      "ARTIST=Incremental Artist", `ALBUM=${album}`, `TITLE=${title}`, `GENRE=${genre}`,
      "MUSICBRAINZ_ALBUMARTISTID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "MUSICBRAINZ_ALBUMID=cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      `MUSICBRAINZ_TRACKID=dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
    ];
    const comment = Buffer.concat([word(0), word(tags.length), ...tags.flatMap((tag) => {
      const buffer = Buffer.from(tag);
      return [word(buffer.length), buffer];
    })]);
    const streamInfo = Buffer.alloc(34);
    streamInfo.writeUInt16BE(4096, 0);
    streamInfo.writeUInt16BE(4096, 2);
    streamInfo.writeUInt32BE((44100 << 12) | (1 << 9) | (15 << 4), 10);
    const header = Buffer.alloc(4);
    header[0] = 0x84;
    header.writeUIntBE(comment.length, 1, 3);
    await writeFile(files[index], Buffer.concat([Buffer.from("fLaC"), Buffer.from([0, 0, 0, 34]), streamInfo, header, comment]));
  };
  const scan = (changedPaths = null) => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false, changedPaths, force: true });
  const read = (query, availableOnly = true) => getCanonicalLibraryPage({ kind: "tracks", pageSize: 100, query, availableOnly });
  await writeAudio(0, "Original Album", "First Song", "Rock");
  await writeAudio(1, "Original Album", "Second Song", "Rock");
  await scan();
  const ids = read("Original Album").items.map((track) => track.id).sort();
  assert.equal(ids.length, 2);
  await writeAudio(0, "Renamed Album", "Updated First", "Jazz");
  await scan([files[0]]);
  assert.deepEqual(read("Renamed Album").items.map((track) => track.id).sort(), ids);
  assert.equal(read("Original Album").total, 0);
  assert.equal(read("Updated First").total, 1);
  assert.equal(read("First Song").total, 0);
  assert.equal(read("Second Song").total, 1);
  assert.deepEqual(getCanonicalLibraryPage({ kind: "genres" }).items.map((genre) => genre.name), ["Jazz", "Rock"]);

  await writeFile(files[0], "unreadable");
  const failed = await scan([files[0]]);
  assert.equal(failed.local.filesFailed, 1);
  assert.equal(read("Updated First").total, 1);
  await rm(files[0]);
  await scan([files[0]]);
  assert.equal(read("Updated First").total, 0);
  assert.equal(read("Updated First", false).total, 1);
  assert.equal(read("Second Song").total, 1);
  await writeAudio(0, "Renamed Album", "Restored First", "Folk");
  await scan([files[0]]);
  assert.equal(read("Restored First").total, 1);
  assert.equal(read("Updated First").total, 0);
  assert.equal(read("Second Song").total, 1);
  assert.deepEqual(getCanonicalLibraryPage({ kind: "genres" }).items.map((genre) => genre.name), ["Folk", "Rock"]);
});

test("merging a fallback artist into its resolved artist updates moved album and track searches", async () => {
  const { getCanonicalLibraryPage } = await importFromRepo("backend/services/libraryQueryService.js");
  const fallbackKey = libraryStore.buildFallbackIdentityKey("artist", "Merge Searché");
  const fallback = libraryStore.upsertLibraryArtist({ identityKey: fallbackKey, name: "Merge Searche" });
  const resolvedId = Number(db.prepare(
    `INSERT INTO library_artists (identity_key, mbid, name, created_at, updated_at)
     VALUES ('mbid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Merge Searché', '', '')`,
  ).run().lastInsertRowid);
  searchIndex.syncLibrarySearchArtist(resolvedId);
  const albumIds = [];
  for (const index of [1, 2]) {
    const album = libraryStore.upsertLibraryAlbum({
      identityKey: `merge-search:album-${index}`, artistId: fallback.id, title: `Moved Album ${index}`,
    });
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `merge-search:track-${index}`, title: `Moved Track ${index}`, artistName: "Merge Searche",
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id, albumId: album.id, source: "aurral", path: `/merge-search/${index}.flac`,
    });
    albumIds.push(album.id);
  }

  assert.equal(libraryStore.upsertLibraryArtist({ identityKey: fallbackKey, name: "Merge Searche" }).id, resolvedId);

  const search = (kind, query) => getCanonicalLibraryPage({ kind, query, pageSize: 100 }).items;
  assert.deepEqual(search("albums", "Merge Searché").map((album) => album.id).sort(), albumIds.sort());
  assert.equal(search("tracks", "Merge Searché").length, 2);
  assert.deepEqual(search("artists", "Merge Search").map((artist) => artist.id), [resolvedId]);
  assert.equal(db.prepare(
    "SELECT 1 FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?",
  ).get(fallback.id), undefined);
});
