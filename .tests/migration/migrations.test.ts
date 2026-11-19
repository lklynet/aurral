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

test("upgrading gives ownerless playlists and flows to the first admin and turns Blends on", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, -11));
  db.exec(`
    INSERT INTO users (id, username, password_hash, role) VALUES
      (1, 'listener', 'hash', 'user'), (2, 'lee', 'hash', 'admin'), (3, 'ada', 'hash', 'admin');
  `);
  const store = db.prepare<[string, string]>("INSERT INTO settings (key, value) VALUES (?, ?)");
  store.run("staticPlaylists", JSON.stringify([{ id: "old" }, { id: "mine", ownerUserId: 1 }]));
  store.run("flows", JSON.stringify([{ id: "flow", ownerUserId: null }]));

  migrate(db);

  const owners = (key: string) =>
    db
      .prepare<[string], string>(
        "SELECT json_group_array(item.value ->> '$.ownerUserId') FROM settings, json_each(settings.value) AS item WHERE settings.key = ?",
      )
      .pluck()
      .get(key);
  assert.equal(owners("staticPlaylists"), "[2,1]");
  assert.equal(owners("flows"), "[2]");
  assert.deepEqual(db.prepare("SELECT DISTINCT blend FROM users").pluck().all(), [1]);
});

test("upgrading restores track credits from stored ARTISTS tags", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, -5));
  db.prepare("INSERT INTO settings (key, value) VALUES ('librarySearchIndexVersion', '3')").run();
  const insert = db.prepare<[string, string, string, string]>(
    `INSERT INTO library_tracks
       (identity_key, title, artist_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 10, 20)`,
  );
  insert.run(
    "missing-guest",
    "Missing Guest",
    "PinkPantheress",
    JSON.stringify({
      tags: {
        artist: "PinkPantheress",
        albumartist: "PinkPantheress",
        artists: ["PinkPantheress", "Anitta"],
      },
    }),
  );
  insert.run(
    "full-credit",
    "Full Credit",
    "PinkPantheress with Anitta",
    JSON.stringify({
      tags: {
        artist: "PinkPantheress with Anitta",
        albumartist: "PinkPantheress",
        artists: ["PinkPantheress", "Anitta"],
      },
    }),
  );
  insert.run(
    "corrected",
    "Corrected",
    "Manual credit",
    JSON.stringify({
      tags: {
        artist: "PinkPantheress",
        albumartist: "PinkPantheress",
        artists: ["PinkPantheress", "Anitta"],
      },
    }),
  );
  insert.run(
    "already-restored",
    "Already Restored",
    "PinkPantheress, Anitta",
    JSON.stringify({
      tags: {
        artist: "PinkPantheress",
        albumartist: "PinkPantheress",
        artists: ["PinkPantheress", "Anitta"],
      },
    }),
  );
  const insertFile = db.prepare<[number, string, string]>(
    `INSERT INTO library_media_files (track_id, source, path, artist_tag, created_at, updated_at)
     VALUES (?, 'library', ?, ?, 10, 20)`,
  );
  insertFile.run(1, "/music/missing-guest.flac", "PinkPantheress");
  insertFile.run(1, "/music/missing-guest.mp3", "PinkPantheress feat. Anitta");
  insertFile.run(3, "/music/corrected.flac", "PinkPantheress");
  insertFile.run(4, "/music/already-restored.flac", "PinkPantheress");

  migrate(db);

  assert.deepEqual(
    db
      .prepare("SELECT identity_key, artist_name, updated_at FROM library_tracks ORDER BY id")
      .all(),
    [
      { identity_key: "missing-guest", artist_name: "PinkPantheress, Anitta", updated_at: 20 },
      {
        identity_key: "full-credit",
        artist_name: "PinkPantheress with Anitta",
        updated_at: 20,
      },
      { identity_key: "corrected", artist_name: "Manual credit", updated_at: 20 },
      { identity_key: "already-restored", artist_name: "PinkPantheress, Anitta", updated_at: 20 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT path, artist_tag FROM library_media_files ORDER BY id").all(),
    [
      { path: "/music/missing-guest.flac", artist_tag: "PinkPantheress, Anitta" },
      { path: "/music/missing-guest.mp3", artist_tag: "PinkPantheress feat. Anitta" },
      { path: "/music/corrected.flac", artist_tag: "PinkPantheress" },
      { path: "/music/already-restored.flac", artist_tag: "PinkPantheress, Anitta" },
    ],
  );
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key = 'librarySearchIndexVersion'").get(),
    undefined,
  );
});

test("upgrading drops what only Last.fm read and keeps the rest", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db, migrations.slice(0, -3));
  db.exec(`
    ALTER TABLE users ADD COLUMN lastfm_username TEXT;
    CREATE TABLE lastfm_link_states (token_hash TEXT PRIMARY KEY);
    INSERT INTO users (id, username, password_hash) VALUES (1, 'lee', 'hash'), (2, 'ada', 'hash');
    INSERT INTO listen_history_sources (user_id, provider, account) VALUES
      (1, 'lastfm', 'lee'), (1, 'listenbrainz', 'lee');
  `);
  const store = db.prepare<[string, string]>("INSERT INTO settings (key, value) VALUES (?, ?)");
  const slskd = { url: "http://slskd.test" };
  const listenbrainz = { token: "sealed", displayName: "lee" };
  store.run("integrations", JSON.stringify({ lastfm: { apiKey: "key" }, slskd }));
  store.run(
    "scrobbleConnections",
    JSON.stringify({ 1: { lastfm: { token: "sealed" }, listenbrainz }, 2: { lastfm: {} } }),
  );
  store.run("lastfmRejectedKey", JSON.stringify("fingerprint"));
  const job = db.prepare<[string, string, string, string]>(
    "INSERT INTO jobs (queue, kind, payload, state, run_at, max_attempts, created_at) VALUES (?, ?, ?, ?, 0, 1, 0)",
  );
  job.run("play-events", "play-events", JSON.stringify({ provider: "lastfm" }), "pending");
  job.run("play-events", "play-events", JSON.stringify({ provider: "lastfm" }), "running");
  job.run("play-events", "play-events", JSON.stringify({ provider: "listenbrainz" }), "pending");
  job.run("maintenance", "lastfm-key-check", "{}", "pending");
  job.run("maintenance", "lastfm-key-check", "{}", "done");

  migrate(db);

  const read = (key: string): unknown =>
    JSON.parse(
      db.prepare<[string], string>("SELECT value FROM settings WHERE key = ?").pluck().get(key) ??
        "null",
    );
  assert.deepEqual(read("integrations"), { slskd });
  assert.deepEqual(read("scrobbleConnections"), { 1: { listenbrainz } });
  assert.equal(read("lastfmRejectedKey"), null);
  assert.deepEqual(db.prepare("SELECT provider FROM listen_history_sources").pluck().all(), [
    "listenbrainz",
  ]);
  assert.deepEqual(db.prepare("SELECT kind, state, payload FROM jobs ORDER BY id").all(), [
    { kind: "play-events", state: "pending", payload: '{"provider":"listenbrainz"}' },
    { kind: "lastfm-key-check", state: "done", payload: "{}" },
  ]);
  const columns = db.prepare("SELECT name FROM pragma_table_info('users')").pluck().all();
  assert.ok(!columns.includes("lastfm_username"));
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'lastfm%'").get(),
    undefined,
  );
});
