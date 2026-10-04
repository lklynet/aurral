import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { NzbgetClient },
  { cleanupNzbgetFiles }, { getDownloadClient }, { processUsenetPipelinePayload },
  { syncPathMappings }, { approveBlockedJob }] = await setupIsolatedBackend(
  "nzbget-cleanup",
  "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js", "backend/services/nzbgetClient.js",
  "backend/services/nzbgetCleanup.js", "backend/services/download/downloadClientSettings.js",
  "backend/services/usenetOrchestrator.js", "backend/services/pathMappings.js",
  "backend/services/downloadJobs/blockedJobReview.js",
);
const exec = promisify(execFile);
let sequence = 0;
let root;

test.beforeEach(async () => {
  resetDatabase(db);
  syncPathMappings([]);
  root = path.join(state.baseDir, `completed-${++sequence}`);
  await fs.mkdir(path.join(root, "aurral", "release"), { recursive: true });
});
test.after(() => cleanupIsolatedState(state));

const folder = () => path.join(root, "aurral", "release");
const options = () => ({ historyItem: { FinalDir: folder(), Category: "aurral" },
  directories: { destDir: root }, category: "aurral" });
const exists = async (target) => Boolean(await fs.stat(target).catch(() => null));

test("cleanup removes album leftovers and sidecars while preserving sibling releases", async () => {
  const sibling = path.join(root, "aurral", "other");
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, "track.flac"), "other download");
  await fs.writeFile(path.join(folder(), "unwanted.flac"), "unused audio");
  await fs.writeFile(path.join(folder(), "cover.jpg"), "cover");
  await cleanupNzbgetFiles(options());
  assert.equal(await exists(folder()), false);
  assert.equal(await fs.readFile(path.join(sibling, "track.flac"), "utf8"), "other download");
});

test("cleanup refuses shared roots, category folders, external folders and other categories", async () => {
  for (const target of [root, path.join(root, "aurral"), state.baseDir]) {
    await assert.rejects(cleanupNzbgetFiles({ ...options(), historyItem: { FinalDir: target } }),
      /release folder/);
    assert.equal(await exists(target), true);
  }
  await assert.rejects(cleanupNzbgetFiles({ ...options(),
    historyItem: { FinalDir: folder(), Category: "music" } }), /another category/);
});

test("cleanup refuses directories that overlap libraries or another download", async () => {
  for (const protectedRoot of [root, folder(), path.join(folder(), "library")]) {
    await assert.rejects(cleanupNzbgetFiles({ ...options(), protectedRoots: [protectedRoot] }),
      /music library/);
  }
  for (const other of [folder(), root, path.join(folder(), "disc2")]) {
    await assert.rejects(cleanupNzbgetFiles({ ...options(), otherItems: [{ DestDir: other }] }),
      /shared with another download/);
  }
  assert.equal(await exists(folder()), true);
});

test("cleanup rejects symlink escapes and leaves symlink contents untouched", async () => {
  const outside = path.join(state.baseDir, "outside");
  await fs.mkdir(path.join(outside, "release"), { recursive: true });
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(cleanupNzbgetFiles({ ...options(),
    historyItem: { FinalDir: path.join(root, "escape", "release") } }), /outside/);
  await fs.symlink(outside, path.join(root, "linked-release"));
  await assert.rejects(cleanupNzbgetFiles({ ...options(),
    historyItem: { FinalDir: path.join(root, "linked-release") } }), /regular directory/);
  assert.equal(await exists(outside), true);
  await fs.symlink(path.join(root, "aurral"), path.join(root, "alias"));
  await assert.rejects(cleanupNzbgetFiles({ ...options(),
    historyItem: { FinalDir: path.join(root, "alias", "release") } }), /outside/);
  assert.equal(await exists(folder()), true);
});

test("a filesystem root cannot authorize cleanup", async () => {
  await assert.rejects(cleanupNzbgetFiles({ ...options(), directories: { destDir: "/" } }),
    /release folder/);
  assert.equal(await exists(folder()), true);
});

test("cleanup follows NZBGet remote mappings, including Windows paths", async () => {
  syncPathMappings([{ source: "nzbget", remote: "D:\\completed", local: root }]);
  await cleanupNzbgetFiles({ ...options(), historyItem: { FinalDir: "D:\\completed\\aurral\\release" },
    directories: { destDir: "D:\\completed" } });
  assert.equal(await exists(folder()), false);
  await assert.rejects(cleanupNzbgetFiles({ ...options(),
    historyItem: { FinalDir: "E:\\unmapped\\release" } }), /unmapped/);
});

test("client preserves history when cleanup is unsafe and honors the opt-out", async (t) => {
  const client = new NzbgetClient({ completedPath: root });
  const rpc = t.mock.method(client, "rpc", async () => true);
  t.mock.method(client, "getDownloadDirectories", async () => ({ completedPath: root }));
  t.mock.method(client, "history", async () => []);
  t.mock.method(client, "listGroups", async () => []);
  await assert.rejects(client.deleteHistoryItem(42, { deleteFiles: true,
    historyItem: { FinalDir: root } }), /release folder/);
  assert.equal(rpc.mock.callCount(), 0);
  client.updateConfig({ completedPath: root, cleanupCompleted: false });
  assert.equal(await client.deleteHistoryItem(42, { deleteFiles: true,
    historyItem: { FinalDir: folder() } }), true);
  assert.equal(await exists(folder()), true);
  assert.deepEqual(rpc.mock.calls[0].arguments, ["editqueue", ["HistoryFinalDelete", "", [42]]]);
});

test("category-specific completed directories are read from NZBGet configuration", async (t) => {
  const client = new NzbgetClient({ category: "aurral" });
  t.mock.method(client, "config", async () => [
    { Name: "DestDir", Value: "/completed" },
    { Name: "Category1.Name", Value: "music" }, { Name: "Category1.DestDir", Value: "/music-downloads" },
    { Name: "Category2.Name", Value: "aurral" }, { Name: "Category2.DestDir", Value: root },
  ]);
  assert.equal((await client.getDownloadDirectories()).categoryDestDir, root);
});

async function pipelineFixture(t, { cleanupCompleted = true, durationMs = 1000 } = {}) {
  dbOps.updateSettings({ integrations: { nzbget: { enabled: true, url: "http://127.0.0.1:9",
    completedPath: root, category: "aurral", cleanupCompleted } } });
  for (const title of ["Wanted", "Unwanted"]) {
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band",
      "-metadata", "album=Album", path.join(folder(), `${title}.flac`)]);
  }
  const jobId = downloadTracker.addJob({ artistName: "The Band", albumName: "Album",
    trackName: "Wanted", durationMs }, "library");
  downloadTracker.setDownloading(jobId);
  downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "usenet",
    downloadClient: "nzbget", downloadClientId: 42 });
  const history = { NZBID: 42, Status: "SUCCESS/ALL", FinalDir: folder(), Category: "aurral" };
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "getHistoryItem", async () => history);
  t.mock.method(client, "getDownloadDirectories", async () => ({ completedPath: root }));
  t.mock.method(client, "history", async () => [history]);
  t.mock.method(client, "listGroups", async () => []);
  const deleted = t.mock.method(client, "editItem", async () => true);
  return { jobId, deleted, payload: { jobId, source: "usenet", phase: "finalize",
    downloadClient: "nzbget", nzbId: 42, history, destination: `The Band/import-${sequence}`,
    candidate: { raw: { release: { title: "The Band - Album FLAC", guid: "release" } },
      resolvedAlbumName: "Album" } } };
}

test("a single-track import keeps the requested song and removes the unused album", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  await processUsenetPipelinePayload(payload);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.equal(await exists(job.finalPath), true);
  assert.equal(await exists(folder()), false);
  assert.ok(deleted.mock.calls.some(({ arguments: args }) => args[0] === "HistoryFinalDelete"));
});

test("a successful import can retain the rest of the album", async (t) => {
  const { jobId, payload } = await pipelineFixture(t, { cleanupCompleted: false });
  await processUsenetPipelinePayload(payload);
  assert.equal(downloadTracker.getJob(jobId).status, "done");
  assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
});

test("a failed import keeps the release and its history", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const obstructed = path.join(state.baseDir, "blocked-destination");
  await fs.mkdir(obstructed);
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: obstructed });
  await fs.writeFile(path.join(obstructed, "The Band"), "a file cannot contain a track");
  await assert.rejects(processUsenetPipelinePayload(payload), /E(NOTDIR|EXIST)/);
  assert.notEqual(downloadTracker.getJob(jobId).status, "done");
  assert.equal(await exists(path.join(folder(), "Wanted.flac")), true);
  assert.equal(deleted.mock.callCount(), 0);
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: null });
});

test("review preserves the album until the requested track is approved", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t, { durationMs: 180000 });
  await processUsenetPipelinePayload(payload);
  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.equal(await exists(path.join(folder(), "Wanted.flac")), true);
  assert.equal(deleted.mock.callCount(), 0);
  assert.equal((await approveBlockedJob(jobId)).status, 200);
  assert.equal(await exists(downloadTracker.getJob(jobId).finalPath), true);
  assert.equal(await exists(folder()), false);
});

test("an album grab imports all requested songs before removing leftover files", async (t) => {
  const { jobId, payload } = await pipelineFixture(t);
  const group = `album-${sequence}`;
  // Recreate the leader with album ownership so both requests share one NZB.
  downloadTracker.removeJob(jobId);
  const ids = ["Wanted", "Unwanted"].map((trackName, index) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group, requestGroupId: group,
    trackName, trackNumber: index + 1, durationMs: 1000,
    albumTrackCount: 2, albumTrackTitles: ["Wanted", "Unwanted"],
  }, "library"));
  for (const id of ids) downloadTracker.setDownloading(id);
  await fs.writeFile(path.join(folder(), "cover.jpg"), "unrequested sidecar");
  await processUsenetPipelinePayload({ ...payload, jobId: ids[0],
    albumGrab: true, albumGroupJobIds: ids });
  for (const id of ids) {
    const job = downloadTracker.getJob(id);
    assert.equal(job.status, "done");
    assert.equal(await exists(job.finalPath), true);
  }
  assert.equal(await exists(folder()), false);
});

test("an incomplete album import preserves the release for recovery", async (t) => {
  const { downloadWorker } = await import("../../backend/services/downloadJobs/downloadWorker.js");
  t.mock.method(downloadWorker, "start", async () => {});
  const { jobId, payload, deleted } = await pipelineFixture(t);
  downloadTracker.removeJob(jobId);
  const group = `partial-album-${sequence}`;
  const ids = ["Wanted", "Unwanted", "Missing"].map((trackName, index) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group, requestGroupId: group,
    trackName, trackNumber: index + 1, durationMs: 1000,
    albumTrackCount: 3, albumTrackTitles: ["Wanted", "Unwanted", "Missing"],
  }, "library"));
  for (const id of ids) downloadTracker.setDownloading(id);
  await fs.writeFile(path.join(folder(), "cover.jpg"), "recoverable sidecar");
  await processUsenetPipelinePayload({ ...payload, jobId: ids[0],
    albumGrab: true, albumGroupJobIds: ids });
  assert.equal(await exists(path.join(folder(), "cover.jpg")), true);
  assert.equal(deleted.mock.callCount(), 0);
  assert.notEqual(downloadTracker.getJob(ids[2]).status, "done");
  await new Promise((resolve) => setImmediate(resolve));
});
