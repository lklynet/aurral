import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupIsolatedState,
  importFromRepo,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "metadata-projection",
  "backend/config/db-sqlite.js",
);
const { indexLidarrLibrary } = await importFromRepo("backend/services/libraryLidarrIndexer.js");
const { scanMusicRoot } = await importFromRepo("backend/services/libraryFileScanner.js");
const { getCanonicalLibraryPage, rebuildCanonicalGenreStats } =
  await importFromRepo("backend/services/libraryQueryService.js");
const { slimFileTags, slimLidarrAlbum } =
  await importFromRepo("backend/services/libraryMetadataProjection.js");

let root;
const storedMetadata = (table, column, value) =>
  JSON.parse(db.prepare(`SELECT metadata_json FROM ${table} WHERE ${column} = ?`).get(value).metadata_json);

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aurral-metadata-projection-"));
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("Lidarr resources are stored without their embedded related objects", async () => {
  const filePath = path.join(root, "Projected Artist", "Projected Album", "01 Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  const embeddedArtist = { id: 5, artistName: "Projected Artist", overview: "x".repeat(2000) };
  const client = {
    isConfigured: () => true,
    request: async () => [{
      id: 5,
      artistName: "Projected Artist",
      foreignArtistId: "55555555-5555-4555-8555-555555555555",
      monitored: true,
      genres: ["Rock"],
      images: [{ coverType: "poster", url: "/poster.jpg" }],
      statistics: { albumCount: 1, trackFileCount: 1, sizeOnDisk: 10 },
      ratings: { votes: 1, value: 4 },
      overview: "long biography text",
      links: [{ url: "https://example.test", name: "site" }],
      members: [{ name: "Member" }],
      nextAlbum: { id: 51, title: "Next", artist: embeddedArtist },
      lastAlbum: { id: 50, title: "Last", artist: embeddedArtist },
    }],
    getAllAlbums: async () => [{
      id: 50,
      artistId: 5,
      title: "Projected Album",
      foreignAlbumId: "66666666-6666-4666-8666-666666666666",
      monitored: true,
      albumType: "Album",
      releaseDate: "2020-01-01T00:00:00Z",
      genres: ["Rock"],
      images: [{ coverType: "cover", url: "/cover.jpg" }],
      statistics: { trackFileCount: 1, sizeOnDisk: 10 },
      artist: embeddedArtist,
      releases: Array.from({ length: 20 }, (_, index) => ({ id: index, title: `Release ${index}` })),
      links: [{ url: "https://example.test", name: "site" }],
      overview: "long album text",
      path: path.dirname(filePath),
    }],
    getTracksByAlbumId: async () => [{
      id: 500,
      albumId: 50,
      artistId: 5,
      title: "Track",
      trackNumber: 1,
      foreignRecordingId: "77777777-7777-4777-8777-777777777777",
      trackFileId: 5000,
      artist: embeddedArtist,
      album: { id: 50, title: "Projected Album", artist: embeddedArtist },
    }],
    getTrackFilesByAlbumId: async () => [{ id: 5000, path: filePath, trackIds: [500] }],
    getRootFolders: async () => [{ path: root }],
  };

  const result = await indexLidarrLibrary({ client, syncSearch: false });
  assert.equal(result.filesIndexed, 1);

  const artist = storedMetadata("library_artists", "mbid", "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(Object.keys(artist).sort(), [
    "artistName", "foreignArtistId", "genres", "id", "images", "librarySource", "monitored",
    "ratings", "statistics",
  ]);
  const album = storedMetadata("library_albums", "release_group_mbid", "66666666-6666-4666-8666-666666666666");
  assert.deepEqual(Object.keys(album).sort(), [
    "albumType", "artistId", "foreignAlbumId", "genres", "id", "images", "librarySource",
    "monitored", "path", "releaseDate", "statistics", "title",
  ]);
  const track = storedMetadata("library_tracks", "mbid", "77777777-7777-4777-8777-777777777777");
  assert.equal("artist" in track || "album" in track, false);
  assert.equal(track.trackFileId, 5000);

  rebuildCanonicalGenreStats();
  const page = getCanonicalLibraryPage({ kind: "albums", page: 1, pageSize: 10, query: "Projected Album" });
  assert.deepEqual(page.items[0].metadata.genres, ["Rock"]);
  assert.deepEqual(page.genres.map((genre) => genre.name), ["Rock"]);
});

test("slimLidarrAlbum leaves non-object input alone", () => {
  assert.equal(slimLidarrAlbum(null), null);
  assert.deepEqual(slimLidarrAlbum({ id: 1, releases: [], title: "A" }), { id: 1, title: "A" });
});

test("Aurral file tags are stored without embedded artwork or binary payloads", async () => {
  const aurralRoot = path.join(root, "aurral");
  const filePath = path.join(aurralRoot, "Tagged Artist", "Tagged Album", "01 Tagged Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  const picture = [{ format: "image/jpeg", data: Buffer.alloc(64 * 1024, 1) }];
  await scanMusicRoot({
    rootPath: aurralRoot,
    source: "aurral",
    syncSearch: false,
    metadataReader: async () => ({
      common: {
        artist: "Tagged Artist",
        albumartist: "Tagged Artist",
        album: "Tagged Album",
        title: "Tagged Track",
        genre: ["Jazz"],
        track: { no: 1, of: 1 },
        picture,
        rating: [{ source: "x", rating: 0.8 }],
      },
      format: { duration: 12, codec: "FLAC" },
    }),
  });

  const track = db.prepare(
    "SELECT metadata_json FROM library_tracks WHERE title = 'Tagged Track'",
  ).get();
  assert.ok(track.metadata_json.length < 1024, `stored ${track.metadata_json.length} bytes`);
  const tags = JSON.parse(track.metadata_json).tags;
  assert.equal("picture" in tags, false);
  assert.deepEqual(tags.genre, ["Jazz"]);
  assert.deepEqual(tags.track, { no: 1, of: 1 });
  assert.deepEqual(slimFileTags({ picture, title: "x", raw: new Uint8Array(4) }), { title: "x" });
});
