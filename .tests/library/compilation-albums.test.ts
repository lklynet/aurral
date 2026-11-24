import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeAll, afterAll } from "vite-plus/test";
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
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  { downloadWorker },
  { getLibraryForAlbumIds },
  { clearMetadataProviderCaches },
  { api },
  { validateDownloadedTrackFile, POST_DOWNLOAD_DECISIONS },
  { buildResolvedJobTrack, writeAudioMetadata },
  { scanMusicRoot },
] = await setupIsolatedBackend(
  "aurral-compilation-albums",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/providers/metadataProvider.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/trackMatching/index.ts"),
  () => import("../../backend/services/downloadUtils.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

const variousArtists = "89ad4ac3-39f7-470e-963a-56509c546377";
const albumMbid = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const tracks = [
  ["f98a61b4-0000-4000-8000-000000000001", "Blue Swede", "Hooked on a Feeling", 173000],
  ["01b405ae-0000-4000-8000-000000000002", "Raspberries", "Go All the Way", 203000],
];

const mixer = "0e3ca88b-910e-4daa-97db-68f3722edd5f";
const mixMbid = "3642adba-c41f-41f4-9e86-73e295c04c62";
const mixTracks = [
  [mixer, "TSHA", "Sacrifice", 201000],
  ["f98a61b4-0000-4000-8000-000000000003", "CYRIL", "Stumblin' In", 189000],
];

const compilation = (
  id: string,
  title: string,
  entries: typeof tracks,
  recordingPrefix: string,
) => ({
  id,
  title,
  artistId: variousArtists,
  artists: [
    { id: variousArtists, name: "Various Artists" },
    ...entries.map(([artistId, artistName]) => ({
      id: artistId,
      name: artistName,
      aliases: artistName === "Blue Swede" ? ["Björn Skifs & Blåblus"] : [],
    })),
  ],
  releases: [
    {
      id: `${id}-release`,
      status: "Official",
      tracks: entries.map(([artistId, , trackTitle, durationMs], index) => ({
        id: `${recordingPrefix}-track-${index}`,
        recordingId: `${recordingPrefix}-0000-4000-8000-00000000000${index}`,
        title: trackTitle,
        artistId,
        durationMs,
        trackPosition: index + 1,
        mediumNumber: 1,
      })),
    },
  ],
});

const albums = new Map([
  [
    `/v1/album/${albumMbid}`,
    compilation(albumMbid, "Guardians of the Galaxy: Awesome Mix, Vol. 1", tracks, "aaaaaaaa"),
  ],
  [`/v1/album/${mixMbid}`, compilation(mixMbid, "The Annual 2025", mixTracks, "bbbbbbbb")],
]);

const metadataServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  const album = albums.get(pathname);
  if (!album) {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  response.end(JSON.stringify(album));
});

const originalSettings = dbOps.getSettings();
const originalWorkerStart = downloadWorker.start;

beforeAll(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadataServer.url,
      },
    },
  });
  clearMetadataProviderCaches();
  downloadWorker.start = async () => {};
});

afterAll(async () => {
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

test("a compilation keeps Various Artists on the album and matches each track by its own artist", async () => {
  const requested = await app.request("/library/albums/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      albumMbid,
      albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1",
      artistMbid: variousArtists,
      artistName: "Various Artists",
    }),
  });
  assert.equal(requested.status, 201, await requested.text());

  const albumId = db
    .prepare<unknown[], { id: number }>(
      "SELECT id FROM library_albums WHERE release_group_mbid = ?",
    )!
    .get(albumMbid)!.id;
  const library = getLibraryForAlbumIds({ ids: [albumId] });
  assert.deepEqual(library.tracks.map((track) => track.artistName).sort(), [
    "Blue Swede",
    "Raspberries",
  ]);

  const jobs = downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.equal(job.artistName, "Various Artists");
  const hooked = jobs.find((job) => job.trackName === "Hooked on a Feeling");
  assert.ok(hooked != null);
  assert.deepEqual(hooked.artistAliases, ["Blue Swede", "Björn Skifs & Blåblus"]);

  const validate = (artist: string) =>
    validateDownloadedTrackFile({
      request: buildResolvedJobTrack(hooked),
      filePath: "/staging/Hooked on a Feeling.flac",
      source: "soulseek",
      options: {
        parseFile: async () =>
          ({
            common: {
              title: "Hooked on a Feeling",
              artist,
              album: "Guardians of the Galaxy: Awesome Mix, Vol. 1",
              track: { no: 1, of: null },
            },
            format: {
              duration: 173,
              lossless: true,
              sampleRate: 44100,
              bitsPerSample: 16,
              container: "FLAC",
            },
          }) as Awaited<ReturnType<typeof parseFile>>,
      },
    });
  assert.equal((await validate("Blue Swede")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(
    (await validate("Björn Skifs & Blåblus")).decision,
    POST_DOWNLOAD_DECISIONS.VERIFIED,
  );
  assert.equal((await validate("Raspberries")).decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);

  const root = join(isolatedState.baseDir, "music");
  const filePath = join(root, "Various Artists", "Awesome Mix", "01 - Hooked on a Feeling.flac");
  await mkdir(join(root, "Various Artists", "Awesome Mix"), { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    "1",
    "-c:a",
    "flac",
    filePath,
  ]);
  await writeAudioMetadata(filePath, buildResolvedJobTrack(hooked));
  const { common } = await parseFile(filePath);
  assert.deepEqual([common.artist, common.albumartist], ["Blue Swede", "Various Artists"]);
  const hookedArtist = () =>
    getLibraryForAlbumIds({ ids: [albumId] })!.tracks.find(
      (track) => track.title === "Hooked on a Feeling",
    )!.artistName;
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(hookedArtist(), "Blue Swede");

  await writeAudioMetadata(filePath, {
    ...buildResolvedJobTrack(hooked),
    artistName: "Verschiedene Interpreten",
  });
  assert.equal((await parseFile(filePath)).common.artist, "Blue Swede");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(hookedArtist(), "Blue Swede");

  await writeAudioMetadata(filePath, buildResolvedJobTrack({ ...hooked, artistAliases: [] }));
  await scanMusicRoot({ rootPath: root, source: "aurral", force: true });
  assert.equal(hookedArtist(), "Blue Swede");
});

test("a compilation track whose stored aliases can't be read is still fetched by its own artist", async () => {
  const track = db
    .prepare<[string], { id: number }>("SELECT id FROM library_tracks WHERE title = ?")
    .get("Go All the Way")!;
  const monitor = (monitored: boolean) =>
    app.request(`/library/tracks/${track.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monitored }),
    });
  assert.equal((await monitor(false)).status, 200);
  db.prepare(
    "UPDATE library_tracks SET metadata_json = json_set(metadata_json, '$.artistAliases', json('{}')) WHERE id = ?",
  ).run(track.id);
  downloadTracker.clearAll();

  const monitored = await monitor(true);

  assert.equal(monitored.status, 200, await monitored.text());
  assert.deepEqual(
    downloadTracker.getAll().map((job) => job.artistAliases),
    [["Raspberries"]],
  );
});

test("a compilation requested from one of its artists searches each track by its own artist", async () => {
  downloadTracker.clearAll();
  const requested = await app.request("/library/albums/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      albumMbid: mixMbid,
      albumName: "The Annual 2025",
      artistMbid: mixer,
      artistName: "TSHA",
    }),
  });
  assert.equal(requested.status, 201, await requested.text());

  assert.deepEqual(
    downloadTracker
      .getAll()
      .map((job) => [job.trackName, job.artistName, job.artistMbid, job.artistAliases])
      .sort(),
    [
      ["Sacrifice", "Various Artists", variousArtists, ["TSHA"]],
      ["Stumblin' In", "Various Artists", variousArtists, ["CYRIL"]],
    ],
  );
});
