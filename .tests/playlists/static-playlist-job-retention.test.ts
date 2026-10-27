import { requireFixture } from "./fixtures.ts";
import { test, beforeEach, afterAll, onTestFinished, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  honker,
  { downloadWorker },
  { scanMusicRoot },
  { getLibrary },
  { repairReusableTrackLinks },
] = await setupIsolatedBackend(
  "shared-job-retention",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/downloadJobs/fileReuse.ts"),
);
beforeEach(() => {
  resetDatabase(db);
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
afterAll(() => cleanupIsolatedState(state));

function fixture() {
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 1);
  const track = { artistName: "Artist", trackName: "Track", albumName: "Album" };
  const source = config.flowPlaylistConfig.createStaticPlaylist({
    name: "Source",
    tracks: [track],
  });
  const jobId = downloadTracker.addJob(track, source.id);
  const survivor = config.flowPlaylistConfig.createStaticPlaylist({
    name: "Survivor",
    tracks: [{ ...track, canonicalJobId: jobId }],
  });
  return { source, survivor, jobId };
}

test("single-track removal retains the job and provider work needed by another library membership", async () => {
  const { source, survivor, jobId } = fixture();
  const queuedId = honker.getPipelineQueue().enqueue({
    jobId,
    playlistId: source.id,
    playlistGeneration: 0,
    phase: "poll",
    source: "deemix",
    queueUuid: "needed-provider-work",
  });
  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete-track",
    playlistId: source.id,
    jobId,
  });
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    0,
  );
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(survivor.id)).tracks[0]
      .canonicalJobId,
    jobId,
  );
  assert.equal(
    JSON.parse(
      requireFixture(
        db
          .prepare<
            unknown[],
            { payload: import("../../backend/db/rows.ts").HonkerLiveRow["payload"] }
          >("SELECT payload FROM _honker_live WHERE id = ?")
          .get(queuedId),
      ).payload,
    ).playlistId,
    survivor.id,
  );
});

function failOrphanPrunesAfterFirst() {
  const original = downloadWorker.pruneOrphanedJobState;
  let calls = 0;
  downloadWorker.pruneOrphanedJobState = () =>
    ++calls === 1 ? Promise.resolve() : Promise.reject(new Error("Download worker is not ready"));
  onTestFinished(() => {
    downloadWorker.pruneOrphanedJobState = original;
  });
}

async function collectEscapedRejections(run: () => Promise<unknown>) {
  const escaped: unknown[] = [];
  const record = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", record);
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", record);
  }
  return escaped;
}

test("replacing playlist tracks succeeds when only a later orphan prune would fail", async () => {
  const { source } = fixture();
  failOrphanPrunesAfterFirst();
  const escaped = await collectEscapedRejections(() =>
    operations.updateStaticPlaylist({ playlistId: source.id, tracks: [], hasTracksUpdate: true }),
  );
  assert.deepEqual([...escaped], []);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    0,
  );
});

test("removing a playlist track succeeds when only a later orphan prune would fail", async () => {
  const { source, jobId } = fixture();
  failOrphanPrunesAfterFirst();
  const escaped = await collectEscapedRejections(() =>
    operations.processPlaylistOperation({
      kind: "shared-playlist-delete-track",
      playlistId: source.id,
      jobId,
    }),
  );
  assert.deepEqual([...escaped], []);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    0,
  );
});

test("deleting the original playlist preserves a survivor's completed media", async () => {
  const { source, survivor, jobId } = fixture();
  const root = process.env.WEEKLY_FLOW_FOLDER;
  assert.ok(root != null);
  const file = path.join(root, "aurral-weekly-flow", source.id, "Artist", "Album", "Track.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "disposable audio");
  downloadTracker.setDone(requireFixture(jobId), file);
  const synced: unknown[] = [];
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation((ids) => {
    synced.push(...requireFixture(ids));
  });
  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: source.id,
  });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  const retained = downloadTracker.getJob(jobId);
  assert.equal(retained?.playlistType, survivor.id);
  assert.equal(await fs.readFile(requireFixture(retained.finalPath), "utf8"), "disposable audio");
  assert.deepEqual([...new Set(synced)].sort(), [source.id, survivor.id].sort());
});

test("replacing imported tracks preserves a removed job referenced by another playlist and syncs both", async () => {
  const { source, survivor, jobId } = fixture();
  const synced: unknown[] = [];
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation((ids) => {
    synced.push(...requireFixture(ids));
  });
  await operations.updateStaticPlaylist({
    playlistId: source.id,
    tracks: [],
    hasTracksUpdate: true,
  });
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    0,
  );
  assert.deepEqual([...new Set(synced)].sort(), [source.id, survivor.id].sort());
});

test("an import persistence failure preserves an unshared completed job and its file", async (t: import("vite-plus/test").TestContext) => {
  const { source, survivor, jobId } = fixture();
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    "aurral-playlists",
    source.id,
    "Track.flac",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "original audio");
  downloadTracker.setDone(requireFixture(jobId), file);
  db.exec(
    "CREATE TRIGGER reject_import BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'import save rejected'); END",
  );
  t.onTestFinished(() => {
    db.exec("DROP TRIGGER IF EXISTS reject_import");
  });
  await assert.rejects(
    operations.updateStaticPlaylist({
      playlistId: source.id,
      tracks: [],
      hasTracksUpdate: true,
      deleteUnsharedFiles: true,
    }),
    /import save rejected/,
  );
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    1,
  );
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, file);
  assert.equal(await fs.readFile(file, "utf8"), "original audio");
  db.exec("DROP TRIGGER reject_import");
});

test("a single-removal retry syncs the surviving playlist after the sync could not be queued", async () => {
  const { source, survivor, jobId } = fixture();
  let fail = true;
  const refreshed: unknown[] = [];
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation((ids) => {
    refreshed.push(...requireFixture(ids));
    if (requireFixture(ids).includes(survivor.id) && fail)
      throw new Error("sync queue unavailable");
  });
  const operation = { kind: "shared-playlist-delete-track", playlistId: source.id, jobId };
  await assert.rejects(operations.processPlaylistOperation(operation), /sync queue unavailable/);
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  fail = false;
  refreshed.length = 0;
  await operations.processPlaylistOperation(operation);
  assert.ok(refreshed.includes(survivor.id));
});

test("removal locks include reused files and quality-upgrade album peers", async () => {
  const { source, survivor, jobId } = fixture();
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const fileOwner = config.flowPlaylistConfig.createStaticPlaylist({ name: "File owner" });
  const peerOwner = config.flowPlaylistConfig.createStaticPlaylist({ name: "Upgrade peer owner" });
  const file = path.join(requireFixture(process.env.WEEKLY_FLOW_FOLDER), "shared.flac");
  downloadTracker.setDone(requireFixture(jobId), file);
  const sharedJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Shared" },
    fileOwner.id,
  );
  assert.ok(sharedJobId != null);
  downloadTracker.setDone(sharedJobId, file);
  const upgradeId = downloadTracker.addReplacementSearchJob(downloadTracker.getJob(jobId));
  const peerId = downloadTracker.addJob({ artistName: "Artist", trackName: "Peer" }, peerOwner.id);
  honker.getPipelineQueue().enqueue({
    jobId: upgradeId,
    playlistId: source.id,
    albumGrab: true,
    albumGroupJobIds: [upgradeId, peerId],
  });
  const { getPlaylistRemovalLockIds } =
    await import("../../backend/services/playlists/trackRemoval.ts");
  const ids = getPlaylistRemovalLockIds(source.id, [requireFixture(downloadTracker.getJob(jobId))]);
  assert.ok(ids.includes(fileOwner.id), "the other file owner must be locked before paths change");
  assert.ok(
    ids.includes(peerOwner.id),
    "the upgrade peer must be locked before provider work changes",
  );
});

test("a failed membership commit keeps both media copies and retries retained ownership", async () => {
  const { source, survivor, jobId } = fixture();
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    "aurral-playlists",
    source.id,
    "Retained.flac",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "retained audio");
  downloadTracker.setDone(requireFixture(jobId), file);
  db.exec(
    "CREATE TRIGGER reject_retained_membership BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'retained save rejected'); END",
  );
  const operation = { kind: "shared-playlist-delete-track", playlistId: source.id, jobId };
  try {
    await assert.rejects(operations.processPlaylistOperation(operation), /retained save rejected/);
    assert.equal(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
      1,
    );
    assert.equal(requireFixture(downloadTracker.getJob(jobId)).playlistType, source.id);
    assert.equal(requireFixture(downloadTracker.getJob(jobId)).finalPath, file);
    assert.equal(await fs.readFile(file, "utf8"), "retained audio");
    const intent = JSON.parse(
      requireFixture(
        db
          .prepare<unknown[], { value: import("../../backend/db/rows.ts").SettingsRow["value"] }>(
            "SELECT value FROM settings WHERE key = ?",
          )
          .get(`playlistMediaRelocation:${jobId}`),
      ).value,
    );
    assert.equal(await fs.readFile(intent.to, "utf8"), "retained audio");
  } finally {
    db.exec("DROP TRIGGER reject_retained_membership");
  }
  await operations.processPlaylistOperation(operation);
  assert.equal(requireFixture(downloadTracker.getJob(jobId)).playlistType, survivor.id);
  assert.equal(
    await fs.readFile(requireFixture(downloadTracker.getJob(jobId)).finalPath!, "utf8"),
    "retained audio",
  );
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("whole-playlist deletion resumes external cleanup after membership commits", async () => {
  const { source, survivor, jobId } = fixture();
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    "aurral-playlists",
    source.id,
    "Completed.flac",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "completed retained audio");
  downloadTracker.setDone(requireFixture(jobId), file);
  const synced: unknown[] = [];
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation((ids) => {
    synced.push(...requireFixture(ids));
  });
  const weeklyReset = playlistManager.weeklyReset.bind(playlistManager);
  let fail = true;
  vi.spyOn(playlistManager, "weeklyReset").mockImplementation(async (...args) => {
    if (fail) throw new Error("cleanup unavailable");
    return weeklyReset(...args);
  });
  const operation = { kind: "shared-playlist-delete", playlistId: source.id };
  await assert.rejects(operations.processPlaylistOperation(operation), /cleanup unavailable/);
  assert.equal(requireFixture(downloadTracker.getJob(jobId)).playlistType, survivor.id);
  assert.ok(config.flowPlaylistConfig.getStaticPlaylist(source.id));
  assert.ok(
    synced.includes(survivor.id),
    "the survivor is synced even though the delete must be retried",
  );
  fail = false;
  synced.length = 0;
  await operations.processPlaylistOperation(operation);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  assert.equal(requireFixture(downloadTracker.getJob(jobId)).playlistType, survivor.id);
  assert.ok(
    synced.includes(source.id),
    "the deleted playlist is removed from servers by the sync job",
  );
});

async function addLibraryFile({
  artistName,
  albumName,
  trackName,
}: {
  artistName: string;
  albumName: string;
  trackName: string;
}) {
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
  await scanMusicRoot({ rootPath: process.env.WEEKLY_FLOW_FOLDER, source: "aurral" });
  return file;
}

async function assertStillInLibrary(file: string) {
  await fs.access(file);
  await scanMusicRoot({ rootPath: process.env.WEEKLY_FLOW_FOLDER, source: "aurral" });
  assert.ok(
    getLibrary({ availableOnly: true }).tracks.some((track) =>
      track.files.some((media) => media.path === file),
    ),
    "the Library must still have the reused file",
  );
}

function mockPlaylistServices() {
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 1);
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => false);
}

async function createPlaylist(
  tracks: { artistName: string; albumName: string; trackName: string }[],
  extra: {
    name?: string;
    importSource?: {
      provider: string;
      externalId: string;
      syncEnabled: boolean;
      syncIntervalHours: number;
      keepRemovedTracks: boolean;
    };
  } = {},
) {
  const result = await operations.processPlaylistOperation({
    kind: "shared-playlist-create",
    name: "From the Library",
    tracks,
    ...extra,
  });
  assert.ok(result && typeof result === "object" && "playlist" in result);
  const { playlist } = result;
  const jobFor = (track: { artistName: string; albumName: string; trackName: string }) =>
    downloadTracker
      .getByPlaylistType(playlist!.id)
      .find((job) => job.trackName === track.trackName);
  return { playlist, jobFor };
}

async function finishDownload(
  job: import("../../backend/services/downloadJobs/downloadTracker.ts").DownloadJob | undefined,
) {
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    requireFixture(requireFixture(job).artistName),
    requireFixture(job).albumName!,
    `${requireFixture(job).trackName}.flac`,
  );
  downloadTracker.setDownloading(requireFixture(job).id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "downloaded for the playlist");
  downloadTracker.setDone(requireFixture(job).id, file, requireFixture(job).albumName);
  return file;
}

test("deleting a playlist keeps the Library files it reused and deletes the files it downloaded", async () => {
  const reused = { artistName: "Reuse Band", albumName: "Reuse Record", trackName: "Already Here" };
  const downloaded = { artistName: "Fresh Band", albumName: "Fresh Record", trackName: "Fetched" };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices();
  const { playlist, jobFor } = await createPlaylist([reused, downloaded]);
  assert.equal(requireFixture(jobFor(reused)).status, "done");
  assert.equal(requireFixture(jobFor(reused)).finalPath, libraryFile);
  const downloadedFile = await finishDownload(jobFor(downloaded));

  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: playlist!.id,
  });

  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(playlist!.id), null);
  await assert.rejects(fs.access(downloadedFile), { code: "ENOENT" });
  await assertStillInLibrary(libraryFile);
});

test("removing a reused track from a playlist keeps its Library file", async () => {
  const reused = { artistName: "Reuse Band", albumName: "Single Removal", trackName: "Stays Put" };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices();
  const { playlist, jobFor } = await createPlaylist([reused]);
  const jobId = requireFixture(jobFor(reused)).id;

  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete-track",
    playlistId: playlist!.id,
    jobId,
  });

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(playlist!.id)).tracks.length,
    0,
  );
  await assertStillInLibrary(libraryFile);
});

test("a synced playlist that drops a reused track keeps its Library file when removed tracks are not kept", async () => {
  const reused = {
    artistName: "Reuse Band",
    albumName: "Synced Record",
    trackName: "Dropped Upstream",
  };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices();
  const { playlist, jobFor } = await createPlaylist([reused], {
    importSource: {
      provider: "spotify-playlist",
      externalId: "synced",
      syncEnabled: true,
      syncIntervalHours: 24,
      keepRemovedTracks: false,
    },
  });
  const jobId = requireFixture(jobFor(reused)).id;

  await operations.processPlaylistOperation({
    kind: "shared-playlist-update",
    playlistId: playlist!.id,
    tracks: [],
    hasTracksUpdate: true,
    hasImportSourceUpdate: true,
    importSource: { lastSyncAt: Date.now() },
    mergeImportSource: true,
  });

  assert.equal(downloadTracker.getJob(jobId), null);
  await assertStillInLibrary(libraryFile);
});

test("a playlist track repaired onto a Library file keeps that file when the playlist is deleted", async () => {
  const track = {
    artistName: "Repair Band",
    albumName: "Repair Record",
    trackName: "Lost Download",
  };
  mockPlaylistServices();
  const { playlist, jobFor } = await createPlaylist([track]);
  const lostFile = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    "aurral-playlists",
    playlist!.id,
    "Lost Download.flac",
  );
  downloadTracker.setDownloading(requireFixture(jobFor(track)).id);
  downloadTracker.setDone(requireFixture(jobFor(track)).id, lostFile, track.albumName);
  const libraryFile = await addLibraryFile(track);

  await repairReusableTrackLinks({ downloadRoot: process.env.WEEKLY_FLOW_FOLDER });
  assert.equal(requireFixture(jobFor(track)).finalPath, libraryFile);
  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: playlist!.id,
  });

  await assertStillInLibrary(libraryFile);
});

test("a file one playlist downloaded and another reused is deleted once neither playlist uses it", async () => {
  const track = {
    artistName: "Shared Band",
    albumName: "Shared Record",
    trackName: "Passed Along",
  };
  mockPlaylistServices();
  const first = await createPlaylist([track], { name: "Downloaded it" });
  const file = await finishDownload(first.jobFor(track));
  const second = await createPlaylist([track], { name: "Reused it" });
  assert.equal(second.jobFor(track)!.finalPath, file);

  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: first.playlist!.id,
  });
  await fs.access(file);
  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: second.playlist!.id,
  });

  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("a Library file two playlists reused stays after both playlists are deleted", async () => {
  const track = { artistName: "Reuse Band", albumName: "Twice Reused", trackName: "Popular" };
  const libraryFile = await addLibraryFile(track);
  mockPlaylistServices();
  const first = await createPlaylist([track], { name: "Reused first" });
  const second = await createPlaylist([track], { name: "Reused second" });
  assert.equal(second.jobFor(track)!.finalPath, libraryFile);

  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: first.playlist!.id,
  });
  await operations.processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: second.playlist!.id,
  });

  await assertStillInLibrary(libraryFile);
});
