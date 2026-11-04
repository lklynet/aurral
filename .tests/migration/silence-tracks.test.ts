import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading drops [silence] tracks without a file and keeps silence files", async () => {
  const state = await createIsolatedStateDir("silence-tracks");
  const start = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { db } = await import("./backend/config/db-sqlite.ts"); db.close();',
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: {
          ...process.env,
          AURRAL_DATA_DIR: state.dataDir,
          AURRAL_DB_PATH: state.dbPath,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };

  start();
  const db = new Database(state.dbPath);
  try {
    const now = Date.now();
    const artistId = db
      .prepare(
        "INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES ('artist:quiet', 'Quiet', ?, ?)",
      )
      .run(now, now).lastInsertRowid;
    const albumId = db
      .prepare(
        "INSERT INTO library_albums (identity_key, artist_id, title, created_at, updated_at) VALUES ('album:quiet', ?, 'Quiet', ?, ?)",
      )
      .run(artistId, now, now).lastInsertRowid;
    const addTrack = (key: string, title: string, trackNumber: number, file: boolean) => {
      const trackId = db
        .prepare(
          "INSERT INTO library_tracks (identity_key, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(key, title, now, now).lastInsertRowid;
      db.prepare(
        "INSERT INTO library_album_tracks (album_id, track_id, track_number, created_at) VALUES (?, ?, ?, ?)",
      ).run(albumId, trackId, trackNumber, now);
      db.prepare(
        "INSERT INTO library_search_documents (entity_kind, entity_id, title) VALUES ('track', ?, ?)",
      ).run(trackId, title);
      if (file) {
        db.prepare(
          "INSERT INTO library_media_files (track_id, album_id, source, path, created_at, updated_at) VALUES (?, ?, 'aurral', ?, ?, ?)",
        ).run(trackId, albumId, `/music/${key}.flac`, now, now);
      }
    };
    addTrack("song", "Song", 1, false);
    addTrack("missing-silence", "[silence]", 2, false);
    addTrack("filed-silence", "[Silence]", 3, true);
    db.prepare("DELETE FROM settings WHERE key = 'migration:silence-tracks-v1'").run();

    start();

    assert.deepEqual(
      db
        .prepare(
          `SELECT track.identity_key FROM library_album_tracks AS link
           JOIN library_tracks AS track ON track.id = link.track_id
           ORDER BY link.track_number`,
        )
        .pluck()
        .all(),
      ["song", "filed-silence"],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT title FROM library_search_documents WHERE entity_kind = 'track' ORDER BY entity_id",
        )
        .pluck()
        .all(),
      ["Song", "[Silence]"],
    );
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
