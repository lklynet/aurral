import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading moves album monitoring onto tracks and claims unowned Aurral downloads", async () => {
  const state = await createIsolatedStateDir("aurral-track-monitoring-migration");
  const start = () => {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      'const { db } = await import("./backend/config/db-sqlite.js"); db.close();',
    ], {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        AURRAL_DATA_DIR: state.dataDir,
        AURRAL_DB_PATH: state.dbPath,
        NODE_ENV: "test",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  };

  start();
  const db = new Database(state.dbPath);
  try {
    const now = Date.now();
    const artistId = db.prepare(
      "INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES ('artist:upgrade', 'Upgrade Artist', ?, ?)",
    ).run(now, now).lastInsertRowid;
    const addAlbum = (key, { managedBy = null, monitorMode = null, monitored = true } = {}) => {
      const albumId = db.prepare(
        `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(key, artistId, key, JSON.stringify({ monitored }), now, now).lastInsertRowid;
      if (managedBy) {
        db.prepare(
          `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
           VALUES ('album', ?, ?, ?, ?, ?)`,
        ).run(albumId, managedBy, monitorMode, now, now);
      }
      return albumId;
    };
    const addTrack = (key, albumIds, file = null) => {
      const trackId = db.prepare(
        "INSERT INTO library_tracks (identity_key, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(key, key, now, now).lastInsertRowid;
      for (const albumId of albumIds) {
        db.prepare(
          "INSERT INTO library_album_tracks (album_id, track_id, created_at) VALUES (?, ?, ?)",
        ).run(albumId, trackId, now);
      }
      if (file) {
        db.prepare(
          `INSERT INTO library_media_files (track_id, album_id, source, path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(trackId, albumIds[0], file.source, file.path, now, now);
      }
      return trackId;
    };

    const monitoredAlbum = addAlbum("album:monitored", { managedBy: "aurral" });
    const unmonitoredAlbum = addAlbum("album:unmonitored", {
      managedBy: "aurral",
      monitorMode: "unmonitored",
      monitored: false,
    });
    const lidarrAlbum = addAlbum("album:lidarr", { managedBy: "lidarr", monitored: false });
    const playlistAlbum = addAlbum("album:playlist");
    const flowAlbum = addAlbum("album:flow");

    const inMonitored = addTrack("track:monitored", [monitoredAlbum]);
    const inUnmonitored = addTrack("track:unmonitored", [unmonitoredAlbum]);
    const shared = addTrack("track:shared", [unmonitoredAlbum, monitoredAlbum]);
    const inLidarr = addTrack("track:lidarr", [lidarrAlbum]);
    const downloaded = addTrack("track:downloaded", [playlistAlbum], {
      source: "aurral",
      path: "/music/Upgrade Artist/Playlist/01.flac",
    });
    const copiedIn = addTrack("track:copied-in", [playlistAlbum], {
      source: "aurral",
      path: "/music/Upgrade Artist/Playlist/02.flac",
    });
    const flowTrack = addTrack("track:flow", [flowAlbum], {
      source: "flow",
      path: "/music/_flows/weekly/01.flac",
    });
    db.prepare(
      `INSERT INTO playlist_download_jobs
        (id, artist_name, track_name, playlist_id, status, final_path, created_at)
       VALUES ('job-downloaded', 'Upgrade Artist', 'track:downloaded', 'synced', 'done', ?, ?)`,
    ).run("/music/Upgrade Artist/Playlist/01.flac", now);
    db.prepare("DELETE FROM settings WHERE key LIKE 'migration:aurral-track-monitoring%'").run();

    start();

    const monitored = (trackId) =>
      db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(trackId).monitored;
    const owner = (albumId) =>
      db.prepare(
        "SELECT managed_by AS managedBy, monitor_mode AS monitorMode FROM library_management WHERE entity_kind = 'album' AND entity_id = ?",
      ).get(albumId) || null;
    const albumMonitored = (albumId) =>
      JSON.parse(db.prepare("SELECT metadata_json FROM library_albums WHERE id = ?").get(albumId).metadata_json).monitored;

    assert.deepEqual(
      [inMonitored, inUnmonitored, shared, inLidarr, downloaded, copiedIn, flowTrack].map(monitored),
      [1, 0, 1, 1, 1, 0, 1],
    );
    assert.deepEqual(owner(playlistAlbum), { managedBy: "aurral", monitorMode: null });
    assert.equal(albumMonitored(playlistAlbum), false);
    assert.equal(owner(flowAlbum), null);
    assert.deepEqual(owner(lidarrAlbum), { managedBy: "lidarr", monitorMode: null });
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
