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
  "scan-scoped-artist",
  "backend/config/db-sqlite.js",
);
const { indexLidarrLibrary } = await importFromRepo("backend/services/libraryLidarrIndexer.js");
const { scanConfiguredLibrary } = await importFromRepo("backend/services/libraryIndexService.js");

const ARTISTS = [
  { id: 1, artistName: "Scoped One", foreignArtistId: "aaaaaaaa-1111-4111-8111-111111111111" },
  { id: 2, artistName: "Scoped Two", foreignArtistId: "bbbbbbbb-2222-4222-8222-222222222222" },
];

let root;
const filesByArtist = new Map();

const albumFor = (artist) => ({
  id: artist.id * 10,
  artistId: artist.id,
  title: `${artist.artistName} Album`,
  foreignAlbumId: `${artist.id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
  path: path.dirname(filesByArtist.get(artist.id)),
});
const trackFor = (artist) => ({
  id: artist.id * 100,
  albumId: artist.id * 10,
  title: `${artist.artistName} Track`,
  trackNumber: 1,
  foreignRecordingId: `${artist.id}1111111-1111-4111-8111-111111111111`.slice(0, 36),
  trackFileId: artist.id * 1000,
});

// `missingFiles` lists artist ids whose track files Lidarr no longer reports.
const buildClient = ({ missingFiles = [], calls = [] } = {}) => ({
  isConfigured: () => true,
  request: async (endpoint) => {
    calls.push(endpoint);
    return ARTISTS;
  },
  getArtist: async (artistId) => {
    calls.push(`/artist/${artistId}`);
    const artist = ARTISTS.find((entry) => entry.id === Number(artistId));
    if (!artist) throw new Error("not found");
    return artist;
  },
  getAllAlbums: async () => {
    calls.push("/album");
    return ARTISTS.map(albumFor);
  },
  getAlbumsByArtistId: async (artistId) => {
    calls.push(`/album?artistId=${artistId}`);
    return ARTISTS.filter((artist) => artist.id === Number(artistId)).map(albumFor);
  },
  getTracksByAlbumId: async (albumId) =>
    ARTISTS.filter((artist) => artist.id * 10 === Number(albumId)).map(trackFor),
  getTrackFilesByAlbumId: async (albumId) =>
    ARTISTS
      .filter((artist) => artist.id * 10 === Number(albumId) && !missingFiles.includes(artist.id))
      .map((artist) => ({ id: artist.id * 1000, path: filesByArtist.get(artist.id), trackIds: [artist.id * 100] })),
  getRootFolders: async () => [{ path: root }],
});

const mediaAvailability = () => Object.fromEntries(
  db.prepare(
    `SELECT artist.name, media.available
     FROM library_media_files AS media
     JOIN library_albums AS album ON album.id = media.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ORDER BY artist.name`,
  ).all().map((row) => [row.name, row.available]),
);

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aurral-scan-scoped-"));
  for (const artist of ARTISTS) {
    const filePath = path.join(root, artist.artistName, "Album", "01 Track.flac");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture");
    filesByArtist.set(artist.id, filePath);
  }
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("a scoped re-index only fetches and reconciles the requested artist", async () => {
  const full = await indexLidarrLibrary({ client: buildClient(), syncSearch: false });
  assert.equal(full.filesIndexed, 2);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });
  db.prepare("UPDATE library_artists SET updated_at = 1").run();

  const calls = [];
  const scoped = await indexLidarrLibrary({
    client: buildClient({ missingFiles: [1, 2], calls }),
    syncSearch: false,
    artistIds: [1],
  });

  assert.equal(scoped.changed, true);
  assert.equal(scoped.filesIndexed, 0);
  assert.deepEqual(calls.sort(), ["/album?artistId=1", "/artist/1"]);
  // Artist two's file is also "missing" from Lidarr, but it was out of scope.
  assert.deepEqual(mediaAvailability(), { "Scoped One": 0, "Scoped Two": 1 });
  assert.equal(
    db.prepare("SELECT updated_at FROM library_artists WHERE name = 'Scoped Two'").get().updated_at,
    1,
  );
  const run = db.prepare(
    "SELECT source, root_path, status FROM library_scan_runs ORDER BY id DESC LIMIT 1",
  ).get();
  assert.deepEqual(run, { source: "lidarr-artist", root_path: "artist:1", status: "complete" });
});

test("a scoped re-index of an artist Lidarr no longer has is skipped", async () => {
  const result = await indexLidarrLibrary({
    client: buildClient(),
    syncSearch: false,
    artistIds: [999],
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 0, "Scoped Two": 1 });
});

test("a scoped configured scan skips the Aurral root", async () => {
  const result = await scanConfiguredLibrary({
    musicRoot: path.join(root, "never-created"),
    lidarrClient: buildClient(),
    artistIds: [1],
  });
  assert.equal(result.local.skipped, true);
  assert.equal(result.lidarr.changed, true);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM library_scan_runs WHERE source = 'aurral'").get().count,
    0,
  );
});
