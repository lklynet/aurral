import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

const isolatedState = await createIsolatedStateDir("static-playlist-library-upgrade");
applyIsolatedBackendEnv(isolatedState);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("an install already on the current schema gets the playlist mark column and migrates", async () => {
  const before = await import("../../backend/config/db-sqlite.ts");
  before.db.exec(`
    ALTER TABLE download_jobs DROP COLUMN started_by_playlist;
    DELETE FROM settings WHERE key = 'migration:static-playlists-reference-library-v1';
    INSERT OR REPLACE INTO settings (key, value)
      VALUES ('staticPlaylists', '[{"id":"mix","name":"Mix","tracks":[]}]');
    INSERT INTO download_jobs (id, artist_name, track_name, owner_id, owner_type, status, created_at)
      VALUES ('queued', 'Band', 'Song', 'mix', 'mix', 'pending', 1);
  `);
  before.db.close();
  vi.resetModules();

  const { db } = await import("../../backend/config/db-sqlite.ts");
  assert.deepEqual(
    db
      .prepare<[], { owner_id: string; started_by_playlist: string | null }>(
        "SELECT owner_id, started_by_playlist FROM download_jobs WHERE id = 'queued'",
      )
      .get(),
    { owner_id: "library", started_by_playlist: "mix" },
  );
});
