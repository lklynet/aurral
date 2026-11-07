import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

const isolatedState = await createIsolatedStateDir("reused-library-file-marker");
const root = path.join(isolatedState.baseDir, "weekly-flow");
const playlistId = "legacy-playlist";
const files = {
  reused: path.join(root, "Legacy Band", "Old Record", "Reused.flac"),
  reusedAfterFailedDownload: path.join(root, "Legacy Band", "Old Record", "Retried.flac"),
  downloaded: path.join(root, "Legacy Band", "Old Record", "Downloaded.flac"),
};
for (const file of Object.values(files)) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
}

const seed = new Database(isolatedState.dbPath);
seed.exec(`
  CREATE TABLE playlist_download_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    playlist_id TEXT NOT NULL,
    playlist_type TEXT,
    status TEXT NOT NULL,
    staging_path TEXT,
    final_path TEXT,
    external_path TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE library_media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    album_id INTEGER,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    format TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER,
    duration_ms INTEGER,
    quality_json TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    last_seen_scan_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, path)
  );
`);
const insertJob = seed.prepare(`
  INSERT INTO playlist_download_jobs
    (id, artist_name, track_name, album_name, playlist_id, playlist_type, status, final_path, started_at, completed_at, created_at)
  VALUES (?, 'Legacy Band', ?, 'Old Record', ?, ?, 'done', ?, ?, 2000, 1000)
`);
insertJob.run("reused", "Reused", playlistId, playlistId, files.reused, null);
insertJob.run(
  "reused-after-failed-download",
  "Retried",
  playlistId,
  playlistId,
  files.reusedAfterFailedDownload,
  1500,
);
insertJob.run("downloaded", "Downloaded", playlistId, playlistId, files.downloaded, 1500);
const insertMedia = seed.prepare(`
  INSERT INTO library_media_files (track_id, source, path, created_at, updated_at) VALUES (?, 'aurral', ?, ?, ?)
`);
insertMedia.run(1, files.reusedAfterFailedDownload, 500, 500);
insertMedia.run(2, files.downloaded, 2500, 2500);
seed.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
seed.prepare("INSERT INTO settings (key, value) VALUES ('staticPlaylists', ?)").run(
  JSON.stringify([
    {
      id: playlistId,
      name: "Saved before the marker",
      importSource: { provider: "spotify-playlist", externalId: "old", keepRemovedTracks: false },
      tracks: ["Reused", "Retried", "Downloaded"].map((trackName) => ({
        artistName: "Legacy Band",
        albumName: "Old Record",
        trackName,
      })),
    },
  ]),
);
seed.close();
applyIsolatedBackendEnv(isolatedState);

const { flowPlaylistConfig } =
  await import("../../backend/services/playlists/flowPlaylistConfig.ts");
const { downloadTracker } = await import("../../backend/services/downloadJobs/downloadTracker.ts");
const { playlistManager } = await import("../../backend/services/playlists/playlistManager.ts");
const { processPlaylistOperation } =
  await import("../../backend/services/playlists/playlistOperations.ts");

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a synced playlist saved by an older version deletes only the files it downloaded", async () => {
  vi.spyOn(playlistManager, "requestPlaylistSync").mockReturnValue(undefined);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockReturnValue(0);
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  assert.ok(playlist != null);
  assert.deepEqual(
    playlist.tracks.map((track) => downloadTracker.getJob(track.canonicalJobId)?.addedBy ?? null),
    [null, null, playlistId],
  );

  await processPlaylistOperation({
    kind: "static-playlist-update",
    playlistId,
    tracks: [],
    hasTracksUpdate: true,
    mergeImportSource: true,
  });

  await fs.access(files.reused);
  await fs.access(files.reusedAfterFailedDownload);
  await assert.rejects(fs.access(files.downloaded), { code: "ENOENT" });
});
