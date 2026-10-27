import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { parseShareManifest } from "../../lib/shareManifest.ts";

vi.mock("../../backend/services/downloadJobs/mutationGuards.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../backend/services/downloadJobs/mutationGuards.ts")
  >()),
  wakeDownloadWorker: vi.fn(async () => {}),
}));
vi.mock("../../backend/services/playlists/playlistManager.ts", () => ({
  playlistManager: {
    updateConfig: vi.fn(),
    requestPlaylistSync: vi.fn(),
  },
}));
vi.mock("../../backend/services/libraryScanWorker.ts", () => ({ scheduleLibraryScan: vi.fn() }));

process.env.AURRAL_SHARE_ORIGIN = "https://shares.example.com";
const [
  paths,
  { db },
  { userOps, dbOps },
  importer,
  { flowPlaylistConfig },
  { downloadTracker },
  media,
  honker,
  { processPipelineJob },
] = await setupIsolatedBackend(
  "share-import",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/shareLinks/import.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/downloadPipelineWorker.ts"),
);
const owner = userOps.createUser("recipient", "hash", "admin");
assert.ok(owner);
const SHARE_URL = "https://shares.example.com/s/AbCdEfGhIjKlMnOp.TTTTTTTTTTTTTTTTTTTTTT";
const BASE = "https://quiet-river.trycloudflare.com/share/TTTTTTTTTTTTTTTTTTTTTT";
const localArtist = media.upsertLibraryArtist({ identityKey: "name:artist:local", name: "Local" });
const localAlbum = media.upsertLibraryAlbum({
  identityKey: "name:album:local:album",
  artistId: localArtist.id,
  title: "Album",
});
const localTrack = media.upsertLibraryTrack({
  identityKey: "name:track:local:song",
  title: "Owned",
  artistName: "Local",
});
media.linkLibraryAlbumTrack({ albumId: localAlbum.id, trackId: localTrack.id });
const localPath = path.join(paths.baseDir, "owned.flac");
await writeFile(localPath, "existing audio");
media.upsertLibraryMediaFile({
  trackId: localTrack.id,
  albumId: localAlbum.id,
  source: "aurral",
  path: localPath,
  format: "flac",
  size: 14,
});

const manifest = parseShareManifest({
  kind: "playlist",
  title: "Night drive",
  tracks: [
    { title: "Owned", artistName: "Local", albumTitle: "Album", path: "tracks/1/1", format: "wav" },
    {
      title: "Shared",
      artistName: "Remote",
      albumTitle: "Remote album",
      path: "tracks/2/2",
      format: "wav",
    },
    { title: "Unavailable", artistName: "Remote", albumTitle: "Remote album" },
    { title: "Unavailable", artistName: "Remote", albumTitle: "Remote album" },
  ],
});
assert.ok(manifest);

beforeEach(() => {
  downloadTracker.clearAll();
  dbOps.setJSONSetting("sharedPlaylists", []);
});
afterAll(async () => {
  await cleanupIsolatedState(paths);
});

function remoteShare({
  downloads = true,
  online = true,
  audio,
  shareManifest = manifest,
}: {
  downloads?: boolean;
  online?: boolean;
  audio?: Buffer;
  shareManifest?: typeof manifest;
} = {}) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("https://shares.example.com/api/shares/resolve?"))
      return Response.json({
        manifest: shareManifest,
        files: online
          ? {
              base: BASE,
              allowDownload: downloads,
              tracks: shareManifest!.tracks
                .filter((track) => track.path)
                .map((track) => ({
                  ...track,
                  size: track.title === "Shared" ? audio?.length || null : null,
                })),
            }
          : null,
      });
    if (url === `${BASE}/tracks/2/2/download` && audio) return new Response(Uint8Array.from(audio));
    throw new Error(`Unexpected request: ${url}`);
  });
  return requests;
}

test("details-only playlist imports keep order and repeated entries without queuing downloads", async () => {
  await importer.importShare({
    ownerUserId: owner.id,
    playlistId: "details-only",
    manifest,
    includeFiles: false,
  });
  const playlist = flowPlaylistConfig.getStaticPlaylist("details-only");
  assert.ok(playlist);
  assert.deepEqual(
    playlist.tracks.map((track) => track.trackName),
    ["Owned", "Shared", "Unavailable", "Unavailable"],
  );
  const jobs = playlist.tracks.map((track) => downloadTracker.getJob(track.canonicalJobId || ""));
  assert.deepEqual(
    jobs.map((job) => job?.status),
    ["done", "saved", "saved", "saved"],
  );
  assert.equal(jobs[0]?.finalPath, localPath);
  assert.equal(downloadTracker.getNextPending(), null);
  assert.equal(db.prepare("SELECT 1 FROM share_downloads").get(), undefined);
});

test("file imports reuse local music and queue only files the share makes available", async () => {
  const requests = remoteShare();
  await importer.importShare({
    ownerUserId: owner.id,
    playlistId: "with-files",
    url: SHARE_URL,
    manifest,
    includeFiles: true,
  });
  const playlist = flowPlaylistConfig.getStaticPlaylist("with-files");
  assert.ok(playlist);
  const jobs = playlist.tracks.map((track) => downloadTracker.getJob(track.canonicalJobId || ""));
  assert.deepEqual(
    jobs.map((job) => job?.status),
    ["done", "pending", "saved", "saved"],
  );
  const transfers = honker
    .listHonkerJobs("slskd-pipeline")
    .filter((entry) => entry.payload?.jobId === jobs[1]?.id);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].payload?.source, "share");
  assert.equal(transfers[0].payload?.manualSelection, true);
  assert.equal(requests.length, 1);
});

test("a listen-only share cannot queue file imports", async () => {
  remoteShare({ downloads: false });
  await assert.rejects(
    importer.importShare({
      ownerUserId: owner.id,
      playlistId: "listen-only",
      url: SHARE_URL,
      manifest,
      includeFiles: true,
    }),
    /downloads are no longer allowed/,
  );
  assert.equal(flowPlaylistConfig.getStaticPlaylist("listen-only"), null);
  assert.equal(downloadTracker.getAll().length, 0);
});

test("saving album details does not enable monitoring or acquisition", async () => {
  const albumManifest = parseShareManifest({
    kind: "album",
    title: "A new album",
    artistName: "A new artist",
    tracks: [{ title: "A new song", artistName: "A new artist", albumTitle: "A new album" }],
  });
  await importer.importShare({
    ownerUserId: owner.id,
    manifest: albumManifest,
    includeFiles: false,
  });
  const album = db
    .prepare<[], { id: number }>("SELECT id FROM library_albums WHERE title = 'A new album'")
    .get();
  assert.ok(album);
  assert.equal(
    db
      .prepare<[number], { monitor_mode: string }>(
        "SELECT monitor_mode FROM library_management WHERE entity_kind = 'album' AND entity_id = ?",
      )
      .get(album.id)?.monitor_mode,
    "none",
  );
  assert.equal(
    db
      .prepare<[], { monitored: number }>(
        "SELECT monitored FROM library_tracks WHERE title = 'A new song'",
      )
      .get()?.monitored,
    0,
  );
  assert.equal(downloadTracker.getAll().length, 0);
});

test("a failed shared file never falls back to configured search sources, including after retry", async () => {
  const requests = remoteShare();
  await importer.importShare({
    ownerUserId: owner.id,
    playlistId: "offline-files",
    url: SHARE_URL,
    manifest,
    includeFiles: true,
  });
  const job = downloadTracker
    .getByPlaylistType("offline-files")
    .find((entry) => entry.trackName === "Shared");
  assert.ok(job);
  const entry = honker
    .listHonkerJobs("slskd-pipeline")
    .find((queued) => queued.payload?.jobId === job.id);
  assert.ok(entry?.payload);
  remoteShare({ online: false });
  await processPipelineJob({ ...entry.payload, jobId: job.id, phase: String(entry.payload.phase) });
  assert.equal(downloadTracker.getJob(job.id)?.status, "failed");
  assert.ok(downloadTracker.getJob(job.id)?.error?.includes("sender's file"));
  downloadTracker.setPending(job.id);
  assert.equal(downloadTracker.enqueueDownloadPipeline(job.id), true);
  const retries = honker
    .listHonkerJobs("slskd-pipeline")
    .filter((queued) => queued.payload?.jobId === job.id);
  assert.ok(retries.every((queued) => queued.payload?.source === "share"));
  assert.ok(requests.every((url) => url.startsWith("https://shares.example.com/")));
});

function waveFile() {
  const dataSize = 44100 * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(88200, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

for (const format of ["wav", "m4a"]) {
  test(`a permitted shared ${format} reaches the managed Library without a download integration`, async () => {
    let audio = waveFile();
    if (format === "m4a") {
      const file = path.join(paths.baseDir, "fragmented.m4a");
      const result = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc",
          "-t",
          "0.2",
          "-c:a",
          "aac",
          "-movflags",
          "frag_keyframe+empty_moov",
          file,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      audio = await readFile(file);
    }
    const downloadManifest = {
      ...manifest!,
      tracks: manifest!.tracks.map((track) => ({
        ...track,
        title: track.title === "Shared" ? `Shared ${format}` : track.title,
        format,
      })),
    };
    remoteShare({ audio, shareManifest: downloadManifest });
    const musicDir = path.join(paths.baseDir, "managed-music");
    await mkdir(musicDir, { recursive: true });
    const settings = dbOps.getSettings();
    dbOps.updateSettings({ ...settings, downloadFolderPath: musicDir });
    await importer.importShare({
      ownerUserId: owner.id,
      playlistId: `download-file-${format}`,
      url: SHARE_URL,
      manifest: downloadManifest,
      includeFiles: true,
    });
    const job = downloadTracker
      .getByPlaylistType(`download-file-${format}`)
      .find((entry) => entry.trackName === `Shared ${format}`);
    assert.ok(job);
    const entry = honker
      .listHonkerJobs("slskd-pipeline")
      .find((queued) => queued.payload?.jobId === job.id);
    assert.ok(entry?.payload);
    await processPipelineJob({
      ...entry.payload,
      jobId: job.id,
      phase: String(entry.payload.phase),
    });
    const completed = downloadTracker.getJob(job.id);
    assert.equal(completed?.status, "done", completed?.error || "Shared file should finish");
    assert.ok(completed?.finalPath);
    assert.ok(completed.finalPath.startsWith(musicDir + path.sep));
    assert.ok((await readFile(completed.finalPath)).length >= audio.length);
    assert.equal(completed.downloadSource, "share");
    if (format === "m4a") assert.deepEqual(await readFile(completed.finalPath), audio);
  });
}

test("an unavailable album entry can be imported later when its shared file is available", async () => {
  const album = parseShareManifest({
    kind: "album",
    title: "Remote album",
    artistName: "Remote",
    tracks: manifest!.tracks.slice(1, 3),
  });
  assert.ok(album);
  remoteShare({ shareManifest: album });
  await importer.importShare({
    ownerUserId: owner.id,
    url: SHARE_URL,
    manifest: album,
    includeFiles: true,
  });
  assert.equal(downloadTracker.getAll().length, 1);
  assert.equal(downloadTracker.getAll()[0].trackName, "Shared");
  const later = {
    ...album,
    tracks: album.tracks.map((track) => ({ ...track, path: "tracks/2/2", format: "wav" })),
  };
  remoteShare({ shareManifest: later });
  await importer.importShare({
    ownerUserId: owner.id,
    url: SHARE_URL,
    manifest: later,
    includeFiles: true,
  });
  const jobs = downloadTracker.getAll();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((job) => job.trackName === "Unavailable")?.status, "pending");
});
