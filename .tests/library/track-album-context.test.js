import test from "node:test";
import assert from "node:assert/strict";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.js";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { downloadWorker },
  { resolveReleaseManifest },
  { registerReleaseGroup },
  { registerDownloads },
  { registerTracks },
  { flowTrackSource },
  libraryStore,
  managementStore,
  { dbOps },
] = await setupIsolatedBackend(
  "track-album-context",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/releaseResolver.js",
  "backend/routes/artists/handlers/releaseGroup.js",
  "backend/routes/library/handlers/downloads.js",
  "backend/routes/library/handlers/tracks.js",
  "backend/services/flows/flowTrackSource.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/db/helpers/index.js",
);

const routes = new Map();
const route = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers.at(-1));
const router = { get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") };
registerReleaseGroup(router);
registerDownloads(router);
registerTracks(router);

async function callRoute(key, { params = {}, body = {}, query = {} } = {}) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    { params, body, query, user: { role: "admin", permissions: {} } },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
      set() {
        return this;
      },
    },
  );
  return response;
}

const GROUP = "a1a1a1a1-0000-4000-8000-000000000001";
const STANDARD = "a1a1a1a1-0000-4000-8000-000000000002";
const PRESSING = "a1a1a1a1-0000-4000-8000-000000000003";
const DELUXE = "a1a1a1a1-0000-4000-8000-000000000004";
const FOREIGN = "a1a1a1a1-0000-4000-8000-000000000009";
const intro = { title: "Intro", recordingId: "rec-intro", position: 1, disc: 1 };
const song = { title: "Song", recordingId: "rec-song", position: 2, disc: 1 };
const outro = { title: "Outro", recordingId: "rec-outro", position: 1, disc: 2 };
const group = brainzmashGroup({
  id: GROUP,
  title: "Two Sides",
  artist: "Context Artist",
  releases: [
    { id: DELUXE, tracks: [intro, song, { title: "Bonus", position: 3, disc: 1 }, outro, { title: "Extra", position: 2, disc: 2 }] },
    { id: STANDARD, tracks: [intro, song, outro] },
    { id: PRESSING, tracks: [intro, song, outro] },
  ],
});

const originalWorkerStart = downloadWorker.start;
test.before(() => {
  downloadWorker.start = async () => {};
});
test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
});
test.after(async () => {
  downloadWorker.start = originalWorkerStart;
  await cleanupIsolatedState(isolatedState);
});

const requestTrack = (body) => callRoute("POST /downloads/track", {
  body: { artistName: "Context Artist", albumName: "Two Sides", albumMbid: GROUP, ...body },
});

const storedJob = (jobId) => db.prepare(
  "SELECT release_mbid, track_number, disc_number FROM playlist_download_jobs WHERE id = ?",
).get(jobId);

test("a release page lists the release and disc a plain request for its track searches", async (t) => {
  await serveGroups(t, [group]);

  const listed = await callRoute("GET /release-group/:mbid/tracks", { params: { mbid: GROUP } });

  assert.deepEqual(
    listed.body.map((track) => [track.title, track.releaseMbid, track.discNumber, track.trackNumber]),
    [["Intro", STANDARD, 1, 1], ["Song", STANDARD, 1, 2], ["Outro", STANDARD, 2, 1]],
  );
  const plain = await requestTrack({ trackName: "Outro", trackMbid: "rec-outro" });
  const manifest = await resolveReleaseManifest(downloadTracker.getJob(plain.body.jobId));
  assert.equal(manifest.releaseMbid, listed.body[2].releaseMbid);
});

function libraryAlbum({ groupMbid, title, metadata = null, recordings = [] }) {
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "mbid:context-artist", mbid: "context-artist",
    name: "Context Artist" });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${groupMbid}`, mbid: groupMbid,
    releaseGroupMbid: groupMbid, artistId: artist.id, title, metadata });
  recordings.forEach((recording, index) => {
    const track = libraryStore.upsertLibraryTrack({ identityKey: `recording:${recording.recordingId}`,
      mbid: recording.recordingId, title: recording.title, artistName: "Context Artist" });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  return album;
}

test("an album page and its Library page list the edition its Library album asks for, which a plain request for its track searches", async (t) => {
  await serveGroups(t, [group]);
  libraryAlbum({ groupMbid: GROUP, title: "Two Sides", metadata: { edition: "expanded", requestedRelease: DELUXE } });

  const listed = await callRoute("GET /release-group/:mbid/tracks", { params: { mbid: GROUP } });
  const libraryListed = await callRoute("GET /tracks", { query: { releaseGroupMbid: GROUP } });

  const deluxe = [["Intro", DELUXE, 1, 1], ["Song", DELUXE, 1, 2], ["Bonus", DELUXE, 1, 3], ["Outro", DELUXE, 2, 1],
    ["Extra", DELUXE, 2, 2]];
  for (const { body } of [listed, libraryListed]) {
    assert.deepEqual(body.map((track) => [track.title, track.releaseMbid, track.discNumber, track.trackNumber]), deluxe);
  }
  const plain = await requestTrack({ trackName: "Outro", trackMbid: "rec-outro" });
  assert.equal((await resolveReleaseManifest(downloadTracker.getJob(plain.body.jobId))).releaseMbid, DELUXE);
});

test("a track added from an album page joins that Library album when another Library album also holds it", async (t) => {
  const SINGLE = "a1a1a1a1-0000-4000-8000-000000000010";
  const single = brainzmashGroup({ id: SINGLE, title: "Song", artist: "Context Artist",
    releases: [{ id: "a1a1a1a1-0000-4000-8000-000000000011", tracks: [song] }] });
  await serveGroups(t, [group, single]);
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { ...settings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" } } });
  t.after(() => dbOps.updateSettings(settings));
  libraryAlbum({ groupMbid: SINGLE, title: "Song", recordings: [song] });
  libraryAlbum({ groupMbid: GROUP, title: "Two Sides", recordings: [intro, song, outro] });

  const added = await requestTrack({ trackName: "Song", trackMbid: "rec-song", releaseMbid: STANDARD });

  assert.equal(added.statusCode, 202, JSON.stringify(added.body));
  assert.equal(downloadTracker.getJob(added.body.jobId).albumMbid, GROUP);
});

test("a track added with its release is queued and searched on that release and disc", async (t) => {
  await serveGroups(t, [group]);

  const added = await requestTrack({
    trackName: "Outro", trackMbid: "rec-outro", releaseMbid: DELUXE, discNumber: 2, trackNumber: 1,
  });

  assert.equal(added.statusCode, 202);
  assert.deepEqual(storedJob(added.body.jobId), { release_mbid: DELUXE, track_number: 1, disc_number: 2 });
  const manifest = await resolveReleaseManifest(downloadTracker.getJob(added.body.jobId));
  assert.equal(manifest.releaseMbid, DELUXE);
  assert.equal(manifest.tracks.length, 5);
});

test("a release the album does not list, or that is not an ID, still queues the track", async (t) => {
  await serveGroups(t, [group]);

  const foreign = await requestTrack({ trackName: "Intro", trackMbid: "rec-intro", releaseMbid: FOREIGN });
  const malformed = await requestTrack({ trackName: "Song", trackMbid: "rec-song", releaseMbid: "deluxe" });

  assert.equal(foreign.statusCode, 202);
  assert.equal((await resolveReleaseManifest(downloadTracker.getJob(foreign.body.jobId))).releaseMbid, STANDARD);
  assert.equal(malformed.statusCode, 202);
  assert.equal(storedJob(malformed.body.jobId).release_mbid, null);
});

test("a release radar track names the release and disc its album lists", async (t) => {
  await serveGroups(t, [group]);

  const track = await flowTrackSource._pickTrackFromRelease({
    artistName: "Context Artist",
    albumTitle: "Two Sides",
    albumMbid: GROUP,
  });

  assert.deepEqual(
    [track.trackName, track.albumMbid, track.releaseMbid, track.discNumber, track.trackNumber],
    ["Intro", GROUP, STANDARD, 1, 1],
  );
});
