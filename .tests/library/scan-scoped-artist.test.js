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

// `missingFiles` lists artist ids whose track files Lidarr no longer reports;
// `trackFileCounts` adds Lidarr statistics per artist id; `missingTracks`
// lists artist ids whose track list comes back empty; `albumErrors` lists
// artist ids whose album fetch fails; `deletedAlbums` lists artist ids whose
// albums Lidarr no longer has.
const buildClient = ({
  missingFiles = [],
  trackFileCounts = null,
  missingTracks = [],
  albumErrors = [],
  deletedAlbums = [],
  calls = [],
} = {}) => ({
  isConfigured: () => true,
  request: async (endpoint) => {
    calls.push(endpoint);
    return ARTISTS;
  },
  getArtist: async (artistId) => {
    calls.push(`/artist/${artistId}`);
    const artist = ARTISTS.find((entry) => entry.id === Number(artistId));
    if (!artist) throw new Error("not found");
    return trackFileCounts && artist.id in trackFileCounts
      ? { ...artist, statistics: { trackFileCount: trackFileCounts[artist.id] } }
      : artist;
  },
  getAllAlbums: async () => {
    calls.push("/album");
    return ARTISTS.map(albumFor);
  },
  getAlbumsByArtistId: async (artistId) => {
    calls.push(`/album?artistId=${artistId}`);
    if (albumErrors.includes(Number(artistId))) throw new Error("lidarr unavailable");
    if (deletedAlbums.includes(Number(artistId))) return [];
    return ARTISTS.filter((artist) => artist.id === Number(artistId)).map(albumFor);
  },
  getTracksByAlbumId: async (albumId) =>
    ARTISTS
      .filter((artist) => artist.id * 10 === Number(albumId) && !missingTracks.includes(artist.id))
      .map(trackFor),
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

const fingerprintOf = (name) =>
  db.prepare("SELECT lidarr_fingerprint FROM library_artists WHERE name = ?").get(name).lidarr_fingerprint;

test("a scoped re-index whose album fetch fails leaves the artist untouched", async () => {
  await indexLidarrLibrary({ client: buildClient(), syncSearch: false, artistIds: [1] });
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });

  const result = await indexLidarrLibrary({
    client: buildClient({ albumErrors: [1] }),
    syncSearch: false,
    artistIds: [1],
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });

  // With a second artist in scope the failed one is dropped, the other reconciled.
  const partial = await indexLidarrLibrary({
    client: buildClient({ albumErrors: [1], missingFiles: [2] }),
    syncSearch: false,
    artistIds: [1, 2],
  });
  assert.equal(partial.skipped, undefined);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 0 });
});

test("a scoped re-index keeps an artist's files when Lidarr returns fewer than it reports", async () => {
  await indexLidarrLibrary({ client: buildClient(), syncSearch: false, artistIds: [2] });
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });

  // Lidarr says artist one has one file but the track list came back empty.
  const truncated = await indexLidarrLibrary({
    client: buildClient({ trackFileCounts: { 1: 1 }, missingTracks: [1] }),
    syncSearch: false,
    artistIds: [1],
  });
  assert.equal(truncated.filesIndexed, 0);
  assert.equal(truncated.filesFailed, 0);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 1, "Scoped Two": 1 });
  assert.equal(fingerprintOf("Scoped One"), null);

  // The album really is gone: Lidarr reports zero files and no albums.
  const deleted = await indexLidarrLibrary({
    client: buildClient({ trackFileCounts: { 1: 0 }, deletedAlbums: [1] }),
    syncSearch: false,
    artistIds: [1],
  });
  assert.equal(deleted.filesIndexed, 0);
  assert.deepEqual(mediaAvailability(), { "Scoped One": 0, "Scoped Two": 1 });
  assert.ok(fingerprintOf("Scoped One"));
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

test("a Lidarr phase failure fails the scan and records a failed run", async () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM library_scan_runs").get().count;
  const client = buildClient();
  client.getAllAlbums = async () => {
    throw new Error("Lidarr API request failed - no response: This operation was aborted");
  };
  await assert.rejects(
    scanConfiguredLibrary({ musicRoot: root, lidarrClient: client, includeLidarr: true }),
    /Lidarr library scan failed: .*aborted/,
  );
  const run = db.prepare(
    "SELECT source, root_path, status, error FROM library_scan_runs ORDER BY id DESC LIMIT 1",
  ).get();
  assert.equal(run.source, "lidarr");
  assert.equal(run.root_path, "full");
  assert.equal(run.status, "failed");
  assert.match(run.error, /aborted/);
  // The local phase still ran and recorded its own run.
  const runs = db.prepare(
    "SELECT source, status FROM library_scan_runs WHERE id > (SELECT MAX(id) FROM library_scan_runs) - ? ORDER BY id",
  ).all(db.prepare("SELECT COUNT(*) AS count FROM library_scan_runs").get().count - before);
  assert.deepEqual(runs.map((entry) => `${entry.source}:${entry.status}`), ["aurral:complete", "lidarr:failed"]);
});
