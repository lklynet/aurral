import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("malformed artist metadata does not break startup or indexed reference lookup", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "aurral-malformed-metadata-"));
  const dbPath = path.join(dataDir, "aurral.db");
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE library_artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_key TEXT NOT NULL UNIQUE,
      mbid TEXT,
      name TEXT NOT NULL,
      sort_name TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO library_artists
      (identity_key, name, metadata_json, created_at, updated_at)
    VALUES ('malformed:artist', 'Malformed Artist', '{', 1, 1);
  `);
  seedDb.close();

  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          const { db } = await import("./backend/config/db-sqlite.js");
          const {
            linkLibraryAlbumTrack,
            upsertLibraryAlbum,
            upsertLibraryArtist,
            upsertLibraryMediaFile,
            upsertLibraryTrack,
          } = await import("./backend/services/libraryMediaStore.js");
          const { getCanonicalLibraryForArtistReferences } = await import("./backend/services/libraryQueryService.js");
          const artist = upsertLibraryArtist({
            identityKey: "valid:artist",
            mbid: "valid-artist-mbid",
            name: "Valid Artist",
            metadata: { id: "valid-provider-id" },
          });
          const album = upsertLibraryAlbum({
            identityKey: "valid:album",
            artistId: artist.id,
            title: "Valid Album",
          });
          const track = upsertLibraryTrack({
            identityKey: "valid:track",
            title: "Valid Track",
          });
          linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
          upsertLibraryMediaFile({
            trackId: track.id,
            albumId: album.id,
            source: "aurral",
            path: "/tmp/valid-track.flac",
          });
          const result = getCanonicalLibraryForArtistReferences({
            references: ["valid-provider-id"],
          });
          const expression = "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)";
          const plan = db.prepare(
            "EXPLAIN QUERY PLAN SELECT id FROM library_artists WHERE " + expression + " IN (?)",
          ).all("valid-provider-id");
          process.stdout.write(JSON.stringify({
            artistNames: result.artists.map(({ name }) => name),
            indexSql: db.prepare(
              "SELECT sql FROM sqlite_master WHERE name = 'idx_library_artists_provider_id'",
            ).get().sql,
            plan,
          }));
        `,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, AURRAL_DATA_DIR: dataDir, AURRAL_DB_PATH: dbPath },
        encoding: "utf8",
      },
    );
    const evidence = JSON.parse(output);
    assert.deepEqual(evidence.artistNames, ["Valid Artist"]);
    assert.match(evidence.indexSql, /json_valid\(metadata_json\)/);
    assert.equal(
      evidence.plan.some(({ detail }) => detail.includes("idx_library_artists_provider_id")),
      true,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
