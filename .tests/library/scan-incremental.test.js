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
  "scan-incremental",
  "backend/config/db-sqlite.js",
);
const { indexLidarrLibrary } = await importFromRepo("backend/services/libraryLidarrIndexer.js");
const { beginLibraryScan, finishLibraryScan } =
  await importFromRepo("backend/services/libraryMediaStore.js");

let root;
const files = new Map();
const statistics = new Map([
  [1, { albumCount: 1, trackCount: 1, trackFileCount: 1, sizeOnDisk: 100 }],
  [2, { albumCount: 1, trackCount: 1, trackFileCount: 1, sizeOnDisk: 200 }],
]);

const artistFor = (id) => ({
  id,
  artistName: `Incremental ${id}`,
  foreignArtistId: `${id}${id}${id}${id}${id}${id}${id}${id}-1111-4111-8111-111111111111`,
  path: path.join(root, `Incremental ${id}`),
  lastInfoSync: "2026-01-01T00:00:00Z",
  statistics: statistics.get(id),
});
const albumFor = (id) => ({
  id: id * 10,
  artistId: id,
  title: `Incremental ${id} Album`,
  foreignAlbumId: `${id}${id}${id}${id}${id}${id}${id}${id}-2222-4222-8222-222222222222`,
  path: path.dirname(files.get(id)),
});
const trackFor = (id) => ({
  id: id * 100,
  albumId: id * 10,
  title: `Incremental ${id} Track`,
  trackNumber: 1,
  foreignRecordingId: `${id}${id}${id}${id}${id}${id}${id}${id}-3333-4333-8333-333333333333`,
  trackFileId: id * 1000,
});

const buildClient = (calls = []) => ({
  isConfigured: () => true,
  request: async (endpoint) => {
    calls.push(endpoint);
    return [artistFor(1), artistFor(2)];
  },
  getAllAlbums: async () => {
    calls.push("/album");
    return [albumFor(1), albumFor(2)];
  },
  getTracksByAlbumId: async (albumId) => {
    calls.push(`/track?albumId=${albumId}`);
    return [trackFor(Number(albumId) / 10)];
  },
  getTrackFilesByAlbumId: async (albumId) => {
    calls.push(`/trackfile?albumId=${albumId}`);
    const id = Number(albumId) / 10;
    return [{ id: id * 1000, path: files.get(id), trackIds: [id * 100] }];
  },
  getRootFolders: async () => [{ path: root }],
});

const availability = () => Object.fromEntries(
  db.prepare(
    `SELECT artist.name, media.available
     FROM library_media_files AS media
     JOIN library_albums AS album ON album.id = media.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ORDER BY artist.name`,
  ).all().map((row) => [row.name, row.available]),
);
const trackCalls = (calls) => calls.filter((call) => call.startsWith("/track")).sort();

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aurral-scan-incremental-"));
  for (const id of [1, 2]) {
    const filePath = path.join(root, `Incremental ${id}`, "Album", "01 Track.flac");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture");
    files.set(id, filePath);
  }
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("a rescan skips track and file reads for artists Lidarr reports unchanged", async () => {
  const firstCalls = [];
  const first = await indexLidarrLibrary({ client: buildClient(firstCalls), syncSearch: false });
  assert.equal(first.filesIndexed, 2);
  assert.equal(first.artistsSkipped, 0);
  assert.equal(trackCalls(firstCalls).length, 4);

  const calls = [];
  const second = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });
  assert.equal(second.changed, false);
  assert.equal(second.artistsSkipped, 2);
  assert.deepEqual(trackCalls(calls), []);
  assert.deepEqual(availability(), { "Incremental 1": 1, "Incremental 2": 1 });
});

test("only artists whose statistics changed are re-read, and skipped media stays available", async () => {
  statistics.set(1, { ...statistics.get(1), sizeOnDisk: 101 });
  const calls = [];
  const result = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });

  assert.equal(result.changed, true);
  assert.equal(result.artistsSkipped, 1);
  assert.deepEqual(trackCalls(calls), ["/track?albumId=10", "/trackfile?albumId=10"]);
  assert.deepEqual(availability(), { "Incremental 1": 1, "Incremental 2": 1 });
});

const fingerprints = () => Object.fromEntries(
  db.prepare("SELECT name, lidarr_fingerprint FROM library_artists ORDER BY name").all()
    .map((row) => [row.name, row.lidarr_fingerprint]),
);

test("a forced scan reads every artist and leaves fresh fingerprints", async () => {
  const forcedCalls = [];
  const forced = await indexLidarrLibrary({ client: buildClient(forcedCalls), syncSearch: false, force: true });
  assert.equal(forced.artistsSkipped, 0);
  assert.equal(trackCalls(forcedCalls).length, 4);
  assert.ok(Object.values(fingerprints()).every((value) => typeof value === "string"));

  const again = [];
  assert.equal((await indexLidarrLibrary({ client: buildClient(again), syncSearch: false })).artistsSkipped, 2);
  assert.deepEqual(trackCalls(again), []);
});

test("an artist without a committed fingerprint is re-read even after a completed run", async () => {
  // A scan killed after rewriting the artist row leaves the fingerprint
  // cleared; a later completed run of any kind must not hide that.
  db.prepare("UPDATE library_artists SET lidarr_fingerprint = NULL WHERE name = 'Incremental 1'").run();
  finishLibraryScan(beginLibraryScan({ source: "lidarr-artist" }), { status: "complete" });
  finishLibraryScan(beginLibraryScan({ source: "lidarr" }), { status: "complete" });

  const calls = [];
  const result = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });
  assert.equal(result.artistsSkipped, 1);
  assert.deepEqual(trackCalls(calls), ["/track?albumId=10", "/trackfile?albumId=10"]);
  assert.ok(typeof fingerprints()["Incremental 1"] === "string", "the re-read stamps the fingerprint");
});

test("an artist whose file could not be indexed gets no fingerprint", async () => {
  statistics.set(2, { ...statistics.get(2), sizeOnDisk: 201 });
  const missing = files.get(2);
  await rm(missing);
  try {
    const calls = [];
    const result = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });
    assert.equal(result.filesFailed, 1);
    assert.equal(result.artistsSkipped, 1);
    assert.equal(fingerprints()["Incremental 2"], null);
  } finally {
    await mkdir(path.dirname(missing), { recursive: true });
    await writeFile(missing, "fixture");
  }

  const calls = [];
  const result = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });
  assert.equal(result.filesFailed, 0);
  assert.equal(result.artistsSkipped, 1);
  assert.deepEqual(trackCalls(calls), ["/track?albumId=20", "/trackfile?albumId=20"]);
  assert.ok(typeof fingerprints()["Incremental 2"] === "string");
  assert.deepEqual(availability(), { "Incremental 1": 1, "Incremental 2": 1 });
});

test("a scoped re-index commits the fingerprint the next full scan trusts", async () => {
  statistics.set(1, { ...statistics.get(1), sizeOnDisk: 102 });
  const scopedCalls = [];
  const client = buildClient(scopedCalls);
  client.getArtist = async (id) => artistFor(Number(id));
  client.getAlbumsByArtistId = async (id) => [albumFor(Number(id))];
  const scoped = await indexLidarrLibrary({ client, syncSearch: false, artistIds: [1] });
  assert.equal(scoped.filesIndexed, 1);
  assert.deepEqual(trackCalls(scopedCalls), ["/track?albumId=10", "/trackfile?albumId=10"]);

  const calls = [];
  const full = await indexLidarrLibrary({ client: buildClient(calls), syncSearch: false });
  assert.equal(full.artistsSkipped, 2);
  assert.deepEqual(trackCalls(calls), []);
});
