import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";
import { PlaybackDestinationRegistry } from "../../backend/services/playback/playbackDestinationRegistry.js";

const [state, { db }, { dbOps }, retention, { playlistManager }, { downloadTracker }, reuse, { flowPlaylistConfig }] = await setupIsolatedBackend(
  "playback-file-retention",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playback/playbackFileRetention.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowFileReuse.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
);
const { createPlaybackDeletionGuard, removeUnusedPlaybackFiles, isPlaybackRetainedFile, retryPlaybackRetainedFiles } = retention;
const root = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [], onboardingComplete: true });
  await fs.rm(root, { recursive: true, force: true });
});
test.after(async () => { db.close(); await cleanupIsolatedState(state); });

test.afterEach(async () => {
  const { syncPathMappings } = await import("../../backend/services/pathMappings.js");
  syncPathMappings([]);
});

async function makeFile(relative) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  return file;
}

function destination(key, active, read) {
  return {
    key, name: key, updateConfig() {}, isConfigured: () => active,
    async testConnection() {}, async ensureLibrary() {}, async publishPlaylist() {},
    async deletePlaylist() {}, async requestScan() {}, getReferencedPaths: read,
  };
}

test("checks every active destination once per cleanup batch and skips inactive ones", async () => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const unused = await makeFile("_flows/flow/unused.flac");
  const calls = [];
  const registry = new PlaybackDestinationRegistry([
    destination("jellyfin", true, async ({ excludeEntityIds }) => {
      calls.push("jellyfin");
      assert.deepEqual(excludeEntityIds, ["flow"]);
      return { ok: true, paths: [] };
    }),
    destination("navidrome", true, async () => { calls.push("navidrome"); return { ok: true, paths: [saved] }; }),
    destination("plex", false, async () => { throw new Error("inactive service was contacted"); }),
  ]);
  await removeUnusedPlaybackFiles(path.dirname(saved), createPlaybackDeletionGuard({ registry, excludeEntityIds: ["flow"] }));
  assert.equal(await fs.readFile(saved, "utf8"), "audio");
  await assert.rejects(fs.access(unused), { code: "ENOENT" });
  assert.deepEqual(calls.sort(), ["jellyfin", "navidrome"]);
  assert.equal(isPlaybackRetainedFile(saved), true);
});

for (const key of ["jellyfin", "navidrome", "plex"]) {
  test(`${key} alone can veto automatic file deletion`, async () => {
    const file = await makeFile("_flows/flow/track.flac");
    const registry = new PlaybackDestinationRegistry([
      destination(key, true, async () => ({ ok: true, paths: [file] })),
    ]);
    await removeUnusedPlaybackFiles(path.dirname(file), createPlaybackDeletionGuard({ registry }));
    await fs.access(file);
  });
}

for (const response of [null, { ok: true }, { ok: false, error: { message: "offline" } }]) {
  test(`unknown playlist usage preserves files (${JSON.stringify(response)})`, async () => {
    const file = await makeFile("_flows/flow/track.flac");
    const registry = new PlaybackDestinationRegistry([
      destination("jellyfin", true, async () => response),
    ]);
    await removeUnusedPlaybackFiles(path.dirname(file), createPlaybackDeletionGuard({ registry }));
    await fs.access(file);
    assert.equal(isPlaybackRetainedFile(file), true);
  });
}

test("no active playback services preserves the existing cleanup behaviour", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  await removeUnusedPlaybackFiles(path.dirname(file), createPlaybackDeletionGuard({ registry: new PlaybackDestinationRegistry([]) }));
  await assert.rejects(fs.access(path.dirname(file)), { code: "ENOENT" });
});

test("a later cleanup reads fresh references rather than reusing an unused result", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  let paths = [];
  const registry = new PlaybackDestinationRegistry([destination("jellyfin", true, async () => ({ ok: true, paths }))]);
  assert.equal(await createPlaybackDeletionGuard({ registry }).canDelete(file), true);
  paths = [file];
  assert.equal(await createPlaybackDeletionGuard({ registry }).canDelete(file), false);
});

test("configuration changes invalidate deletion permission within a batch", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  const guard = createPlaybackDeletionGuard({ registry: new PlaybackDestinationRegistry([]) });
  assert.equal(await guard.canDelete(file), true);
  dbOps.updateSettings({ integrations: { jellyfin: { url: "http://new-server" } } });
  assert.equal(await guard.canDelete(file), false);
});

test("flow reset retains external files at the same path and clears outgoing jobs", async (t) => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const unused = await makeFile("_flows/flow/unused.flac");
  const legacy = await makeFile("aurral-weekly-flow/flow/legacy.flac");
  const id = downloadTracker.addJob({ artistName: "Artist", trackName: "Saved" }, "flow");
  downloadTracker.setDone(id, saved);
  let calls = 0;
  t.mock.method(playlistManager.destinationRegistry, "run", async (operation, options) => {
    assert.equal(operation, "getReferencedPaths");
    assert.deepEqual(options.excludeEntityIds, ["flow"]);
    calls += 1;
    return [{ destination: "Jellyfin", ok: true, paths: [saved, legacy] }];
  });
  await playlistManager.weeklyReset(["flow"]);
  await fs.access(saved);
  await fs.access(legacy);
  await assert.rejects(fs.access(unused), { code: "ENOENT" });
  assert.equal(downloadTracker.getByPlaylistType("flow").length, 0);
  assert.equal(calls, 1);
});

test("explicit manual reset deletes externally referenced files without contacting services", async (t) => {
  const saved = await makeFile("_flows/flow/saved.flac");
  t.mock.method(playlistManager.destinationRegistry, "run", async () => { assert.fail("manual deletion queried playback"); });
  await playlistManager.weeklyReset(["flow"], { protectPlayback: false });
  await assert.rejects(fs.access(saved), { code: "ENOENT" });
});

test("individual automatic cleanup retains a track while explicit deletion bypasses the check", async (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Flow", size: 5 });
  const file = await makeFile(`_flows/${flow.id}/track.flac`);
  t.mock.method(playlistManager.destinationRegistry, "run", async () => [{ destination: "Plex", ok: true, paths: [file] }]);
  assert.deepEqual(await reuse.removePlaylistFileIfUnshared(file, flow.id), { action: "retained" });
  assert.deepEqual(await reuse.removePlaylistFileIfUnshared(file, flow.id, { protectPlayback: false }), { action: "deleted" });
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("a later scan retries retained files but never removes a file still owned by Aurral", async (t) => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const owned = await makeFile("_flows/flow/owned.flac");
  let paths = [saved, owned];
  t.mock.method(playlistManager.destinationRegistry, "run", async () => [{ destination: "Jellyfin", ok: true, paths }]);
  const guard = createPlaybackDeletionGuard();
  assert.equal(await guard.canDelete(saved), false);
  assert.equal(await guard.canDelete(owned), false);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Owned" }, "another");
  downloadTracker.setDone(jobId, owned);
  paths = [];
  await retryPlaybackRetainedFiles();
  await assert.rejects(fs.access(saved), { code: "ENOENT" });
  await fs.access(owned);
  assert.equal(isPlaybackRetainedFile(saved), false);
});

for (const service of ["jellyfin", "navidrome"]) {
  test(`${service} maps server paths and excludes only the outgoing entity's pointers`, async () => {
    const module = await import(`../../backend/services/playback/${service}PlaybackDestination.js`);
    const storeModule = await import(`../../backend/services/${service}/${service}PlaylistPointerStore.js`);
    const store = storeModule[`${service}PlaylistPointerStore`];
    const Destination = module[service === "jellyfin" ? "JellyfinPlaybackDestination" : "NavidromePlaybackDestination"];
    const { syncPathMappings } = await import("../../backend/services/pathMappings.js");
    syncPathMappings([{ source: service, remote: "/server-music", local: root }]);
    store.setPointer("flow", "owner", { playlistId: "outgoing", serverUrl: "http://server" });
    store.setPointer("other", "owner", { playlistId: "keep", serverUrl: "http://server" });
    const destination = new Destination(root, { client: {
      url: "http://server",
      async getPlaylistTrackPaths(excluded) {
        assert.deepEqual([...excluded], ["outgoing"]);
        return ["/server-music/_flows/flow/saved.flac"];
      },
    } });
    assert.deepEqual(await destination.getReferencedPaths({ excludeEntityIds: ["flow"] }), {
      ok: true, paths: [path.join(root, "_flows/flow/saved.flac")],
    });
  });
}

test("Plex checks global and linked accounts and maps its downloads path", async (t) => {
  const { userOps } = await import("../../backend/db/helpers/index.js");
  const { PlexClient } = await import("../../backend/services/plex.js");
  const { PlexPlaybackDestination } = await import("../../backend/services/playback/plexPlaybackDestination.js");
  const { plexConnectionStore } = await import("../../backend/services/plex/plexConnectionStore.js");
  const { plexPlaylistPointerStore } = await import("../../backend/services/plex/plexPlaylistPointerStore.js");
  const user = userOps.createUser("listener", "hash", "user");
  plexConnectionStore.saveConnection(user.id, { linkType: "self", token: "listener-token", clientId: "listener", plexAccountId: 1 });
  plexPlaylistPointerStore.setPointer("flow", "global", { location: "global", ratingKey: "outgoing" });
  const destination = new PlexPlaybackDestination(root);
  destination.updateConfig({ url: "http://plex", token: "admin-token", downloadsPath: "/server-music" });
  const seen = [];
  t.mock.method(PlexClient.prototype, "getPlaylistTrackPaths", async function (excluded) {
    seen.push(this.token);
    assert.deepEqual([...excluded], ["outgoing"]);
    return this.token === "listener-token" ? ["/server-music/_flows/flow/saved.flac"] : [];
  });
  assert.deepEqual(await destination.getReferencedPaths({ excludeEntityIds: ["flow"] }), {
    ok: true, paths: [path.join(root, "_flows/flow/saved.flac")],
  });
  assert.deepEqual(seen.sort(), ["admin-token", "listener-token"]);
});

test("Plex does not add retained files back to a refreshed flow", async () => {
  const { PlexPlaybackDestination } = await import("../../backend/services/playback/plexPlaybackDestination.js");
  const file = await makeFile("_flows/flow/saved.flac");
  const registry = new PlaybackDestinationRegistry([destination("plex", true, async () => ({ ok: true, paths: [file] }))]);
  await createPlaybackDeletionGuard({ registry }).canDelete(file);
  const playback = new PlexPlaybackDestination(root);
  playback._libraryTracks = [{ ratingKey: "saved", files: [file] }];
  assert.deepEqual(await playback._resolveRatingKeys({ entityId: "flow", tracks: [] }), []);
  assert.deepEqual(await playback._resolveRatingKeys({ entityId: "flow", tracks: [{ path: file }] }), ["saved"]);
});

test("automatic cleanup keeps a shared file in place; explicit deletion preserves other Aurral jobs by moving it", async (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Shared source", size: 5 });
  const other = flowPlaylistConfig.createFlow({ name: "Other", size: 5 });
  const file = await makeFile(`_flows/${flow.id}/saved.flac`);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Saved" }, other.id);
  downloadTracker.setDone(jobId, file);
  t.mock.method(playlistManager.destinationRegistry, "run", async () => [{ destination: "Jellyfin", ok: true, paths: [file] }]);
  await playlistManager.weeklyReset([flow.id]);
  assert.equal(downloadTracker.getAll().find((job) => job.id === jobId).finalPath, file);
  await fs.access(file);
  await playlistManager.weeklyReset([flow.id], { protectPlayback: false });
  const moved = downloadTracker.getAll().find((job) => job.id === jobId).finalPath;
  assert.notEqual(moved, file);
  await fs.access(moved);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("quality upgrades preserve the old file when another playback playlist uses it", async (t) => {
  const { finalizeQualityUpgradeSuccess } = await import("../../backend/services/qualityProfileService.js");
  const oldFile = await makeFile("_flows/upgrade/old.mp3");
  const newFile = await makeFile("_flows/upgrade/new.flac");
  const originalId = downloadTracker.addJob({ artistName: "Artist", trackName: "Upgrade" }, "upgrade");
  downloadTracker.setDone(originalId, oldFile);
  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", () => {});
  t.mock.method(playlistManager.destinationRegistry, "run", async () => [{ destination: "Navidrome", ok: true, paths: [oldFile] }]);
  await finalizeQualityUpgradeSuccess({ id: "upgrade-job", upgradeForJobId: originalId }, newFile, { tier: "lossless" });
  assert.equal(downloadTracker.getJob(originalId).finalPath, newFile);
  await fs.access(oldFile);
  assert.equal(isPlaybackRetainedFile(oldFile), true);
});

test("startup migration leaves an externally referenced orphan at its original path", async (t) => {
  const { migrateAurralDownloadFolder } = await import("../../backend/services/aurralDownloadFolderMigration.js");
  const flow = flowPlaylistConfig.createFlow({ name: "Migration source", enabled: true });
  const file = await makeFile(`aurral-weekly-flow/${flow.id}/Artist/Album/Saved.flac`);
  t.mock.method(playlistManager.destinationRegistry, "run", async () => [{ destination: "Jellyfin", ok: true, paths: [file] }]);
  const options = { root, indexDestination: async () => {}, logger: { info() {}, warn() {}, error() {} } };
  const result = await migrateAurralDownloadFolder(options);
  assert.equal(result.removed, 0);
  assert.equal(isPlaybackRetainedFile(file), true);
  await fs.access(file);
  await migrateAurralDownloadFolder(options);
  await fs.access(file);
});
