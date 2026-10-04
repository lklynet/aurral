import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const execFileAsync = promisify(execFile);
const [state, { dbOps }, { downloadTracker }, { getDownloadClient },
  { processUsenetPipelinePayload }, { processPipelinePayload }] = await setupIsolatedBackend(
  "album-source-grabs",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/download/downloadClientSettings.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/downloadPipeline.js",
);

test.after(async () => cleanupIsolatedState(state));

async function makeAlbum(group) {
  const folder = join(state.baseDir, group);
  await mkdir(folder, { recursive: true });
  const files = [];
  for (const [index, title] of ["First", "Second"].entries()) {
    const filePath = join(folder, `0${index + 1} ${title}.flac`);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band", filePath]);
    files.push(filePath);
  }
  const ids = ["First", "Second"].map((trackName, index) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group,
    trackName, trackNumber: index + 1, durationMs: 1000,
    requestGroupId: group, albumTrackCount: 2,
    albumTrackTitles: ["First", "Second"],
  }, "library"));
  downloadTracker.setDownloading(ids[1]);
  return { folder, files, ids, payload: {
    source: "usenet", phase: "download", jobId: ids[0],
    playlistId: "library", playlistGeneration: 0,
    destination: `The Band/${group}`, albumGrab: true, albumGroupJobIds: ids,
  } };
}

test("one Usenet NZB fills two sibling jobs", async (t) => {
  const album = await makeAlbum("usenet-grab");
  const client = getDownloadClient("nzbget");
  const append = t.mock.method(client, "appendUrl", async () => ({ nzbId: "nzb-one" }));
  t.mock.method(client, "getHistoryItem", async () => ({ Status: "SUCCESS", FinalDir: album.folder }));
  const candidate = { raw: { release: { title: "The Band - Album", guid: "release-one",
    downloadUrl: "https://nzb.test/release" } }, score: 10, resolvedAlbumName: "Album" };
  const queued = await processUsenetPipelinePayload({ ...album.payload, candidates: [candidate],
    candidateIndex: 0 }, { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } });
  assert.equal(append.mock.callCount(), 1);
  assert.equal(queued.phase, "poll");
  const polled = await processUsenetPipelinePayload(queued);
  assert.equal(polled.phase, "finalize");
  await processUsenetPipelinePayload(polled);
  for (const id of album.ids) {
    const job = downloadTracker.getJob(id);
    assert.equal(job.status, "done");
    assert.ok((await stat(job.finalPath)).isFile());
  }
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const activity = (await getAurralHistoryRequests()).filter((item) => album.ids.includes(item.jobId));
  assert.equal(activity.length, 2);
  assert.ok(activity.every((item) => item.downloadMethod === "album" && item.actualDownloadSource === "usenet"));
});

test("one Soulseek batch fills two sibling jobs", async (t) => {
  const album = await makeAlbum("soulseek-grab");
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  const remoteFiles = album.files.map((filePath) => ({ file: filePath, size: 0 }));
  const transfers = album.files.map((filePath, index) => ({ id: `transfer-${index}`,
    username: "peer", filename: filePath, state: "Completed" }));
  const enqueue = t.mock.method(client, "enqueueBatch", async () => ({ transfers, username: "peer" }));
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  t.mock.method(client, "getDownloadDirectory", async () => album.folder);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const queued = await processPipelinePayload({ ...album.payload, source: "slskd",
    candidateIndex: 0, candidates: [{ raw: { user: "peer", files: remoteFiles },
      resolvedAlbumName: "Album" }] });
  assert.equal(enqueue.mock.callCount(), 1);
  assert.equal(enqueue.mock.calls[0].arguments[0].files.length, 2);
  const polled = await processPipelinePayload(queued);
  assert.equal(polled.phase, "finalize");
  await processPipelinePayload(polled);
  for (const id of album.ids) {
    const job = downloadTracker.getJob(id);
    assert.equal(job.status, "done");
    assert.ok((await stat(job.finalPath)).isFile());
  }
  const names = album.ids.map((id) => basename(downloadTracker.getJob(id).finalPath));
  assert.match(names[0], /^01 - First\b/);
  assert.match(names[1], /^02 - Second\b/);
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const activity = (await getAurralHistoryRequests()).filter((item) => album.ids.includes(item.jobId));
  assert.equal(activity.length, 2);
  assert.ok(activity.every((item) => item.downloadMethod === "album" && item.actualDownloadSource === "slskd"));
});

async function writeTracks(folder, titles) {
  await mkdir(folder, { recursive: true });
  for (const title of titles) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band", join(folder, `${title}.flac`)]);
  }
}

test("a partial Usenet album tries the next release for the tracks it missed", async (t) => {
  const group = "usenet-next-release";
  const titles = ["First", "Second", "Third"];
  const folders = { partial: join(state.baseDir, `${group}-partial`), complete: join(state.baseDir, `${group}-complete`) };
  await writeTracks(folders.partial, ["First"]);
  await writeTracks(folders.complete, ["Second", "Third"]);
  const ids = titles.map((trackName, index) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group,
    trackName, trackNumber: index + 1, durationMs: 1000,
    requestGroupId: group, albumTrackCount: 3, albumTrackTitles: titles,
  }, "library"));
  for (const id of ids.slice(1)) downloadTracker.setDownloading(id);
  const client = getDownloadClient("nzbget");
  const append = t.mock.method(client, "appendUrl", async ({ url }) => ({ nzbId: url }));
  t.mock.method(client, "getHistoryItem", async (nzbId) => ({ Status: "SUCCESS",
    FinalDir: nzbId.endsWith("partial") ? folders.partial : folders.complete }));
  t.mock.method(client, "deleteQueueItem", async () => true);
  t.mock.method(client, "deleteHistoryItem", async () => true);
  const candidates = ["partial", "complete"].map((name) => ({ raw: { release: {
    title: `The Band - Album ${name}`, guid: `guid-${name}`, downloadUrl: `https://nzb.test/${name}`,
  } }, score: 10, resolvedAlbumName: "Album" }));
  const helpers = { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } };
  let payload = { source: "usenet", phase: "download", jobId: ids[0], playlistId: "library",
    playlistGeneration: 0, destination: `The Band/${group}`, albumGrab: true,
    albumGroupJobIds: ids, candidates, candidateIndex: 0 };
  while (payload) payload = await processUsenetPipelinePayload(payload, helpers);
  assert.equal(append.mock.callCount(), 2);
  for (const id of ids) assert.equal(downloadTracker.getJob(id).status, "done");
  for (const id of ids.slice(1)) {
    assert.deepEqual(downloadTracker.getJob(id).deniedRemoteSources, [["usenet", "guid-partial"]]);
  }
});

test("a Soulseek album gives up on files left in the uploader's queue and keeps the ones that finished", async (t) => {
  const album = await makeAlbum("soulseek-stalled");
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  const transfers = [
    { id: "done", username: "peer", filename: album.files[0], state: "Completed, Succeeded" },
    { id: "stuck", username: "peer", filename: album.files[1], state: "Queued, Remotely", placeInQueue: 9 },
  ];
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  const removed = t.mock.method(client, "deleteTransfer", async () => true);
  t.mock.method(client, "getDownloadDirectory", async () => album.folder);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const remoteFiles = album.files.map((filePath, index) => ({ file: filePath, size: 0, jobId: album.ids[index] }));
  const polling = { ...album.payload, source: "slskd", phase: "poll", candidateIndex: 0,
    candidate: { raw: { user: "peer", files: remoteFiles } }, albumTransfers: transfers };
  const waiting = await processPipelinePayload(polling);
  assert.equal(waiting.phase, "poll");
  transfers[1].placeInQueue = 8;
  const moving = await processPipelinePayload(waiting);
  assert.equal(moving.phase, "poll");
  transfers[1].placeInQueue = 7;
  const stalled = await processPipelinePayload({ ...moving, queuedSince: Date.now() - 11 * 60 * 1000 });
  assert.equal(stalled.phase, "finalize");
  assert.deepEqual(removed.mock.calls.map((call) => call.arguments[1]), ["stuck"]);
  await processPipelinePayload(stalled);
  assert.equal(downloadTracker.getJob(album.ids[0]).status, "done");
  assert.equal(downloadTracker.getJob(album.ids[1]).status, "pending");
});
