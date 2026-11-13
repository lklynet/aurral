import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { test } from "vite-plus/test";
import { migrate, migrations } from "../../backend/config/migrations.ts";
import { decryptIntegrations, encryptWithKey } from "../../backend/config/encryption.ts";

const version = (db: Database.Database) => db.pragma("user_version", { simple: true });

test("each migration runs once, in order, and a later release runs only its new ones", () => {
  const db = new Database(":memory:");
  const ran: string[] = [];
  const first = () => ran.push("first");
  const second = () => ran.push("second");

  migrate(db, [first, second]);
  migrate(db, [first, second]);
  assert.deepEqual(ran, ["first", "second"]);
  assert.equal(version(db), 2);

  migrate(db, [first, second, () => ran.push("third")]);
  assert.deepEqual(ran, ["first", "second", "third"]);
  assert.equal(version(db), 3);
});

test("a failed migration leaves the database as it was", () => {
  const db = new Database(":memory:");
  const create = (database: Database.Database) => database.exec("CREATE TABLE kept (id INTEGER)");
  migrate(db, [create]);

  assert.throws(() =>
    migrate(db, [
      create,
      (database) => database.exec("CREATE TABLE added (id INTEGER)"),
      () => {
        throw new Error("broken migration");
      },
    ]),
  );
  assert.equal(version(db), 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'added'").get(), undefined);
});

test("upgrading drops what only Lidarr mode read and keeps the rest", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 2));
  db.exec(`
    ALTER TABLE library_management ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'aurral';
    ALTER TABLE download_jobs ADD COLUMN managed_by TEXT;
    ALTER TABLE users ADD COLUMN lidarr_root_folder_path TEXT;
    ALTER TABLE users ADD COLUMN lidarr_quality_profile_id INTEGER;
    CREATE INDEX idx_library_management_managed_by ON library_management (managed_by);
    CREATE TABLE lidarr_artist_id_map (musicbrainz_id TEXT PRIMARY KEY);
  `);
  const setting = (key: string, value: unknown) =>
    db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  const slskd = { url: "http://slskd.test" };
  const kept = { source: "slskd", remote: "/downloads", local: "/data/downloads" };
  setting("integrations", { lidarr: { url: "http://lidarr.test", apiKey: "key" }, slskd });
  setting("rootFolderPath", "/music");
  setting("pathMappings", [kept, { source: "Lidarr", remote: "/music", local: "/data/music" }]);
  db.prepare(
    `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
     VALUES ('artist', 1, 'aurral', 'all', 1, 1)`,
  ).run();
  const request = db.prepare(
    `INSERT INTO aurral_history (id, kind, title, status, status_label, metadata, created_at)
     VALUES (?, 'album_requested', ?, ?, ?, ?, 1)`,
  );
  request.run(
    "searching",
    "Searching Lidarr for Third",
    "processing",
    "Searching",
    '{"albumName":"Third"}',
  );
  request.run("unnamed", "Searching Lidarr", "processing", "Searching", "not json");
  request.run("requested", "Requested Dummy", "completed", "Requested", null);

  migrate(db);

  const read = (key: string): unknown =>
    JSON.parse(
      db.prepare<[string], string>("SELECT value FROM settings WHERE key = ?").pluck().get(key) ??
        "null",
    );
  assert.deepEqual(read("integrations"), { slskd });
  assert.equal(read("rootFolderPath"), null);
  assert.deepEqual(read("pathMappings"), [kept]);
  assert.deepEqual(db.prepare("SELECT entity_id, monitor_mode FROM library_management").all(), [
    { entity_id: 1, monitor_mode: "all" },
  ]);
  const columns = (table: string) =>
    db.prepare<[string], string>("SELECT name FROM pragma_table_info(?)").pluck().all(table);
  assert.ok(!columns("library_management").includes("managed_by"));
  assert.ok(!columns("download_jobs").includes("managed_by"));
  assert.ok(!columns("users").some((column) => column.startsWith("lidarr_")));
  assert.deepEqual(
    db.prepare("SELECT id, title, status, status_label FROM aurral_history ORDER BY id").all(),
    [
      { id: "requested", title: "Requested Dummy", status: "completed", status_label: "Requested" },
      { id: "searching", title: "Requested Third", status: "completed", status_label: "Requested" },
      { id: "unnamed", title: "Requested album", status: "completed", status_label: "Requested" },
    ],
  );
});

test("upgrading fails finished downloads without a file and statuses Aurral does not read", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 6));
  const insert = db.prepare<[string, string, string | null]>(
    `INSERT INTO download_jobs (id, artist_name, track_name, owner_id, status, final_path, created_at)
     VALUES (?, 'Artist', 'Song', 'library', ?, ?, 1)`,
  );
  insert.run("kept", "done", "/library/Song.flac");
  insert.run("pending", "pending", null);
  insert.run("null-path", "done", null);
  insert.run("empty-path", "done", "");
  insert.run("unknown", "finished", "/library/Other.flac");

  migrate(db);

  assert.deepEqual(db.prepare("SELECT id, status FROM download_jobs ORDER BY id").all(), [
    { id: "empty-path", status: "failed" },
    { id: "kept", status: "done" },
    { id: "null-path", status: "failed" },
    { id: "pending", status: "pending" },
    { id: "unknown", status: "failed" },
  ]);
});

test("upgrading lets albums that failed to load try again, and keeps rate-limit waits", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 7));
  const insert = db.prepare<[string, number, number]>(
    "INSERT INTO metadata_request_state (cache_key, failure_count, retry_after, updated_at) VALUES (?, ?, ?, 1000)",
  );
  const day = 24 * 60 * 60 * 1000;
  insert.run("failed", 3, 1000 + day);
  insert.run("rate-limited", 0, 1000 + 7 * day);
  insert.run("rate-limited-after-failing", 1, 1000 + day / 2);

  migrate(db);

  assert.deepEqual(
    db.prepare("SELECT cache_key FROM metadata_request_state ORDER BY cache_key").pluck().all(),
    ["rate-limited", "rate-limited-after-failing"],
  );
});

test("upgrading names a Usenet job's download by its client and its turned-down releases by album", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 8));
  const insert = db.prepare<[string, string, string, string | null, string | null]>(
    `INSERT INTO download_jobs (id, artist_name, track_name, owner_id, status, download_source,
       download_client, download_client_id, denied_remote_sources, created_at)
     VALUES (?, 'Artist', 'Song', 'library', 'downloading', ?, ?, ?, ?, 1)`,
  );
  insert.run("nzbget", "usenet", "nzbget", "42", JSON.stringify([["usenet", "Guid-A"]]));
  insert.run(
    "tidarr",
    "tidarr",
    "tidarr",
    "SABnzbd_nzo_1",
    JSON.stringify([
      ["tidarr", "123-lossless"],
      ["slskd", "user\0file"],
    ]),
  );
  insert.run("qbittorrent", "qbittorrent", "qbittorrent", "aurral-tag", null);

  migrate(db);

  assert.deepEqual(
    db
      .prepare(
        "SELECT id, download_client, download_client_id, denied_remote_sources FROM download_jobs ORDER BY id",
      )
      .all(),
    [
      {
        id: "nzbget",
        download_client: "usenet",
        download_client_id: "nzbget:42",
        denied_remote_sources: JSON.stringify([["usenet", "album:guid-a"]]),
      },
      {
        id: "qbittorrent",
        download_client: "qbittorrent",
        download_client_id: "aurral-tag",
        denied_remote_sources: null,
      },
      {
        id: "tidarr",
        download_client: "tidarr",
        download_client_id: "tidarr:SABnzbd_nzo_1",
        denied_remote_sources: JSON.stringify([
          ["tidarr", "album:tidarr:123"],
          ["slskd", "user\0file"],
        ]),
      },
    ],
  );
});

test("upgrading drops settings that became fixed and keeps each user's discovery mode", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 9));
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'test', ''), (2, 'listener', '');
  `);
  const setting = (key: string, value: unknown) =>
    db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  setting("integrations", {
    lastfm: { apiKey: "key", discoveryMode: "deeper", discoveryAutoRefreshHours: 24 },
    nzbget: { url: "http://nzbget.test", addPaused: true, deleteLeftovers: false },
    prowlarr: { url: "http://prowlarr.test", categories: [3010], maxResults: 10 },
  });
  setting("security", { ssoOnly: true, localNetworkBypass: { enabled: true } });
  setting("missingTrackSearch", { enabled: false, intervalDays: 3 });
  setting("reviewTimeoutHours", 0);
  setting("subsonic", { favoriteAutoKeep: false });
  setting("playlistFiles", { prefixOwnerUsername: false });

  migrate(db);

  const read = (key: string): unknown =>
    JSON.parse(
      db.prepare<[string], string>("SELECT value FROM settings WHERE key = ?").pluck().get(key) ??
        "null",
    );
  assert.deepEqual(read("integrations"), {
    lastfm: { apiKey: "key" },
    nzbget: { url: "http://nzbget.test" },
    prowlarr: { url: "http://prowlarr.test" },
  });
  assert.deepEqual(read("security"), { localNetworkBypass: { enabled: true } });
  assert.equal(read("user:1:discoveryMode"), "deeper");
  assert.equal(read("user:2:discoveryMode"), "deeper");
  for (const key of ["missingTrackSearch", "reviewTimeoutHours", "subsonic", "playlistFiles"]) {
    assert.equal(read(key), null, key);
  }
});

test("upgrading drops settings nothing reads and keeps a turned-off Inbox off", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 10));
  const insert = db.prepare<[string, string]>("INSERT INTO settings (key, value) VALUES (?, ?)");
  insert.run("quality", "standard");
  insert.run("releaseTypes", JSON.stringify(["Album"]));
  insert.run("queueCleaner", "{}");
  insert.run(
    "integrations",
    JSON.stringify({
      lastfm: { apiKey: "key", discoveryPeriod: "none" },
      ticketmaster: { apiKey: "key", localDiscoveryIncludeTrending: false },
      metadata: { provider: "brainzmash", baseUrl: "https://meta.example", userAgentSuffix: "x" },
    }),
  );
  insert.run("inbox", JSON.stringify({ enabled: false, releases: true, news: true }));

  migrate(db);

  const setting = (key: string) =>
    db.prepare<[string], string>("SELECT value FROM settings WHERE key = ?").pluck().get(key);
  for (const key of ["quality", "releaseTypes", "queueCleaner"]) {
    assert.equal(setting(key), undefined);
  }
  assert.deepEqual(JSON.parse(setting("integrations") ?? ""), {
    lastfm: { apiKey: "key" },
    ticketmaster: { apiKey: "key" },
    metadata: { baseUrl: "https://meta.example" },
  });
  assert.deepEqual(JSON.parse(setting("inbox") ?? ""), {
    releases: false,
    news: false,
    shows: false,
    recommendedNews: false,
    discoveries: false,
  });
});

test("upgrading turns a Gotify setup into a webhook that still reads its token", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, 11));
  const key = randomBytes(32);
  const hook = { url: "http://ntfy.test", headers: [], events: ["notifyFlowDone"] };
  db.prepare("INSERT INTO settings (key, value) VALUES ('integrations', ?)").run(
    JSON.stringify({
      gotify: {
        url: "http://gotify.test/ ",
        token: encryptWithKey("gotify-token", key),
        notifyRequestMade: true,
        notifyFlowDone: false,
        notifyTrackAdded: true,
      },
      webhooks: [hook],
    }),
  );

  migrate(db);

  const stored = db
    .prepare<[], string>("SELECT value FROM settings WHERE key = 'integrations'")
    .pluck()
    .get();
  assert.doesNotMatch(stored ?? "", /gotify-token/);
  assert.deepEqual(decryptIntegrations(JSON.parse(stored ?? ""), key), {
    webhooks: [
      hook,
      {
        url: "http://gotify.test/message",
        headers: [{ key: "X-Gotify-Key", value: "gotify-token" }],
        body: '{"title":"$title","message":"$message","priority":5}',
        events: ["notifyRequestMade", "notifyTrackAdded"],
      },
    ],
  });
});
