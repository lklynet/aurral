import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { NzbgetClient },
  { removeNzbgetDownloadFolder }, { getDownloadClient }, { processUsenetPipelinePayload },
  { syncPathMappings }, { approveBlockedJob, denyBlockedJob }] = await setupIsolatedBackend(
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
const remove = (historyItem = { DestDir: folder() }, directories = { destDir: root }) =>
  removeNzbgetDownloadFolder(historyItem, directories, "aurral");
const exists = async (target) => Boolean(await fs.stat(target).catch(() => null));

test("removes the download folder and keeps sibling downloads", async () => {
  const sibling = path.join(root, "aurral", "other");
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, "track.flac"), "other download");
  await fs.writeFile(path.join(folder(), "unwanted.flac"), "unused audio");
  await remove();
  assert.equal(await exists(folder()), false);
  assert.equal(await fs.readFile(path.join(sibling, "track.flac"), "utf8"), "other download");
});

test("refuses anything but a direct child of NZBGet's download folders", async () => {
  await fs.mkdir(path.join(folder(), "disc2"));
  for (const target of [root, path.join(root, "aurral"), path.join(folder(), "disc2"), state.baseDir]) {
    await assert.rejects(remove({ DestDir: target }), /not inside NZBGet/);
    assert.equal(await exists(target), true);
  }
});

test("a category with path components cannot widen the allowed folders", async () => {
  const outside = path.join(state.baseDir, `outside-${sequence}`, "release");
  await fs.mkdir(outside, { recursive: true });
  const escape = path.relative(root, path.dirname(outside));
  await assert.rejects(removeNzbgetDownloadFolder({ DestDir: outside }, { destDir: root }, escape),
    /not inside NZBGet/);
  assert.equal(await exists(outside), true);
});

test("removes a failed download from the intermediate folder", async () => {
  const inter = path.join(state.baseDir, `inter-${sequence}`);
  await fs.mkdir(path.join(inter, "release.#42"), { recursive: true });
  await remove({ DestDir: path.join(inter, "release.#42") }, { destDir: root, interDir: inter });
  assert.equal(await exists(path.join(inter, "release.#42")), false);
  assert.equal(await exists(inter), true);
});

test("leaves a download that a post-processing script moved", async () => {
  await assert.rejects(remove({ DestDir: folder(), FinalDir: path.join(root, "sorted") }),
    /post-processing script/);
  assert.equal(await exists(folder()), true);
});

test("refuses symlinks", async () => {
  const outside = path.join(state.baseDir, `outside-${sequence}`);
  await fs.mkdir(path.join(outside, "release"), { recursive: true });
  await fs.symlink(outside, path.join(root, "aurral", "linked"));
  await assert.rejects(remove({ DestDir: path.join(root, "aurral", "linked") }), /not a directory/);
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(remove({ DestDir: path.join(root, "escape", "release") }), /not inside NZBGet/);
  assert.equal(await exists(path.join(outside, "release")), true);
});

test("refuses a folder that holds or is inside the music library", async () => {
  for (const library of [folder(), path.join(folder(), "Music")]) {
    dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: library });
    await fs.mkdir(library, { recursive: true });
    await assert.rejects(remove(), /music library/);
    assert.equal(await exists(library), true);
  }
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: null });
});

test("follows remote path mappings and refuses unmapped Windows paths", async () => {
  await assert.rejects(remove({ DestDir: "D:\\completed\\aurral\\release" },
    { destDir: "D:\\completed" }), /unmapped/);
  syncPathMappings([{ source: "nzbget", remote: "D:\\completed", local: root }]);
  await remove({ DestDir: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" });
  assert.equal(await exists(folder()), false);
});

test("a folder that is already gone is not an error", async () => {
  await fs.rm(folder(), { recursive: true });
  await remove();
});

test("the client keeps the history item when files cannot be removed, and honors the opt-out", async (t) => {
  const client = new NzbgetClient({ completedPath: root });
  const rpc = t.mock.method(client, "rpc", async () => true);
  t.mock.method(client, "getDownloadDirectories", async () => ({ completedPath: root }));
  await assert.rejects(client.deleteHistoryItem(42, { deleteFiles: true,
    historyItem: { DestDir: root } }), /not inside NZBGet/);
  assert.equal(rpc.mock.callCount(), 0);
  client.updateConfig({ completedPath: root, deleteLeftovers: false });
  assert.equal(await client.deleteHistoryItem(42, { deleteFiles: true,
    historyItem: { DestDir: folder() } }), true);
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

async function pipelineFixture(t, { deleteLeftovers = true, durationMs = 1000 } = {}) {
  dbOps.updateSettings({ integrations: { nzbget: { enabled: true, url: "http://127.0.0.1:9",
    completedPath: root, category: "aurral", deleteLeftovers } } });
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
  const history = { NZBID: 42, Status: "SUCCESS/ALL", DestDir: folder(), Category: "aurral" };
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "getHistoryItem", async () => history);
  t.mock.method(client, "getDownloadDirectories", async () => ({ completedPath: root }));
  const deleted = t.mock.method(client, "editItem", async () => true);
  return { jobId, deleted, payload: { jobId, source: "usenet", phase: "finalize",
    downloadClient: "nzbget", nzbId: 42, history, destination: `The Band/import-${sequence}`,
    candidate: { raw: { release: { title: "The Band - Album FLAC", guid: "release" } },
      resolvedAlbumName: "Album" } } };
}

const historyDeletes = (deleted) =>
  deleted.mock.calls.filter((call) => call.arguments[0] === "HistoryFinalDelete").length;

test("a single-track import keeps the requested song and removes the rest of the album", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  await processUsenetPipelinePayload(payload);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.equal(await exists(job.finalPath), true);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});

test("turning off Delete leftover files keeps the rest of the album", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t, { deleteLeftovers: false });
  await processUsenetPipelinePayload(payload);
  assert.equal(downloadTracker.getJob(jobId).status, "done");
  assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
  assert.equal(historyDeletes(deleted), 1);
});

test("a failed import keeps the download and its history", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const obstructed = path.join(state.baseDir, "blocked-destination");
  await fs.mkdir(obstructed, { recursive: true });
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: obstructed });
  await fs.writeFile(path.join(obstructed, "The Band"), "a file cannot contain a track");
  await assert.rejects(processUsenetPipelinePayload(payload), /E(NOTDIR|EXIST)/);
  assert.notEqual(downloadTracker.getJob(jobId).status, "done");
  assert.equal(await exists(path.join(folder(), "Wanted.flac")), true);
  assert.equal(deleted.mock.callCount(), 0);
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: null });
});

for (const [decision, review] of [["approved", approveBlockedJob], ["denied", denyBlockedJob]]) {
  test(`a song held for review keeps its download until it is ${decision}`, async (t) => {
    const { jobId, payload, deleted } = await pipelineFixture(t, { durationMs: 180000 });
    await processUsenetPipelinePayload(payload);
    assert.equal(downloadTracker.getJob(jobId).status, "blocked");
    assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
    assert.equal(deleted.mock.callCount(), 0);
    assert.equal((await review(jobId)).status, 200);
    assert.equal(await exists(folder()), false);
    assert.equal(historyDeletes(deleted), 1);
  });
}

test("an album grab removes the download after importing its songs", async (t) => {
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

test("a download whose request is cancelled while it is checked is removed", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const { cancelDownloadJob } = await import("../../backend/services/downloadJobs/downloadCancellation.js");
  t.mock.method(getDownloadClient("nzbget"), "getHistoryItem", async () => {
    cancelDownloadJob(jobId);
    return payload.history;
  });
  assert.equal(await processUsenetPipelinePayload({ ...payload, history: null }), null);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});

const failAttempt = (jobId) => ({ failOrTryNextSource: (_payload, job, reason) => {
  assert.equal(job.id, jobId);
  downloadTracker.setFailed(job.id, reason);
  return null;
} });

test("a failed download is removed before Aurral tries the next release", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  payload.history.Status = "FAILURE/PAR";
  const next = await processUsenetPipelinePayload({ ...payload, phase: "poll",
    candidateIndex: 0, candidates: [payload.candidate, payload.candidate] });
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
  assert.equal(downloadTracker.getJob(jobId).status, "downloading");
});

test("a rejected download is removed", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  dbOps.updateSettings({ ...dbOps.getSettings(), qualityProfile: { enabled: ["mp3-320"] } });
  await processUsenetPipelinePayload(payload, failAttempt(jobId));
  assert.equal(downloadTracker.getJob(jobId).status, "failed");
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});
