import { requireFixture } from "./fixtures.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps, userOps },
  config,
  { downloadTracker },
  { playlistManager },
  operations,
  store,
  { playlistOperationQueue, downloadPipelineQueue },
  { api },
] = await setupIsolatedBackend(
  "bulk-playlist-actions",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/playlists/bulkOperationStore.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/routes/api.ts"),
);
beforeEach(() => {
  vi.spyOn(downloadPipelineQueue, "start").mockImplementation(async () => undefined);
  resetDatabase(db);
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({
    integrations: {},
    flows: [],
    staticPlaylists: [],
  });
});
afterAll(() => cleanupIsolatedState(state));

function fixture(_t: import("vite-plus/test").TestContext, count: number = 3) {
  const user = userOps.createUser("bulk-user", "unused", "user", { accessPlaylists: true });
  assert.ok(user != null);
  const tracks = Array.from({ length: count }, (_, index) => ({
    artistName: "Artist",
    trackName: `Track ${index}`,
    albumName: "Album",
  }));
  const jobs = tracks.map((track) =>
    requireFixture(
      downloadTracker.getJob(
        downloadTracker.addJob(track, "library", { startedByPlaylist: "source" }),
      ),
    ),
  );
  const source = config.flowPlaylistConfig.createStaticPlaylist({
    id: "source",
    name: "Source",
    ownerUserId: user.id,
    tracks: tracks.map((track, index) => ({ ...track, canonicalJobId: jobs[index]!.id })),
  });
  const selections = jobs.map((job, index) => ({
    jobId: job.id,
    membershipId: requireFixture(source.tracks[index]).membershipId,
  }));
  const refreshes: unknown[] = [];
  let scans = 0;
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation((ids) => {
    refreshes.push(...requireFixture(ids));
  });
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => {
    return ++scans;
  });
  return { user, source, jobs, selections, refreshes, scans: () => scans };
}

async function execute(
  record: Omit<Parameters<typeof store.enqueueBulkOperation>[0], "target"> & {
    target?: Parameters<typeof store.enqueueBulkOperation>[0]["target"];
  },
) {
  const { operationId } = store.enqueueBulkOperation({ ...record, target: record.target ?? null });
  await operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId });
  return store.getBulkOperation(operationId);
}

test("a batch removes all selected memberships and their downloads with one refresh", async (t) => {
  const f = fixture(t, 100);
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  assert.ok(result != null);
  assert.equal(result.outcomes.length, 100);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "removed"));
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    0,
  );
  assert.ok(f.jobs.every((job) => !downloadTracker.getJob(job.id)));
  assert.deepEqual(f.refreshes, [f.source.id]);
});

test("a move preserves active backing jobs and never duplicates its destination on retry", async (t) => {
  const f = fixture(t);
  downloadTracker.setSaved(requireFixture(f.jobs[1]).id);
  downloadTracker.setFailed(requireFixture(f.jobs[2]).id, "No match");
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    selections: f.selections,
    target: { playlistId: "preallocated-target", name: "Destination", create: true },
  });
  assert.ok(result != null);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "moved"));
  const target = config.flowPlaylistConfig.getStaticPlaylist("preallocated-target");
  assert.ok(target != null);
  assert.equal(target.tracks.length, 3);
  assert.deepEqual(
    target.tracks.map((track) => track.canonicalJobId),
    f.jobs.map((job) => job.id),
  );
  assert.deepEqual(
    f.jobs.map((job) => downloadTracker.getJob(job.id)?.status),
    ["pending", "saved", "failed"],
  );
  assert.ok(await playlistManager.resolveArtworkFile(target.id));
  await operations.processPlaylistOperation({
    kind: "static-playlist-bulk",
    operationId: result.operationId,
  });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylists().length, 2);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(target.id)).tracks.length,
    3,
  );
  assert.deepEqual(new Set(f.refreshes), new Set([f.source.id, target.id]));
});

test("a removed and readded membership cannot be removed by a stale batch selection", async (t) => {
  const f = fixture(t, 1);
  config.flowPlaylistConfig.updateStaticPlaylist(f.source.id, { tracks: [] });
  config.flowPlaylistConfig.appendStaticPlaylistTracks(f.source.id, [
    { ...f.source.tracks[0], canonicalJobId: requireFixture(f.jobs[0]).id },
  ]);
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  assert.ok(result != null);
  assert.equal(result.outcomes[0]?.status, "failed");
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    1,
  );
  assert.ok(downloadTracker.getJob(requireFixture(f.jobs[0]).id));
  assert.equal(f.scans(), 0);
});

test("failed destination persistence keeps source membership and owner", async (t) => {
  const f = fixture(t, 1);
  const target = config.flowPlaylistConfig.createStaticPlaylist({
    name: "Destination",
    ownerUserId: f.user.id,
  });
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    selections: f.selections,
    target: { playlistId: target.id },
  });
  db.exec(
    "CREATE TRIGGER reject_membership BEFORE INSERT ON settings WHEN NEW.key = 'staticPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END",
  );
  try {
    await assert.rejects(
      operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId }),
      /fixture persistence failure/,
    );
    assert.equal(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
      1,
    );
    assert.equal(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(target.id)).tracks.length,
      0,
    );
    assert.ok(downloadTracker.getJob(requireFixture(f.jobs[0]).id));
  } finally {
    db.exec("DROP TRIGGER reject_membership");
  }
});

const send = (user: RequestUser, method: string, path: string, body?: object) =>
  signedInAs(user)
    .route("/", api)
    .request(
      `/playlists${path}`,
      body
        ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method },
    );

test("batch acceptance validates, deduplicates and scopes its durable result to its requester", async (t) => {
  const f = fixture(t, 1);
  const { stopPlaylistOperationWorker } =
    await import("../../backend/services/playlists/playlistOperationWorker.ts");
  await stopPlaylistOperationWorker();
  vi.spyOn(playlistOperationQueue, "start").mockImplementation(async () => undefined);
  const removals = `/static-playlists/${f.source.id}/track-removals`;
  const malformed = await send(f.user, "POST", removals, { jobIds: [] });
  assert.equal(malformed.status, 400);
  const accepted = await (
    await send(f.user, "POST", removals, {
      jobIds: [requireFixture(f.jobs[0]).id, requireFixture(f.jobs[0]).id, "missing"],
    })
  ).json();
  assert.equal(accepted.queued, true);
  assert.deepEqual(accepted.acceptedJobIds, [requireFixture(f.jobs[0]).id]);
  assert.equal(accepted.rejected[0].jobId, "missing");
  assert.equal(playlistOperationQueue.readyCount(), 1);
  const operation = `/static-playlists/${f.source.id}/operations/${accepted.operationId}`;
  const own = await (await send(f.user, "GET", operation)).json();
  assert.equal(own.state, "queued");
  const other = await send({ ...f.user, id: f.user.id + 1, role: "admin" }, "GET", operation);
  assert.equal(other.status, 404);
});

test("synchronization failure preserves applied outcomes and retries only unfinished synchronization", async (t) => {
  const f = fixture(t, 2);
  let attempts = 0;
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => {
    if (++attempts === 1) throw new Error("fixture queue unavailable");
  });
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  await assert.rejects(
    operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId }),
    /fixture queue unavailable/,
  );
  assert.equal(requireFixture(store.getBulkOperation(operationId)).outcomes.length, 2);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    0,
  );
  await operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId });
  assert.equal(requireFixture(store.getBulkOperation(operationId)).state, "completed");
  assert.equal(requireFixture(store.getBulkOperation(operationId)).outcomes.length, 2);
});

test("failed source commit leaves completed source media intact", async (t) => {
  const f = fixture(t, 1);
  const file = path.join(
    requireFixture(process.env.WEEKLY_FLOW_FOLDER),
    "aurral-weekly-flow",
    f.source.id,
    "Track.flac",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "disposable audio");
  downloadTracker.setDone(requireFixture(f.jobs[0]).id, file);
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  db.exec(
    "CREATE TRIGGER reject_source_commit BEFORE INSERT ON settings WHEN NEW.key = 'staticPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END",
  );
  try {
    await assert.rejects(
      operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId }),
      /fixture source failure/,
    );
    assert.equal(await fs.readFile(file, "utf8"), "disposable audio");
    assert.equal(
      requireFixture(downloadTracker.getJob(requireFixture(f.jobs[0]).id)).finalPath,
      file,
    );
    assert.equal(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
      1,
    );
    assert.equal(requireFixture(store.getBulkOperation(operationId)).outcomes.length, 0);
  } finally {
    db.exec("DROP TRIGGER reject_source_commit");
  }
});

test("a restarted process resumes a destination already saved before source detachment", async (t) => {
  const f = fixture(t, 2);
  const target = config.flowPlaylistConfig.createStaticPlaylist({
    id: "restart-target",
    name: "Restart destination",
    ownerUserId: f.user.id,
    tracks: f.jobs.map((job) => ({ ...job, canonicalJobId: job.id })),
  });
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    selections: f.selections,
    target: { playlistId: target.id, name: target.name, create: true },
  });
  const saved = requireFixture(store.getBulkOperation(operationId));
  store.saveBulkOperation({ ...saved, synchronization: { [target.id]: false } });
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { processPlaylistOperation } = await import('./backend/services/playlists/playlistOperations.ts');
    const { shutdownJobWorkers } = await import('./backend/services/jobs/worker.ts');
    await processPlaylistOperation({ kind: 'static-playlist-bulk', operationId: ${operationId} });
    await shutdownJobWorkers({ timeoutMs: 5000 });
  `,
    ],
    { env: process.env, timeout: 15000 },
  );
  dbOps.invalidateSettingsCache();
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.reconcileCommittedJobs();
  assert.equal(requireFixture(store.getBulkOperation(operationId)).state, "completed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylists().length, 2);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(target.id)).tracks.length,
    2,
  );
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    0,
  );
  assert.ok(f.jobs.every((job) => downloadTracker.getJob(job.id)));
});

test("a download the provider will not cancel stays in the Library while every track leaves the playlist", async (t) => {
  const f = fixture(t, 2);
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  vi.spyOn(client, "removeFromQueue").mockImplementation(async () => false);
  downloadPipelineQueue.enqueue({
    jobId: requireFixture(f.jobs[0]).id,
    playlistId: f.source.id,
    playlistGeneration: 0,
    phase: "poll",
    source: "deemix",
    queueUuid: "refused-provider-work",
  });
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  assert.ok(result != null);
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["removed", "removed"],
  );
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    0,
  );
  assert.ok(downloadTracker.getJob(requireFixture(f.jobs[0]).id));
  assert.ok(!downloadTracker.getJob(requireFixture(f.jobs[1]).id));
});

test("bulk leader removal hands its album download to an unselected held peer", async (t) => {
  const f = fixture(t, 2);
  db.prepare(
    "UPDATE download_jobs SET request_group_id = ?, album_mbid = ? WHERE owner_id = 'library'",
  ).run("disposable-album-group", "disposable-album");
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(requireFixture(f.jobs[1]).id);
  downloadTracker.markSlskdDispatched(requireFixture(f.jobs[0]).id);
  downloadPipelineQueue.enqueue({
    jobId: requireFixture(f.jobs[0]).id,
    playlistId: "library",
    playlistGeneration: 0,
    phase: "poll",
    source: "deemix",
    queueUuid: "album-work-needed-by-peer",
    albumGrab: true,
    albumGroupJobIds: f.jobs.map((job) => job.id),
  });
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: [requireFixture(f.selections[0])],
  });
  assert.ok(result != null);
  assert.equal(result.outcomes[0]?.status, "removed");
  assert.ok(!downloadTracker.getJob(requireFixture(f.jobs[0]).id));
  assert.equal(
    requireFixture(downloadTracker.getJob(requireFixture(f.jobs[1]).id)).status,
    "downloading",
  );
  const payload = requireFixture(downloadPipelineQueue.list()[0]).payload;
  assert.ok(payload != null);
  assert.equal(payload.jobId, requireFixture(f.jobs[1]).id);
  assert.equal(payload.queueUuid, "album-work-needed-by-peer");
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    1,
  );
});

test("a failed source commit after provider cleanup leaves a recoverable active job", async (t) => {
  const f = fixture(t, 1);
  const { isDownloadJobCancelled } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  db.exec(
    "CREATE TRIGGER reject_pending_commit BEFORE INSERT ON settings WHEN NEW.key = 'staticPlaylists' BEGIN SELECT RAISE(ABORT, 'fixture pending failure'); END",
  );
  try {
    await assert.rejects(
      operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId }),
      /fixture pending failure/,
    );
    assert.equal(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
      1,
    );
    assert.equal(
      requireFixture(downloadTracker.getJob(requireFixture(f.jobs[0]).id)).status,
      "pending",
    );
    assert.equal(isDownloadJobCancelled(requireFixture(f.jobs[0]).id), false);
    assert.equal(requireFixture(store.getBulkOperation(operationId)).outcomes.length, 0);
  } finally {
    db.exec("DROP TRIGGER reject_pending_commit");
  }
  await operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId });
  assert.equal(requireFixture(store.getBulkOperation(operationId)).state, "completed");
  assert.ok(!downloadTracker.getJob(requireFixture(f.jobs[0]).id));
});

test("duplicate supplied membership IDs cannot detach an unselected track", async (t) => {
  const f = fixture(t, 2);
  config.flowPlaylistConfig.deleteStaticPlaylist(f.source.id);
  const source = config.flowPlaylistConfig.createStaticPlaylist({
    id: f.source.id,
    name: "Source",
    ownerUserId: f.user.id,
    tracks: f.source.tracks.map((track) => ({ ...track, membershipId: "duplicated-membership" })),
  });
  const selection = {
    ...requireFixture(f.selections[0]),
    membershipId: requireFixture(source.tracks[0]).membershipId,
  };
  await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: source.id,
    action: "remove",
    target: null,
    selections: [selection],
  });
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks.length,
    1,
  );
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(source.id)).tracks[0]?.trackName,
    requireFixture(f.jobs[1]).trackName,
  );
  assert.ok(downloadTracker.getJob(requireFixture(f.jobs[1]).id));
});

test("a conflicting destination membership keeps the source job while other tracks move", async (t) => {
  const f = fixture(t, 2);
  const target = config.flowPlaylistConfig.createStaticPlaylist({
    name: "Existing target",
    ownerUserId: f.user.id,
    tracks: [requireFixture(f.source.tracks[0])],
  });
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    target: { playlistId: target.id },
    selections: f.selections,
  });
  assert.ok(result != null);
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["failed", "moved"],
  );
  const source = config.flowPlaylistConfig.getStaticPlaylist(f.source.id);
  assert.ok(source != null);
  assert.equal(source.tracks.length, 1);
  assert.equal(requireFixture(source.tracks[0]).canonicalJobId, requireFixture(f.jobs[0]).id);
  const destination = config.flowPlaylistConfig.getStaticPlaylist(target.id);
  assert.ok(destination != null);
  assert.deepEqual(
    destination.tracks.map((track) => track.canonicalJobId),
    f.jobs.map((job) => job.id),
  );
});

test("a new-target move with only stale selections creates no empty playlist", async (t) => {
  const f = fixture(t, 1);
  config.flowPlaylistConfig.updateStaticPlaylist(f.source.id, { tracks: [] });
  config.flowPlaylistConfig.appendStaticPlaylistTracks(f.source.id, f.source.tracks);
  const targetId = "unused-stale-target";
  const result = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    target: { playlistId: targetId, name: "Should not exist", create: true },
    selections: f.selections,
  });
  assert.ok(result != null);
  assert.equal(result.outcomes[0]?.status, "failed");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(targetId), null);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    1,
  );
  assert.ok(downloadTracker.getJob(requireFixture(f.jobs[0]).id));
  const currentSelection = {
    ...requireFixture(f.selections[0]),
    membershipId: requireFixture(
      requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks[0],
    ).membershipId,
  };
  downloadTracker.removeJob(requireFixture(f.jobs[0]).id);
  const missing = await execute({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    target: { playlistId: targetId, name: "Should not exist", create: true },
    selections: [currentSelection],
  });
  assert.ok(missing != null);
  assert.equal(missing.outcomes[0]?.status, "alreadyAbsent");
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(targetId), null);
  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    1,
  );
});

test("a bulk job whose record vanished mid-run does not write a record without an id", async (t) => {
  const f = fixture(t, 1);
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "move",
    target: { playlistId: "vanishing-target", name: "Vanishing", create: true },
    selections: f.selections,
  });
  db.exec(
    `CREATE TRIGGER vanish_bulk_result AFTER INSERT ON settings
     WHEN NEW.key = 'playlistBulkOperation:${operationId}' AND json_extract(NEW.value, '$.state') = 'completed'
     BEGIN DELETE FROM settings WHERE key = NEW.key; END`,
  );
  const { startPlaylistOperationWorker, stopPlaylistOperationWorker } =
    await import("../../backend/services/playlists/playlistOperationWorker.ts");
  void startPlaylistOperationWorker();
  try {
    await vi.waitFor(
      () =>
        assert.equal(
          requireFixture(
            db
              .prepare<unknown[], { count: number }>(
                "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('pending', 'running')",
              )
              .get(),
          ).count,
          0,
        ),
      { timeout: 10000 },
    );
  } finally {
    await stopPlaylistOperationWorker();
    db.exec("DROP TRIGGER vanish_bulk_result");
  }
  assert.deepEqual(
    db
      .prepare<unknown[], { key: import("../../backend/db/rows.ts").SettingsRow["key"] }>(
        "SELECT key FROM settings WHERE key LIKE 'playlistBulkOperation:%'",
      )
      .all(),
    [],
  );
});

test("a bulk operation Aurral can't read changes nothing and reads as gone", async (t) => {
  const f = fixture(t);
  const { operationId } = store.enqueueBulkOperation({
    ownerUserId: f.user.id,
    sourcePlaylistId: f.source.id,
    action: "remove",
    target: null,
    selections: f.selections,
  });
  db.prepare(
    "UPDATE settings SET value = json_set(value, '$.selections', 'all') WHERE key = ?",
  ).run(`playlistBulkOperation:${operationId}`);

  await operations.processPlaylistOperation({ kind: "static-playlist-bulk", operationId });

  assert.equal(
    requireFixture(config.flowPlaylistConfig.getStaticPlaylist(f.source.id)).tracks.length,
    3,
  );
  assert.equal(store.getBulkOperation(operationId), null);
  store.cleanupBulkOperations();
  assert.equal(
    db.prepare("SELECT 1 FROM settings WHERE key = ?").get(`playlistBulkOperation:${operationId}`),
    undefined,
  );
});
