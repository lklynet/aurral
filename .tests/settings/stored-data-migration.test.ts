import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { processSystemTask },
  { resolveUser },
  { invalidateFlowPlaylistConfigCache, flowPlaylistConfig },
  { STORED_DATA_MIGRATION_VERSION },
] = await setupIsolatedBackend(
  "stored-data-migration",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/middleware/auth.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/jobs/startup.ts"),
);

const writeRaw = (key: string, value: unknown) =>
  db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, typeof value === "string" ? value : JSON.stringify(value));
const readRaw = (key: string) =>
  db
    .prepare<unknown[], { value: import("../../backend/db/rows.ts").SettingsRow["value"] }>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key)?.value;
const readJson = (key: string) => {
  const value = readRaw(key);
  return value == null ? undefined : JSON.parse(value);
};

const reset = () => {
  db.prepare("DELETE FROM users").run();
  db.prepare("DELETE FROM settings").run();
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
};

const runMigration = async () => {
  await processSystemTask({ kind: "stored-data-migration" });
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
};

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("stores older settings, flows, worker options, and sign-in in their current form", async () => {
  reset();
  writeRaw("weeklyFlows", [
    {
      id: "old-flow",
      name: "Old Discover",
      size: 20,
      tags: ["ambient", "drone"],
    },
  ]);
  writeRaw("sharedFlowPlaylists", [
    {
      id: "old-playlist",
      name: "Old Playlist",
      tracks: [{ artistName: "Burial", trackName: "Archangel" }],
    },
  ]);
  writeRaw("weeklyFlowWorker", { concurrency: 2 });
  writeRaw("integrations", {
    metadata: { provider: "brainzmash", baseUrl: "https://brainzmash.kell.ly/" },
    coverArtArchive: { enabled: true },
    musicbrainz: { customUrl: "https://musicbrainz.example/ws/2", email: "owner@example.com" },
    lastfm: { discoverFlowArtworkStyle: "aurral", username: "listener" },
    general: { authUser: "owner", authPassword: "correct horse battery" },
  });
  writeRaw("onboardingComplete", "true");

  await runMigration();

  for (const oldKey of ["weeklyFlows", "sharedFlowPlaylists", "weeklyFlowWorker"]) {
    assert.equal(readRaw(oldKey), undefined, `${oldKey} should be removed`);
  }

  const [flow] = readJson("flows");
  assert.deepEqual(
    [flow.id, flow.name, flow.tags],
    ["old-flow", "Old Discover", ["ambient", "drone"]],
  );

  assert.equal(readJson("staticPlaylists")[0].name, "Old Playlist");
  assert.equal(readJson("playlistWorker").concurrency, 2);

  const integrations = readJson("integrations");
  assert.equal("coverArtArchive" in integrations, false);
  assert.deepEqual(integrations.musicbrainz, { email: "owner@example.com" });
  assert.deepEqual(integrations.lastfm, { username: "listener" });
  assert.equal(integrations.metadata.baseUrl, "");

  const admin = resolveUser("owner", "correct horse battery");
  assert.equal(admin?.role, "admin");
  assert.equal(userOps.countUsers(), 1);
  assert.equal(readJson("storedDataMigration").version, STORED_DATA_MIGRATION_VERSION);
});

test("stores static playlists in their current form once, so reading them never writes", async () => {
  reset();
  writeRaw("staticPlaylists", [
    {
      id: "old-playlist",
      name: " Night Bus ",
      tracks: [
        { artist: "Burial", title: "Archangel" },
        { artistName: "Burial", trackName: "Archangel" },
      ],
    },
  ]);
  const raw = readRaw("staticPlaylists");

  flowPlaylistConfig.getStaticPlaylists();
  assert.equal(readRaw("staticPlaylists"), raw);

  await runMigration();

  const [stored] = readJson("staticPlaylists");
  assert.equal(stored.name, "Night Bus");
  assert.equal(stored.tracks.length, 1);
  assert.equal(typeof stored.tracks[0].membershipId, "string");
  assert.equal(typeof stored.createdAt, "number");
  assert.deepEqual(flowPlaylistConfig.getStaticPlaylists(), [stored]);
});

test("keeps current settings when an older key repeats them", async () => {
  reset();
  writeRaw("flows", [{ id: "current-flow", name: "Current", size: 30, tags: ["dub"] }]);
  writeRaw("weeklyFlows", [{ id: "discover", name: "Stale" }]);
  writeRaw("playlistWorker", { concurrency: 1 });
  writeRaw("weeklyFlowWorker", { concurrency: 3 });
  const integrations = JSON.stringify({ metadata: { baseUrl: "https://metadata.example" } });
  writeRaw("integrations", integrations);
  userOps.createUser("someone", "hash", "admin", null);
  writeRaw("onboardingComplete", "true");

  await runMigration();

  assert.deepEqual(
    readJson("flows").map((flow: { id: string; name: string; tags: string[] }) => [
      flow.id,
      flow.name,
      flow.tags,
    ]),
    [["current-flow", "Current", ["dub"]]],
  );
  assert.equal(readRaw("weeklyFlows"), undefined);
  assert.equal(readJson("playlistWorker").concurrency, 1);
  assert.equal(readRaw("weeklyFlowWorker"), undefined);
  assert.equal(readRaw("integrations"), integrations);
  assert.equal(userOps.countUsers(), 1);
});
