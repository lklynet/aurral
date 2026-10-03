import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps, userOps }, config, { downloadTracker }, { playlistManager }, operations, store, honker, routes] = await setupIsolatedBackend(
  "bulk-playlist-actions", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js", "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js", "backend/services/playlists/playlistOperations.js",
  "backend/services/playlists/bulkOperationStore.js", "backend/services/honkerDb.js",
  "backend/routes/playlists/handlers/staticPlaylists.js",
);
test.beforeEach(() => {
  resetDatabase(db);
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  honker.getPlaylistOperationQueue();
  db.prepare("DELETE FROM _honker_live").run();
});
test.after(() => cleanupIsolatedState(state));

function fixture(t, count = 3) {
  const user = userOps.createUser("bulk-user", "unused");
  const tracks = Array.from({ length: count }, (_, index) => ({ artistName: "Artist", trackName: `Track ${index}`, albumName: "Album" }));
  const source = config.flowPlaylistConfig.createStaticPlaylist({ name: "Source", ownerUserId: user.id, tracks });
  const jobs = tracks.map((track) => downloadTracker.getJob(downloadTracker.addJob(track, source.id)));
  const selections = jobs.map((job, index) => ({ jobId: job.id, membershipId: source.tracks[index].membershipId,
    jobPlaylistId: source.id, jobGeneration: job.playlistGeneration, jobCreatedAt: job.createdAt }));
  const refreshes = [];
  let scans = 0;
  t.mock.method(playlistManager, "refreshPlaylist", async (id) => { refreshes.push(id); });
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => { scans++; });
  return { user, source, jobs, selections, refreshes, scans: () => scans };
}

async function execute(record) {
  const { operationId } = store.enqueueBulkOperation(record);
  await operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId });
  return store.getBulkOperation(operationId);
}

test("a batch removes all selected memberships with one refresh and one scan", async (t) => {
  const f = fixture(t, 100);
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  assert.equal(result.outcomes.length, 100);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "removed"));
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 0);
  assert.equal(downloadTracker.getByPlaylistId(f.source.id).length, 0);
  assert.deepEqual(f.refreshes, [f.source.id]);
  assert.equal(f.scans(), 1);
});

test("a move preserves active backing jobs and never duplicates its destination on retry", async (t) => {
  const f = fixture(t);
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move", selections: f.selections,
    target: { playlistId: "preallocated-target", name: "Destination", create: true } });
  assert.ok(result.outcomes.every((outcome) => outcome.status === "moved"));
  const target = config.flowPlaylistConfig.getStaticPlaylist("preallocated-target");
  assert.equal(target.tracks.length, 3);
  assert.ok(f.jobs.every((job) => downloadTracker.getJob(job.id)?.playlistType === target.id));
  await operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId: result.operationId });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylists().length, 2);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(target.id).tracks.length, 3);
  assert.deepEqual(new Set(f.refreshes), new Set([f.source.id, target.id]));
  assert.equal(f.scans(), 1);
});

test("a removed and readded membership cannot be removed by a stale batch selection", async (t) => {
  const f = fixture(t, 1);
  config.flowPlaylistConfig.updateStaticPlaylist(f.source.id, { tracks: [] });
  config.flowPlaylistConfig.appendStaticPlaylistTracks(f.source.id, [{ ...f.source.tracks[0], canonicalJobId: f.jobs[0].id }]);
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  assert.equal(result.outcomes[0].status, "failed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
  assert.ok(downloadTracker.getJob(f.jobs[0].id));
  assert.equal(f.scans(), 0);
});

test("failed destination persistence keeps source membership and owner", async (t) => {
  const f = fixture(t, 1);
  const target = config.flowPlaylistConfig.createStaticPlaylist({ name: "Destination", ownerUserId: f.user.id });
  const { operationId } = store.enqueueBulkOperation({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move", selections: f.selections, target: { playlistId: target.id } });
  db.exec("CREATE TRIGGER reject_membership BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END");
  try {
    await assert.rejects(operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId }), /fixture persistence failure/);
    assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
    assert.equal(config.flowPlaylistConfig.getStaticPlaylist(target.id).tracks.length, 0);
    assert.equal(downloadTracker.getJob(f.jobs[0].id).playlistType, f.source.id);
  } finally { db.exec("DROP TRIGGER reject_membership"); }
});

const handlers = new Map();
routes.registerStaticPlaylists(Object.fromEntries(["get", "post", "put", "delete"].map((method) => [method, (path, ...callbacks) => handlers.set(`${method}:${path}`, callbacks.at(-1))])));
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("batch acceptance validates, deduplicates and scopes its durable result to its requester", async (t) => {
  const f = fixture(t, 1);
  const endpoint = handlers.get("post:/shared-playlists/:playlistId/track-removals");
  const malformed = response();
  await endpoint({ params: { playlistId: f.source.id }, user: f.user, body: { jobIds: [] } }, malformed);
  assert.equal(malformed.statusCode, 400);
  const accepted = response();
  await endpoint({ params: { playlistId: f.source.id }, user: f.user,
    body: { jobIds: [f.jobs[0].id, f.jobs[0].id, "missing"] } }, accepted);
  assert.equal(accepted.body.queued, true);
  assert.deepEqual(accepted.body.acceptedJobIds, [f.jobs[0].id]);
  assert.equal(accepted.body.rejected[0].jobId, "missing");
  assert.equal(honker.getHonkerQueueDepth("weekly-flow-operation"), 1);
  const read = handlers.get("get:/shared-playlists/:playlistId/operations/:operationId");
  const params = { playlistId: f.source.id, operationId: String(accepted.body.operationId) };
  const own = response();
  read({ params, user: f.user }, own);
  assert.equal(own.body.state, "queued");
  const other = response();
  read({ params, user: { ...f.user, id: f.user.id + 1, role: "admin" } }, other);
  assert.equal(other.statusCode, 404);
});

test("synchronization failure preserves applied outcomes and retries only unfinished synchronization", async (t) => {
  const f = fixture(t, 2);
  let attempts = 0;
  t.mock.method(playlistManager, "refreshPlaylist", async () => {
    if (++attempts === 1) throw new Error("fixture service unavailable");
  });
  const { operationId } = store.enqueueBulkOperation({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  await assert.rejects(operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId }), /fixture service unavailable/);
  assert.equal(store.getBulkOperation(operationId).outcomes.length, 2);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 0);
  await operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId });
  assert.equal(store.getBulkOperation(operationId).state, "completed");
  assert.equal(store.getBulkOperation(operationId).outcomes.length, 2);
  assert.equal(f.scans(), 1);
});

test("failed source commit leaves completed source media intact", async (t) => {
  const f = fixture(t, 1);
  const file = path.join(process.env.DOWNLOAD_FOLDER, "aurral-weekly-flow", f.source.id, "Track.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "disposable audio");
  downloadTracker.setDone(f.jobs[0].id, file);
  const { operationId } = store.enqueueBulkOperation({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  db.exec("CREATE TRIGGER reject_source_commit BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END");
  try {
    await assert.rejects(operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId }), /fixture source failure/);
    assert.equal(await fs.readFile(file, "utf8"), "disposable audio");
    assert.equal(downloadTracker.getJob(f.jobs[0].id).finalPath, file);
    assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
    assert.equal(store.getBulkOperation(operationId).outcomes.length, 0);
  } finally { db.exec("DROP TRIGGER reject_source_commit"); }
});

test("a restarted process resumes a destination already saved before source detachment", async (t) => {
  const f = fixture(t, 2);
  const target = config.flowPlaylistConfig.createStaticPlaylist({ id: "restart-target", name: "Restart destination", ownerUserId: f.user.id,
    tracks: f.jobs.map((job) => ({ ...job, canonicalJobId: job.id })) });
  const { operationId } = store.enqueueBulkOperation({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move", selections: f.selections,
    target: { playlistId: target.id, name: target.name, create: true } });
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { processPlaylistOperation } = await import('./backend/services/playlists/playlistOperations.js');
    const { shutdownHonkerInfrastructure } = await import('./backend/services/honkerWorkerRuntime.js');
    await processPlaylistOperation({ kind: 'shared-playlist-bulk', operationId: ${operationId} });
    await shutdownHonkerInfrastructure({ timeoutMs: 5000 });
  `], { env: process.env, timeout: 15000 });
  dbOps.invalidateSettingsCache();
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.reconcileCommittedJobs();
  assert.equal(store.getBulkOperation(operationId).state, "completed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylists().length, 2);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(target.id).tracks.length, 2);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 0);
  assert.ok(f.jobs.every((job) => downloadTracker.getJob(job.id).playlistType === target.id));
});

test("partial provider failure preserves the failed membership and completes the other removals", async (t) => {
  const f = fixture(t, 2);
  const { getDownloadClient } = await import("../../backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("deemix");
  t.mock.method(client, "isConfigured", () => true);
  t.mock.method(client, "removeFromQueue", async () => false);
  honker.getPipelineQueue().enqueue({ jobId: f.jobs[0].id, playlistId: f.source.id, playlistGeneration: 0, phase: "poll", source: "deemix", queueUuid: "refused-provider-work" });
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["failed", "removed"]);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
  assert.equal(downloadTracker.getJob(f.jobs[0].id).status, "failed");
  assert.ok(!downloadTracker.getJob(f.jobs[1].id));
  assert.equal(f.scans(), 1);
});

test("bulk leader removal hands its album download to an unselected held peer", async (t) => {
  const f = fixture(t, 2);
  db.prepare("UPDATE playlist_download_jobs SET request_group_id = ?, album_mbid = ? WHERE playlist_id = ?").run("disposable-album-group", "disposable-album", f.source.id);
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(f.jobs[1].id);
  downloadTracker.markSlskdDispatched(f.jobs[0].id);
  honker.getPipelineQueue().enqueue({ jobId: f.jobs[0].id, playlistId: f.source.id, playlistGeneration: 0, phase: "poll", source: "deemix",
    queueUuid: "album-work-needed-by-peer", albumGrab: true, albumGroupJobIds: f.jobs.map((job) => job.id) });
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: [f.selections[0]] });
  assert.equal(result.outcomes[0].status, "removed");
  assert.ok(!downloadTracker.getJob(f.jobs[0].id));
  assert.equal(downloadTracker.getJob(f.jobs[1].id).status, "downloading");
  const payload = honker.listHonkerJobs("slskd-pipeline")[0].payload;
  assert.equal(payload.jobId, f.jobs[1].id);
  assert.equal(payload.queueUuid, "album-work-needed-by-peer");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
});

test("a failed source commit after provider cleanup leaves a recoverable active job", async (t) => {
  const f = fixture(t, 1);
  const { isDownloadJobCancelled } = await import("../../backend/services/downloadJobs/downloadCancellation.js");
  const { operationId } = store.enqueueBulkOperation({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  db.exec("CREATE TRIGGER reject_pending_commit BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture pending failure'); END");
  try {
    await assert.rejects(operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId }), /fixture pending failure/);
    assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
    assert.equal(downloadTracker.getJob(f.jobs[0].id).status, "failed");
    assert.equal(isDownloadJobCancelled(f.jobs[0].id), false);
    assert.equal(store.getBulkOperation(operationId).outcomes.length, 0);
  } finally { db.exec("DROP TRIGGER reject_pending_commit"); }
  await operations.processPlaylistOperation({ kind: "shared-playlist-bulk", operationId });
  assert.equal(store.getBulkOperation(operationId).state, "completed");
  assert.ok(!downloadTracker.getJob(f.jobs[0].id));
});

test("failed provider cleanup leaves a retained quality upgrade recoverable", async (t) => {
  const f = fixture(t, 1);
  const file = path.join(process.env.DOWNLOAD_FOLDER, "original.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "original audio");
  downloadTracker.setDone(f.jobs[0].id, file);
  const upgradeId = downloadTracker.addReplacementSearchJob(downloadTracker.getJob(f.jobs[0].id));
  downloadTracker.setDownloading(upgradeId);
  const { getDownloadClient } = await import("../../backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("deemix");
  t.mock.method(client, "isConfigured", () => true);
  t.mock.method(client, "removeFromQueue", async () => false);
  honker.getPipelineQueue().enqueue({ jobId: upgradeId, playlistId: f.source.id, playlistGeneration: 0,
    phase: "poll", source: "deemix", queueUuid: "refused-upgrade-work" });
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  assert.equal(result.outcomes[0].status, "failed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
  assert.equal(downloadTracker.getJob(f.jobs[0].id).status, "done");
  assert.equal(await fs.readFile(file, "utf8"), "original audio");
  assert.equal(downloadTracker.getJob(upgradeId).status, "failed");
  t.mock.method(client, "removeFromQueue", async () => true);
  const retry = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "remove", selections: f.selections });
  assert.equal(retry.outcomes[0].status, "removed");
  assert.ok(!downloadTracker.getJob(upgradeId));
});

test("duplicate supplied membership IDs cannot detach an unselected track", async (t) => {
  const f = fixture(t, 2);
  config.flowPlaylistConfig.deleteStaticPlaylist(f.source.id);
  const source = config.flowPlaylistConfig.createStaticPlaylist({ id: f.source.id, name: "Source", ownerUserId: f.user.id,
    tracks: f.source.tracks.map((track) => ({ ...track, membershipId: "duplicated-membership" })) });
  const selection = { ...f.selections[0], membershipId: source.tracks[0].membershipId };
  await execute({ ownerUserId: f.user.id, sourcePlaylistId: source.id, action: "remove", selections: [selection] });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 1);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks[0].trackName, f.jobs[1].trackName);
  assert.ok(downloadTracker.getJob(f.jobs[1].id));
});

test("a bulk move finalizes retained media under the configured playlist root", async (t) => {
  const f = fixture(t, 1);
  const { downloadWorker } = await import("../../backend/services/downloadJobs/downloadWorker.js");
  const previousRoot = downloadWorker.downloadRoot;
  const root = path.join(state.baseDir, "custom-playlists");
  downloadWorker.downloadRoot = root;
  t.after(() => { downloadWorker.downloadRoot = previousRoot; });
  const file = path.join(root, "_flows", f.source.id, "Original.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "retained custom-root audio");
  downloadTracker.setDone(f.jobs[0].id, file);
  const target = config.flowPlaylistConfig.createStaticPlaylist({ name: "Custom target", ownerUserId: f.user.id });
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move", target: { playlistId: target.id }, selections: f.selections });
  assert.equal(result.state, "completed");
  assert.equal(await fs.readFile(downloadTracker.getJob(f.jobs[0].id).finalPath, "utf8"), "retained custom-root audio");
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  assert.equal(db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'playlistMediaRelocation:%'").get().count, 0);
});

test("a conflicting destination membership keeps the source job while other tracks move", async (t) => {
  const f = fixture(t, 2);
  const target = config.flowPlaylistConfig.createStaticPlaylist({ name: "Existing target", ownerUserId: f.user.id, tracks: [f.source.tracks[0]] });
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move", target: { playlistId: target.id }, selections: f.selections });
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["failed", "moved"]);
  const source = config.flowPlaylistConfig.getStaticPlaylist(f.source.id);
  assert.equal(source.tracks.length, 1);
  assert.equal(downloadTracker.getJob(f.jobs[0].id).playlistType, source.id);
  assert.equal(downloadTracker.getJob(f.jobs[1].id).playlistType, target.id);
  const destination = config.flowPlaylistConfig.getStaticPlaylist(target.id);
  assert.equal(destination.tracks.length, 2);
  assert.equal(destination.tracks[0].canonicalJobId, undefined);
  assert.equal(destination.tracks[1].canonicalJobId, f.jobs[1].id);
});

test("a new-target move with only stale selections creates no empty playlist", async (t) => {
  const f = fixture(t, 1);
  config.flowPlaylistConfig.updateStaticPlaylist(f.source.id, { tracks: [] });
  config.flowPlaylistConfig.appendStaticPlaylistTracks(f.source.id, f.source.tracks);
  const targetId = "unused-stale-target";
  const result = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move",
    target: { playlistId: targetId, name: "Should not exist", create: true }, selections: f.selections });
  assert.equal(result.outcomes[0].status, "failed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(targetId), null);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
  assert.ok(downloadTracker.getJob(f.jobs[0].id));
  const currentSelection = { ...f.selections[0], membershipId: config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks[0].membershipId };
  downloadTracker.removeJob(f.jobs[0].id);
  const missing = await execute({ ownerUserId: f.user.id, sourcePlaylistId: f.source.id, action: "move",
    target: { playlistId: targetId, name: "Should not exist", create: true }, selections: [currentSelection] });
  assert.equal(missing.outcomes[0].status, "alreadyAbsent");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(targetId), null);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(f.source.id).tracks.length, 1);
});
