import assert from "node:assert/strict";
import test from "node:test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { processSystemTask },
  { resolveUser },
  { invalidateFlowPlaylistConfigCache },
] = await setupIsolatedBackend(
  "stored-data-migration",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/systemTaskWorker.js",
  "backend/middleware/auth.js",
  "backend/services/playlists/flowPlaylistConfig.js",
);

const writeRaw = (key, value) =>
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, typeof value === "string" ? value : JSON.stringify(value));
const readRaw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const readJson = (key) => {
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

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("stores older settings, flows, worker options, and sign-in in their current form", async () => {
  reset();
  writeRaw("weeklyFlows", [{
    id: "discover",
    name: "Old Discover",
    size: 20,
    tags: { ambient: 3, drone: 1 },
    relatedArtists: { Burial: 2 },
  }]);
  writeRaw("sharedFlowPlaylists", [{
    id: "old-playlist",
    name: "Old Playlist",
    tracks: [{ artistName: "Burial", trackName: "Archangel" }],
  }]);
  writeRaw("weeklyFlowWorker", { concurrency: 2, existingFileMode: "hardlink" });
  writeRaw("integrations", {
    metadata: { provider: "brainzmash", baseUrl: "https://brainzmash.kell.ly/" },
    coverArtArchive: { enabled: true },
    musicbrainz: { customUrl: "https://musicbrainz.example/ws/2", email: "owner@example.com" },
    navidrome: { url: "http://navidrome.invalid", m3uPathMode: "absolute", pathMappings: [] },
    lastfm: { discoverFlowArtworkStyle: "aurral", username: "listener" },
    general: { authUser: "owner", authPassword: "correct horse battery" },
  });
  writeRaw("onboardingComplete", "true");

  await runMigration();

  for (const oldKey of ["weeklyFlows", "sharedFlowPlaylists", "weeklyFlowWorker"]) {
    assert.equal(readRaw(oldKey), undefined, `${oldKey} should be removed`);
  }

  const [flow] = readJson("flows");
  assert.equal(flow.name, "Old Discover");
  assert.notEqual(flow.id, "discover");
  assert.deepEqual(flow.tags, ["ambient", "drone"]);
  assert.deepEqual(flow.relatedArtists, ["Burial"]);
  invalidateFlowPlaylistConfigCache();
  assert.equal(readJson("flows")[0].id, flow.id, "the stored flow keeps one ID across reads");

  assert.equal(readJson("sharedPlaylists")[0].name, "Old Playlist");
  assert.deepEqual(
    { concurrency: readJson("playlistWorker").concurrency, mode: readJson("playlistWorker").existingFileMode },
    { concurrency: 2, mode: "reuse" },
  );

  const integrations = readJson("integrations");
  assert.equal("coverArtArchive" in integrations, false);
  assert.deepEqual(integrations.musicbrainz, { email: "owner@example.com" });
  assert.equal("m3uPathMode" in integrations.navidrome, false);
  assert.equal("pathMappings" in integrations.navidrome, false);
  assert.equal(integrations.navidrome.url, "http://navidrome.invalid");
  assert.deepEqual(integrations.lastfm, { username: "listener" });
  assert.equal(integrations.metadata.baseUrl, "https://lidarrapi.brainzmash.cc");
  assert.equal(dbOps.getSettings().playlistArtwork.style, "aurral");

  const admin = resolveUser("owner", "correct horse battery");
  assert.equal(admin?.role, "admin");
  assert.equal(userOps.countUsers(), 1);
  assert.equal(readJson("storedDataMigration").version, 1);
});

test("keeps current settings when an older key repeats them", async () => {
  reset();
  writeRaw("flows", [{ id: "current-flow", name: "Current", size: 30, tags: ["dub"] }]);
  writeRaw("weeklyFlows", [{ id: "discover", name: "Stale" }]);
  writeRaw("playlistWorker", { concurrency: 1, existingFileMode: "download" });
  writeRaw("weeklyFlowWorker", { concurrency: 3, existingFileMode: "copy" });
  const integrations = JSON.stringify({ metadata: { baseUrl: "https://metadata.example" } });
  writeRaw("integrations", integrations);
  userOps.createUser("someone", "hash", "admin", null);
  writeRaw("onboardingComplete", "true");

  await runMigration();

  assert.deepEqual(readJson("flows").map((flow) => [flow.id, flow.name, flow.tags]), [
    ["current-flow", "Current", ["dub"]],
  ]);
  assert.equal(readRaw("weeklyFlows"), undefined);
  assert.equal(readJson("playlistWorker").existingFileMode, "download");
  assert.equal(readJson("playlistWorker").concurrency, 1);
  assert.equal(readRaw("weeklyFlowWorker"), undefined);
  assert.equal(readRaw("integrations"), integrations);
  assert.equal(userOps.countUsers(), 1);
});
