import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { insertJob } from "../helpers/jobs.ts";
import { requireFixture } from "../playlists/fixtures.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { downloadTracker },
  { registerDownloadProviderWork, listDownloadProviderWork },
  { migrateStaticPlaylistsToLibrary },
] = await setupIsolatedBackend(
  "static-playlist-library-migration",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/config/static-playlist-library-migration.ts"),
);
beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
  invalidateFlowPlaylistConfigCache();
});
afterAll(() => cleanupIsolatedState(state));

const track = (trackName: string) => ({ artistName: "Band", albumName: "Record", trackName });

function job(trackName: string, owner: string, finalPath?: string) {
  const id = downloadTracker.addJob(track(trackName), owner);
  assert.ok(id != null);
  if (finalPath) downloadTracker.setDone(id, finalPath, "Record");
  return id;
}

function migrate() {
  db.prepare("DELETE FROM settings WHERE key LIKE 'migration:static-playlists-%'").run();
  migrateStaticPlaylistsToLibrary(db);
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
  downloadTracker.reconcileCommittedJobs();
}

test("static playlist downloads move to the Library, marked only when one playlist uses them", () => {
  const libraryCopy = job("Shared", "library", "/music/shared.flac");
  const downloaded = job("Downloaded", "mix", "/music/downloaded.flac");
  const queued = job("Queued", "mix");
  const orphan = job("Orphan", "mix", "/music/orphan.flac");
  const duplicate = job("Shared", "mix", "/music/shared.flac");
  flowPlaylistConfig.createStaticPlaylist({
    id: "mix",
    name: "Mix",
    tracks: [
      { ...track("Downloaded"), canonicalJobId: downloaded },
      track("Queued"),
      { ...track("Shared"), canonicalJobId: duplicate },
    ],
  });
  flowPlaylistConfig.createStaticPlaylist({
    id: "other",
    name: "Other",
    tracks: [
      { ...track("Shared"), canonicalJobId: duplicate },
      { ...track("Downloaded"), canonicalJobId: downloaded },
    ],
  });
  const pipelineId = insertJob(db, "download-pipeline", {
    jobId: queued,
    playlistId: "mix",
    playlistGeneration: 0,
    phase: "search",
  });
  const upgradeId = insertJob(db, "download-pipeline", {
    jobId: "upgrade",
    upgradeForJobId: duplicate,
    playlistId: "mix",
    playlistGeneration: 0,
    phase: "search",
  });
  registerDownloadProviderWork({
    jobId: queued,
    playlistId: "mix",
    provider: "slskd-search",
    workId: "queued-search",
  });

  migrate();

  const mix = flowPlaylistConfig.getStaticPlaylist("mix");
  assert.ok(mix != null);
  assert.deepEqual(
    mix.tracks.map((entry) => [entry.trackName, entry.canonicalJobId]),
    [
      ["Downloaded", downloaded],
      ["Queued", queued],
      ["Shared", libraryCopy],
      ["Orphan", orphan],
    ],
  );
  assert.ok(mix.tracks[3]?.membershipId);
  assert.equal(
    flowPlaylistConfig.getStaticPlaylist("other")?.tracks[0]?.canonicalJobId,
    libraryCopy,
  );
  assert.equal(downloadTracker.getJob(duplicate), null);
  assert.deepEqual(
    [downloaded, queued, orphan, libraryCopy].map((id) => {
      const migrated = downloadTracker.getJob(id);
      return [migrated?.playlistType, migrated?.addedBy];
    }),
    [
      ["library", null],
      ["library", "mix"],
      ["library", "mix"],
      ["library", null],
    ],
  );
  const payload = db
    .prepare<[number], { payload: string }>("SELECT payload FROM jobs WHERE id = ?")
    .get(pipelineId);
  assert.equal(JSON.parse(payload!.payload).playlistId, "library");
  const upgrade = db
    .prepare<[number], { payload: string }>("SELECT payload FROM jobs WHERE id = ?")
    .get(upgradeId);
  assert.equal(JSON.parse(requireFixture(upgrade).payload).upgradeForJobId, libraryCopy);
  assert.equal(listDownloadProviderWork({ playlistId: "library" }).length, 1);
});

test("files a playlist reused from the Library are not marked as its own", () => {
  const reused = job("Reused", "mix", "/music/reused.flac");
  db.prepare("UPDATE download_jobs SET reused_library_file = 1 WHERE id = ?").run(reused);
  flowPlaylistConfig.createStaticPlaylist({
    id: "mix",
    name: "Mix",
    tracks: [{ ...track("Reused"), canonicalJobId: reused }],
  });

  migrate();

  assert.equal(downloadTracker.getJob(reused)?.playlistType, "library");
  assert.equal(downloadTracker.getJob(reused)?.addedBy, null);
});
