import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  { downloadWorker },
  { lidarrClient },
  { getLibraryForAlbumIds },
  { clearMetadataProviderCaches },
  { registerAlbums },
  { validateDownloadedTrackFile, POST_DOWNLOAD_DECISIONS },
  { buildResolvedJobTrack, writeAudioMetadata },
  { scanMusicRoot },
] = await setupIsolatedBackend(
  "aurral-compilation-albums",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/lidarrClient.js",
  "backend/services/libraryQueryService.js",
  "backend/services/providers/brainzmashProvider.js",
  "backend/routes/library/handlers/albums.js",
  "backend/services/trackMatching/index.js",
  "backend/services/downloadUtils.js",
  "backend/services/libraryFileScanner.js",
);

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
registerAlbums({ get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") });

async function callRoute(key, body = {}) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    { params: {}, body, query: {}, user: { role: "admin", permissions: {} } },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
    },
  );
  return response;
}

const variousArtists = "89ad4ac3-39f7-470e-963a-56509c546377";
const albumMbid = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const tracks = [
  ["f98a61b4-0000-4000-8000-000000000001", "Blue Swede", "Hooked on a Feeling", 173000],
  ["01b405ae-0000-4000-8000-000000000002", "Raspberries", "Go All the Way", 203000],
];

const metadataServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname !== `/album/${albumMbid}`) {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  response.end(JSON.stringify({
    id: albumMbid,
    title: "Guardians of the Galaxy: Awesome Mix, Vol. 1",
    artistid: variousArtists,
    artists: [
      { id: variousArtists, artistname: "Various Artists" },
      ...tracks.map(([artistId, artistName]) => ({ id: artistId, artistname: artistName })),
    ],
    releases: [{
      id: `${albumMbid}-release`,
      status: "Official",
      tracks: tracks.map(([artistId, , title, durationMs], index) => ({
        id: `track-${index}`,
        recordingid: `aaaaaaaa-0000-4000-8000-00000000000${index}`,
        trackname: title,
        artistid: artistId,
        durationms: durationMs,
        trackposition: index + 1,
        mediumnumber: 1,
      })),
    }],
  }));
});

const originalSettings = dbOps.getSettings();
const originalLidarrConfigured = lidarrClient.isConfigured;
const originalWorkerStart = downloadWorker.start;

test.before(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadataServer.url, enableNarrowFallbacks: false },
    },
  });
  clearMetadataProviderCaches();
  lidarrClient.isConfigured = () => false;
  downloadWorker.start = async () => {};
});

test.after(async () => {
  lidarrClient.isConfigured = originalLidarrConfigured;
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

test("a compilation keeps Various Artists on the album and matches each track by its own artist", async () => {
  const requested = await callRoute("POST /albums/request", {
    albumMbid,
    albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1",
    artistMbid: variousArtists,
    artistName: "Various Artists",
    managedBy: "aurral",
  });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));

  const albumId = db.prepare("SELECT id FROM library_albums WHERE release_group_mbid = ?").get(albumMbid).id;
  const library = getLibraryForAlbumIds({ ids: [albumId] });
  assert.deepEqual(library.tracks.map((track) => track.artistName).sort(), ["Blue Swede", "Raspberries"]);

  const jobs = downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.equal(job.artistName, "Various Artists");
  const hooked = jobs.find((job) => job.trackName === "Hooked on a Feeling");
  assert.deepEqual(hooked.artistAliases, ["Blue Swede"]);

  const validate = (artist) => validateDownloadedTrackFile({
    request: buildResolvedJobTrack(hooked),
    filePath: "/staging/Hooked on a Feeling.flac",
    source: "soulseek",
    options: { parseFile: async () => ({
      common: { title: "Hooked on a Feeling", artist, album: "Guardians of the Galaxy: Awesome Mix, Vol. 1", track: { no: 1 } },
      format: { duration: 173, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" },
    }) },
  });
  assert.equal((await validate("Blue Swede")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate("Raspberries")).decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);

  const root = join(isolatedState.baseDir, "music");
  const filePath = join(root, "Various Artists", "Awesome Mix", "01 - Hooked on a Feeling.flac");
  await mkdir(join(root, "Various Artists", "Awesome Mix"), { recursive: true });
  await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", filePath]);
  await writeAudioMetadata(filePath, buildResolvedJobTrack(hooked));
  const { common } = await parseFile(filePath);
  assert.deepEqual([common.artist, common.albumartist], ["Blue Swede", "Various Artists"]);
  const hookedArtist = () => getLibraryForAlbumIds({ ids: [albumId] }).tracks
    .find((track) => track.title === "Hooked on a Feeling").artistName;
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(hookedArtist(), "Blue Swede");

  await writeAudioMetadata(filePath, { ...buildResolvedJobTrack(hooked), artistName: "Verschiedene Interpreten" });
  assert.equal((await parseFile(filePath)).common.artist, "Blue Swede");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(hookedArtist(), "Blue Swede");

  await writeAudioMetadata(filePath, buildResolvedJobTrack({ ...hooked, artistAliases: [] }));
  await scanMusicRoot({ rootPath: root, source: "aurral", force: true });
  assert.equal(hookedArtist(), "Blue Swede");
});
