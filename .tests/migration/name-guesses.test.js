import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading forgets artists and albums guessed from a name and keeps the Library's lookups", async () => {
  const state = await createIsolatedStateDir("name-guesses-migration");
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
    const artist = db.prepare(
      "INSERT INTO musicbrainz_artist_mbid_cache (artist_name_key, mbid, updated_at) VALUES (?, ?, ?)",
    );
    artist.run("koyo feat. drain", "9b0a6218-d0ad-4131-8c80-53b8f78913ee", now);
    artist.run("library:koyo", "52f7e7ff-2e09-47e0-87f3-edcd69b327ae", now);
    const album = db.prepare("INSERT INTO deezer_mbid_cache (cache_key, mbid) VALUES (?, ?)");
    album.run("aa:freddie mercury\0greatest hits iii", "11111111-1111-4111-8111-111111111111");
    album.run("dz:302127", "11111111-1111-4111-8111-111111111111");
    album.run("artist_rg:022589ac-f6ec-4b39-9b8f-2e0b5c66c2ff", "22222222-2222-4222-8222-222222222222");
    db.prepare("DELETE FROM settings WHERE key = 'migration:name-guesses-v1'").run();

    start();

    assert.deepEqual(
      db.prepare("SELECT artist_name_key FROM musicbrainz_artist_mbid_cache").pluck().all(),
      ["library:koyo"],
    );
    assert.deepEqual(
      db.prepare("SELECT cache_key FROM deezer_mbid_cache").pluck().all(),
      ["artist_rg:022589ac-f6ec-4b39-9b8f-2e0b5c66c2ff"],
    );
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
