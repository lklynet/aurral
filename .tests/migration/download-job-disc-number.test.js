import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("download-job-disc-number");
const seed = new Database(isolatedState.dbPath);
seed.exec(`
  CREATE TABLE playlist_download_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    track_number INTEGER,
    playlist_id TEXT NOT NULL,
    playlist_type TEXT,
    status TEXT NOT NULL,
    staging_path TEXT,
    final_path TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  INSERT INTO playlist_download_jobs
    (id, artist_name, track_name, album_name, track_number, playlist_id, playlist_type, status, created_at)
    VALUES ('before-discs', 'Bush', 'Bomb', 'Sixteen Stone', 3, 'library', 'library', 'pending', 1);
`);
seed.close();
applyIsolatedBackendEnv(isolatedState);

const { downloadTracker, DownloadTracker } = await importFromRepo("backend/services/downloadJobs/downloadTracker.js");
const { buildTrackFileName } = await importFromRepo("backend/services/downloadUtils.js");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a job saved before disc numbers keeps its name and can learn its disc", () => {
  const job = downloadTracker.getJob("before-discs");
  assert.equal(job.discNumber, null);
  assert.equal(buildTrackFileName(job, ".flac"), "03 - Bomb.flac");

  assert.equal(downloadTracker.updateMetadata("before-discs", { discNumber: 2 }), true);
  const restarted = new DownloadTracker().getJob("before-discs");
  assert.equal(buildTrackFileName(restarted, ".flac"), "2-03 - Bomb.flac");
});
