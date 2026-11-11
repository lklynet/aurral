import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, test } from "vite-plus/test";
import { migrate } from "../../backend/config/migrations.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { convertLidarrLibrary },
  { libraryFolderOwner, readOnlyFolderPaths, saveReadOnlyFolderPaths },
  { resolveDownloadRoot },
  { dismissLidarrConversionReport },
  { invalidateLibraryManagementCache },
] = await setupIsolatedBackend(
  "lidarr-conversion",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/lidarr-conversion.ts"),
  () => import("../../backend/services/libraryFolders.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/lidarrConversionReport.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
);

// The conversion runs on a 2.x database, before the columns it reads are dropped.
db.exec(`
  ALTER TABLE library_management ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'aurral';
  ALTER TABLE download_jobs ADD COLUMN managed_by TEXT;
`);

const libraryFolder = resolveDownloadRoot();
const snapshot = path.join(state.dataDir, "aurral.pre-lidarr-conversion.db");

beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  fs.rmSync(snapshot, { force: true });
  dbOps.invalidateSettingsCache();
});
afterAll(() => cleanupIsolatedState(state));

function connectLidarr(rootFolderPaths: string[], pathMappings: unknown[] = []) {
  dbOps.setJSONSetting("integrations", {
    lidarr: { url: "http://lidarr.test", apiKey: "key", rootFolderPaths },
  });
  dbOps.setJSONSetting("pathMappings", pathMappings);
}

function convert() {
  const report = convertLidarrLibrary(db, state.dataDir);
  dbOps.invalidateSettingsCache();
  invalidateLibraryManagementCache();
  return report;
}

const insertId = (sql: string, ...values: unknown[]) =>
  Number(db.prepare(sql).run(...values).lastInsertRowid);

const artist = (name: string, metadata: object = {}, mbid: string | null = null) =>
  insertId(
    "INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    `artist:${name}`,
    mbid,
    name,
    JSON.stringify(metadata),
  );

const album = (artistId: number, title: string, metadata: object = {}) =>
  insertId(
    "INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    `album:${title}`,
    artistId,
    title,
    JSON.stringify(metadata),
  );

const track = (title: string) =>
  insertId(
    "INSERT INTO library_tracks (identity_key, title, created_at, updated_at) VALUES (?, ?, 1, 1)",
    `track:${title}`,
    title,
  );

const media = (trackId: number, source: string, filePath: string) =>
  insertId(
    "INSERT INTO library_media_files (track_id, source, path, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    trackId,
    source,
    filePath,
  );

const manage = (kind: string, id: number, managedBy: string, mode: string | null, rules?: string) =>
  db
    .prepare(
      "INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, monitor_rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
    )
    .run(kind, id, managedBy, mode, rules ?? null);

const job = (id: string, status: string, managedBy: string) =>
  db
    .prepare(
      "INSERT INTO download_jobs (id, artist_name, track_name, owner_id, owner_type, status, managed_by, created_at) VALUES (?, 'Band', ?, 'library', 'library', ?, ?, 1)",
    )
    .run(id, id, status, managedBy);

const mediaRows = () =>
  db
    .prepare<[], { id: number; track_id: number; source: string; path: string }>(
      "SELECT id, track_id, source, path FROM library_media_files ORDER BY path",
    )
    .all();

const management = (kind: string, id: number) =>
  db
    .prepare<
      [string, number],
      { managed_by: string; monitor_mode: string | null; monitor_rules: string | null }
    >(
      "SELECT managed_by, monitor_mode, monitor_rules FROM library_management WHERE entity_kind = ? AND entity_id = ?",
    )
    .get(kind, id);

test("an install that Lidarr ran keeps its music in read-only folders, and its artists become Aurral's, unmonitored", () => {
  const lidarrFolder = path.join(state.baseDir, "lidarr");
  const otherFolder = path.join(state.baseDir, "other");
  connectLidarr(
    ["/lidarr-music"],
    [{ source: "lidarr", remote: "/lidarr-music", local: lidarrFolder }],
  );
  saveReadOnlyFolderPaths([otherFolder]);

  const band = artist("Band", {
    librarySource: "lidarr",
    id: 7,
    monitored: true,
    genres: ["rock"],
  });
  const record = album(band, "Record", { librarySource: "lidarr", id: 70 });
  const song = track("Song");
  const lidarrFile = path.join(lidarrFolder, "Band", "Record", "01 Song.flac");
  const lidarrMedia = media(song, "lidarr", lidarrFile);
  manage("artist", band, "lidarr", "all");
  manage("album", record, "lidarr", "monitored");

  const own = artist("Own");
  const ownFile = path.join(libraryFolder, "Own", "01 Mine.flac");
  const mine = track("Mine");
  const ownMedia = media(mine, "aurral", ownFile);
  manage("artist", own, "aurral", "all", '{"default":true}');

  job("waiting", "pending", "lidarr");
  job("finished", "done", "lidarr");

  const report = convert();

  assert.deepEqual(report?.folders, [
    { lidarrPath: "/lidarr-music", path: lidarrFolder, sharesLibraryFolder: false },
  ]);
  assert.deepEqual(report?.artistIds, [band]);
  assert.deepEqual(readOnlyFolderPaths().sort(), [lidarrFolder, otherFolder].sort());
  assert.deepEqual(mediaRows(), [
    { id: lidarrMedia, track_id: song, source: "readonly", path: lidarrFile },
    { id: ownMedia, track_id: mine, source: "aurral", path: ownFile },
  ]);
  assert.deepEqual(management("artist", band), {
    managed_by: "aurral",
    monitor_mode: "none",
    monitor_rules: null,
  });
  assert.deepEqual(management("album", record), {
    managed_by: "aurral",
    monitor_mode: null,
    monitor_rules: null,
  });
  assert.deepEqual(management("artist", own), {
    managed_by: "aurral",
    monitor_mode: "all",
    monitor_rules: '{"default":true}',
  });
  assert.deepEqual(
    JSON.parse(
      db
        .prepare<[number], string>("SELECT metadata_json FROM library_artists WHERE id = ?")
        .pluck()
        .get(band)!,
    ),
    { genres: ["rock"] },
  );
  assert.deepEqual(
    db.prepare("SELECT id, status, managed_by FROM download_jobs ORDER BY id").all(),
    [
      { id: "finished", status: "done", managed_by: "aurral" },
      { id: "waiting", status: "cancelled", managed_by: "aurral" },
    ],
  );
  assert.ok(fs.existsSync(snapshot));

  connectLidarr(["/elsewhere"]);
  assert.equal(convert(), null);
  assert.deepEqual(readOnlyFolderPaths().sort(), [lidarrFolder, otherFolder].sort());
});

test("a folder Lidarr shared with the Library folder becomes read-only, and each file keeps one entry", () => {
  connectLidarr([libraryFolder]);
  const shared = path.join(libraryFolder, "Band", "01 Shared.flac");
  const aurralOnly = path.join(libraryFolder, "Band", "02 Aurral.flac");
  const sharedTrack = track("Shared");
  media(sharedTrack, "aurral", shared);
  media(sharedTrack, "lidarr", shared);
  const aurralTrack = track("Aurral");
  media(aurralTrack, "aurral", aurralOnly);

  const report = convert();

  assert.deepEqual(report?.folders, [
    { lidarrPath: libraryFolder, path: libraryFolder, sharesLibraryFolder: true },
  ]);
  assert.deepEqual(
    mediaRows().map((row) => [row.track_id, row.source, row.path]),
    [
      [sharedTrack, "readonly", shared],
      [aurralTrack, "readonly", aurralOnly],
    ],
  );
  assert.equal(libraryFolderOwner(shared), "readonly");
});

test("a conversion that fails changes nothing, and Aurral keeps the copy it made first", () => {
  const lidarrFolder = path.join(state.baseDir, "lidarr");
  connectLidarr([lidarrFolder]);
  const band = artist("Band");
  manage("artist", band, "lidarr", "all");
  const lidarrMedia = media(track("Song"), "lidarr", path.join(lidarrFolder, "01 Song.flac"));
  db.exec(`CREATE TEMP TRIGGER fail_conversion BEFORE INSERT ON settings
    WHEN NEW.key = 'lidarrConversion' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

  try {
    assert.throws(convert, /disk full/);
  } finally {
    db.exec("DROP TRIGGER fail_conversion");
    dbOps.invalidateSettingsCache();
  }

  assert.deepEqual(
    mediaRows().map((row) => [row.id, row.source]),
    [[lidarrMedia, "lidarr"]],
  );
  assert.equal(management("artist", band)?.managed_by, "lidarr");
  assert.deepEqual(readOnlyFolderPaths(), []);
  assert.ok(fs.existsSync(snapshot));
});

test("dismissing the report can start default monitoring for the artists Lidarr ran, once", () => {
  connectLidarr([path.join(state.baseDir, "lidarr")]);
  const band = artist("Band", {}, "11111111-1111-4111-8111-111111111111");
  manage("artist", band, "lidarr", "all");
  const own = artist("Own", {}, "22222222-2222-4222-8222-222222222222");
  manage("artist", own, "aurral", "none");
  convert();

  assert.deepEqual(dismissLidarrConversionReport({ monitorArtists: true }), {
    monitoredArtists: 1,
  });

  assert.match(management("artist", band)!.monitor_rules!, /"default":true/);
  assert.equal(management("artist", own)?.monitor_rules, null);
  assert.deepEqual(dismissLidarrConversionReport({ monitorArtists: true }), {
    monitoredArtists: 0,
  });
});

test("an install that never used Lidarr is left alone", () => {
  const ownFile = path.join(libraryFolder, "Own", "01 Mine.flac");
  media(track("Mine"), "aurral", ownFile);

  assert.equal(convert(), null);

  assert.deepEqual(
    mediaRows().map((row) => [row.source, row.path]),
    [["aurral", ownFile]],
  );
  assert.equal(fs.existsSync(snapshot), false);
});

test("an install already on Aurral 3 is left alone, even with Lidarr settings left behind", () => {
  const upgraded = new Database(":memory:");
  upgraded.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(upgraded);
  upgraded
    .prepare("INSERT INTO settings (key, value) VALUES ('integrations', ?)")
    .run(JSON.stringify({ lidarr: { url: "http://lidarr.test", apiKey: "key" } }));

  assert.equal(convertLidarrLibrary(upgraded, state.dataDir), null);
  assert.equal(fs.existsSync(snapshot), false);
});
