import { requireFixture } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DownloadJob } from "../../backend/services/downloadJobs/downloadTracker.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  config,
  { downloadTracker },
  { playlistManager },
  operations,
  { downloadWorker },
  { scanMusicRoot },
  { getLibrary },
  { keepInLibrary },
  subsonic,
  { requestLibraryTrack },
] = await setupIsolatedBackend(
  "playlist-library",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/playlists/playlistLibrary.ts"),
  () => import("../../backend/services/subsonicLibraryService.ts"),
  () => import("../../backend/services/libraryTrackRequests.ts"),
);
beforeEach(() => {
  resetDatabase(db);
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 1);
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => false);
});
afterAll(() => cleanupIsolatedState(state));

type Track = { artistName: string; albumName: string; trackName: string };

const synced = {
  provider: "spotify-playlist",
  externalId: "synced",
  syncEnabled: true,
  syncIntervalHours: 24,
  keepRemovedTracks: false,
};

async function writeAudio({ artistName, albumName, trackName }: Track) {
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    artistName,
    albumName,
    `${trackName}.flac`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.1",
    "-metadata",
    `album_artist=${artistName}`,
    "-metadata",
    `artist=${artistName}`,
    "-metadata",
    `album=${albumName}`,
    "-metadata",
    `title=${trackName}`,
    file,
  ]);
  return file;
}

const scan = () => scanMusicRoot({ rootPath: process.env.WEEKLY_FLOW_FOLDER, source: "aurral" });

async function addLibraryFile(track: Track) {
  const file = await writeAudio(track);
  await scan();
  return file;
}

async function assertStillInLibrary(file: string) {
  await fs.access(file);
  await scan();
  assert.ok(
    getLibrary({ availableOnly: true }).tracks.some((track) =>
      track.files.some((media) => media.path === file),
    ),
    "the Library must still have the file",
  );
}

async function createPlaylist(
  tracks: (Track | (Omit<Track, "albumName"> & { path: string }))[],
  extra: { name?: string; importSource?: typeof synced; downloadMissing?: boolean } = {},
) {
  const result = await operations.processPlaylistOperation({
    kind: "static-playlist-create",
    name: "From the Library",
    tracks,
    ...extra,
  });
  assert.ok(result && typeof result === "object" && "playlist" in result);
  const playlist = requireFixture(result.playlist);
  const jobFor = (track: { trackName: string }) =>
    requireFixture(
      downloadTracker.getJob(
        requireFixture(config.flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks.find(
          (entry) => entry.trackName === track.trackName,
        )?.canonicalJobId,
      ),
    );
  return { playlist, jobFor };
}

async function finishDownload(job: DownloadJob) {
  downloadTracker.setDownloading(job.id);
  const file = await writeAudio({ ...job, albumName: requireFixture(job.albumName) });
  downloadTracker.setDone(job.id, file, job.albumName);
  await scan();
  return file;
}

const dropAllUpstream = (playlistId: string) =>
  operations.processPlaylistOperation({
    kind: "static-playlist-update",
    playlistId,
    tracks: [],
    hasTracksUpdate: true,
    hasImportSourceUpdate: true,
    importSource: { lastSyncAt: Date.now() },
    mergeImportSource: true,
  });

test("a playlist adds its tracks to the Library and deleting it keeps every file", async () => {
  const reused = { artistName: "Reuse Band", albumName: "Reuse Record", trackName: "Already Here" };
  const fetched = { artistName: "Fresh Band", albumName: "Fresh Record", trackName: "Fetched" };
  const libraryFile = await addLibraryFile(reused);
  const { playlist, jobFor } = await createPlaylist([reused, fetched]);
  assert.equal(jobFor(reused).playlistType, "library");
  assert.equal(jobFor(reused).finalPath, libraryFile);
  assert.equal(jobFor(reused).addedBy, null);
  assert.equal(jobFor(fetched).playlistType, "library");
  assert.equal(jobFor(fetched).addedBy, playlist.id);
  const fetchedFile = await finishDownload(jobFor(fetched));

  await operations.processPlaylistOperation({
    kind: "static-playlist-delete",
    playlistId: playlist.id,
  });

  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(playlist.id), null);
  await assertStillInLibrary(libraryFile);
  await assertStillInLibrary(fetchedFile);
});

test("a playlist that skips downloads reuses Library files and saves the rest", async () => {
  const reused = { artistName: "Reuse Band", albumName: "Only Local", trackName: "On Disk" };
  const missing = { artistName: "Fresh Band", albumName: "Not Here", trackName: "Elsewhere" };
  const libraryFile = await addLibraryFile(reused);
  const { jobFor } = await createPlaylist([reused, missing], { downloadMissing: false });

  assert.equal(jobFor(reused).status, "done");
  assert.equal(jobFor(reused).finalPath, libraryFile);
  assert.equal(jobFor(missing).status, "saved");

  await requestLibraryTrack(missing);

  assert.equal(jobFor(missing).status, "pending");
});

test("a playlist edit links a new Library track when a track no longer matches its download", async () => {
  const studio = {
    artistName: "Band",
    albumName: "Record",
    trackName: "Song",
    trackMbid: "11111111-1111-4111-8111-111111111111",
  };
  const renamed = { artistName: "Band", albumName: "Record", trackName: "Other Song" };
  const { playlist, jobFor } = await createPlaylist([studio]);
  const studioJob = jobFor(studio).id;
  const live = { ...studio, albumName: "Live", trackMbid: "22222222-2222-4222-8222-222222222222" };
  const other = await createPlaylist([live], { name: "Live set" });
  assert.notEqual(other.jobFor(live).id, studioJob);

  await operations.processPlaylistOperation({
    kind: "static-playlist-update",
    playlistId: playlist.id,
    tracks: [{ ...renamed, canonicalJobId: studioJob }],
    hasTracksUpdate: true,
  });

  assert.notEqual(jobFor(renamed).id, studioJob);
});

test("a playlist edit that cannot be saved leaves no new downloads behind", async () => {
  const kept = { artistName: "Band", albumName: "Record", trackName: "Kept" };
  const added = { artistName: "Band", albumName: "Record", trackName: "Added" };
  const { playlist } = await createPlaylist([kept]);
  await createPlaylist([], { name: "Taken" });
  const before = downloadTracker.getAll().length;

  await assert.rejects(
    operations.processPlaylistOperation({
      kind: "static-playlist-update",
      playlistId: playlist.id,
      name: "Taken",
      hasNameUpdate: true,
      tracks: [kept, added],
      hasTracksUpdate: true,
    }),
  );

  assert.equal(downloadTracker.getAll().length, before);
});

test("an imported track links the Library file at its path even when its names differ", async () => {
  const libraryFile = await addLibraryFile({
    artistName: "N.E.R.D",
    albumName: "Fly or Die",
    trackName: "Thrasher",
  });
  const { jobFor } = await createPlaylist([
    { artistName: "N.E.R.D.", trackName: "Thrasher", path: libraryFile },
  ]);
  const job = jobFor({ trackName: "Thrasher" });

  assert.equal(job.status, "done");
  assert.equal(job.finalPath, libraryFile);
  assert.equal(job.artistName, "N.E.R.D");
  assert.equal(job.albumName, "Fly or Die");
});

test("an imported track does not link an indexed file that is gone from disk", async () => {
  const library = { artistName: "Gone Band", albumName: "Gone Record", trackName: "Vanished" };
  const libraryFile = await addLibraryFile(library);
  await fs.rm(libraryFile);
  const { jobFor } = await createPlaylist([{ ...library, path: libraryFile }], {
    downloadMissing: false,
  });

  assert.equal(jobFor(library).status, "saved");
});

test("removing a track cancels its download unless something else wants it", async () => {
  const lonely = { artistName: "Band", albumName: "Record", trackName: "Only Here" };
  const shared = { artistName: "Band", albumName: "Record", trackName: "Also Elsewhere" };
  const requested = { artistName: "Band", albumName: "Record", trackName: "Asked For" };
  const { playlist, jobFor } = await createPlaylist([lonely, shared, requested]);
  const jobs = [lonely, shared, requested].map((track) => jobFor(track).id);
  await createPlaylist([shared], { name: "Other" });
  keepInLibrary(requested);

  for (const jobId of jobs) {
    await operations.processPlaylistOperation({
      kind: "static-playlist-delete-track",
      playlistId: playlist.id,
      jobId,
    });
  }

  assert.equal(downloadTracker.getJob(jobs[0]), null);
  assert.equal(downloadTracker.getJob(jobs[1])?.status, "pending");
  assert.equal(downloadTracker.getJob(jobs[2])?.status, "pending");
  assert.deepEqual(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks,
    [],
  );
});

test("a synced playlist that drops a track deletes the file it downloaded only when removed tracks are not kept", async () => {
  const track = { artistName: "Sync Band", albumName: "Rotation", trackName: "Rotated Out" };
  const dropping = await createPlaylist([track], { importSource: synced });
  const droppedFile = await finishDownload(dropping.jobFor(track));
  const droppedJobId = dropping.jobFor(track).id;

  await dropAllUpstream(dropping.playlist.id);

  assert.equal(downloadTracker.getJob(droppedJobId), null);
  await assert.rejects(fs.access(droppedFile), { code: "ENOENT" });

  const keeping = { artistName: "Sync Band", albumName: "Rotation", trackName: "Kept" };
  const kept = await createPlaylist([keeping], {
    name: "Keeps removed tracks",
    importSource: { ...synced, externalId: "kept", keepRemovedTracks: true },
  });
  const keptFile = await finishDownload(kept.jobFor(keeping));
  await dropAllUpstream(kept.playlist.id);
  await assertStillInLibrary(keptFile);
});

test("a synced playlist that drops a track keeps a file it reused, a favorite, or a past favorite", async () => {
  const reused = { artistName: "Reuse Band", albumName: "Synced Record", trackName: "Dropped" };
  const starred = { artistName: "Star Band", albumName: "Synced Record", trackName: "Loved" };
  const unstarred = {
    artistName: "Star Band",
    albumName: "Synced Record",
    trackName: "Once Loved",
  };
  const libraryFile = await addLibraryFile(reused);
  const { playlist, jobFor } = await createPlaylist([reused, starred, unstarred], {
    importSource: synced,
  });
  const starredFile = await finishDownload(jobFor(starred));
  const unstarredFile = await finishDownload(jobFor(unstarred));
  const { id: userId } = requireFixture(
    db
      .prepare<[], { id: number }>(
        "INSERT INTO users (username, password_hash) VALUES ('fan', 'hash') RETURNING id",
      )
      .get(),
  );
  const user = testUser(userId);
  const songId = (file: string) =>
    subsonic.idFor(
      "song",
      requireFixture(
        db
          .prepare<[string], { identity_key: string }>(
            `SELECT track.identity_key FROM library_media_files AS media
             JOIN library_tracks AS track ON track.id = media.track_id WHERE media.path = ?`,
          )
          .get(file),
      ).identity_key,
    );
  assert.equal(await subsonic.starMany(user, [songId(starredFile), songId(unstarredFile)]), true);
  subsonic.unstarMany(user, [songId(unstarredFile)]);

  await dropAllUpstream(playlist.id);

  await assertStillInLibrary(libraryFile);
  await assertStillInLibrary(starredFile);
  await assertStillInLibrary(unstarredFile);
});
