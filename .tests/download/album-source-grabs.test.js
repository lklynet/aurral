import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const execFileAsync = promisify(execFile);
const [state, { dbOps }, { downloadTracker }, { getDownloadClient },
  { processUsenetPipelinePayload }, { processPipelinePayload }, { downloadWorker },
  { buildSlskdRankingHistoryOptions }, { prowlarrClient }] = await setupIsolatedBackend(
  "album-source-grabs",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/download/downloadClientSettings.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/downloadPipeline.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/slskdTransferHistory.js",
  "backend/services/prowlarrClient.js",
);

test.after(async () => {
  await downloadWorker.stopAndDrain();
  await cleanupIsolatedState(state);
});

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
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  const append = t.mock.method(client, "appendNzb", async () => ({ nzbId: "nzb-one" }));
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

test("a Usenet download of a second-disc track takes the disc in its name", async (t) => {
  const folder = join(state.baseDir, "usenet-disc-two");
  await mkdir(folder, { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
    "-metadata", "title=Bomb", "-metadata", "artist=The Band", join(folder, "Bomb.flac")]);
  const jobId = downloadTracker.addJob({ artistName: "The Band", albumName: "Disc Album", trackName: "Bomb",
    trackNumber: 3, discNumber: 2, durationMs: 1000 }, "library");
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  t.mock.method(client, "appendNzb", async () => ({ nzbId: "nzb-disc-two" }));
  t.mock.method(client, "getHistoryItem", async () => ({ Status: "SUCCESS", FinalDir: folder }));
  const candidate = { raw: { release: { title: "The Band - Bomb", guid: "release-disc-two",
    downloadUrl: "https://nzb.test/disc-two" } }, score: 10, resolvedAlbumName: "Disc Album" };
  const fail = { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } };
  let payload = { source: "usenet", phase: "download", jobId, playlistId: "library", playlistGeneration: 0,
    destination: "The Band/Disc Album", candidates: [candidate], candidateIndex: 0 };
  while (payload?.phase) payload = await processUsenetPipelinePayload(payload, fail);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.equal(basename(job.finalPath), "2-03 - Bomb.flac");
  const { common } = await parseFile(job.finalPath);
  assert.deepEqual([common.disk.no, common.track.no], [2, 3]);
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
  t.mock.method(client, "getDownloadDirectory", async () => state.baseDir);
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
  assert.equal(await stat(album.folder).catch(() => null), null);
  const names = album.ids.map((id) => basename(downloadTracker.getJob(id).finalPath));
  assert.match(names[0], /^01 - First\b/);
  assert.match(names[1], /^02 - Second\b/);
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const activity = (await getAurralHistoryRequests()).filter((item) => album.ids.includes(item.jobId));
  assert.equal(activity.length, 2);
  assert.ok(activity.every((item) => item.downloadMethod === "album" && item.actualDownloadSource === "slskd"));
});

test("a Soulseek album left untouched in the uploader's queue moves on after 10 minutes", async (t) => {
  const album = await makeAlbum("soulseek-queued");
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  const transfers = album.files.map((filename, index) => ({ id: `queued-${index}`, username: "peer",
    filename, state: "Requested", bytesTransferred: 0 }));
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  const removed = t.mock.method(client, "deleteTransfer", async () => true);
  const remoteFiles = album.files.map((file, index) => ({ file, size: 0, jobId: album.ids[index] }));
  const polling = { ...album.payload, source: "slskd", phase: "poll", candidateIndex: 0,
    candidate: { raw: { user: "peer", files: remoteFiles } }, albumTransfers: transfers };
  const waiting = await processPipelinePayload(polling);
  assert.equal(waiting.phase, "poll");

  // slskd re-requests queued files, which changes their state but moves nothing.
  for (const transfer of transfers) transfer.state = "Queued, Remotely";
  const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
  const movedOn = await processPipelinePayload({ ...waiting, lastProgressAt: elevenMinutesAgo });
  assert.equal(movedOn.phase, "finalize");
  assert.equal(removed.mock.callCount(), 2);

  transfers[0].placeInQueue = 3;
  assert.equal((await processPipelinePayload({ ...waiting, lastProgressAt: elevenMinutesAgo })).phase, "poll");
});

test("a Soulseek album removes the downloaded files it did not import", async (t) => {
  const album = await makeAlbum("soulseek-unused");
  await rm(album.files[1]);
  const unused = join(album.folder, "02 Somebody Else.flac");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
    "-metadata", "title=Somebody Else", "-metadata", "artist=The Band", unused]);
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => state.baseDir);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const files = [album.files[0], unused];
  const remoteFiles = files.map((file, index) => ({ file, size: 0, jobId: album.ids[index] }));
  const transfers = files.map((filename, index) => ({ id: `transfer-${index}`, username: "peer",
    filename, state: "Completed, Succeeded" }));
  await processPipelinePayload({ ...album.payload, source: "slskd", phase: "finalize", candidateIndex: 0,
    candidates: [{ raw: { user: "peer", files: remoteFiles } }],
    candidate: { raw: { user: "peer", files: remoteFiles } }, albumTransfers: transfers });
  assert.equal(downloadTracker.getJob(album.ids[0]).status, "done");
  assert.equal(downloadTracker.getJob(album.ids[1]).status, "pending");
  assert.equal(await stat(unused).catch(() => null), null);
  assert.equal(await stat(album.folder).catch(() => null), null);
});

async function writeTracks(folder, titles) {
  await mkdir(folder, { recursive: true });
  for (const title of titles) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band", join(folder, `${title}.flac`)]);
  }
}

test("a partial Usenet album tries the next release for the tracks it missed, past an NZB the indexer refuses", async (t) => {
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
  t.mock.method(prowlarrClient, "downloadNzb", async (url) => {
    if (url.endsWith("expired")) throw new Error("The indexer did not return the NZB: HTTP 404");
    return Buffer.from(`<nzb>${url}</nzb>`);
  });
  const append = t.mock.method(client, "appendNzb", async ({ content }) => ({ nzbId: content.toString() }));
  t.mock.method(client, "getHistoryItem", async (nzbId) => ({ Status: "SUCCESS",
    FinalDir: nzbId.includes("partial") ? folders.partial : folders.complete }));
  t.mock.method(client, "deleteQueueItem", async () => true);
  t.mock.method(client, "deleteHistoryItem", async () => true);
  const candidates = ["partial", "expired", "complete"].map((name) => ({ raw: { release: {
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

test("a Soulseek album gives up on files left queued or crawling and keeps the ones that finished", async (t) => {
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
  const stalled = await processPipelinePayload({ ...moving, tailSince: Date.now() - 11 * 60 * 1000 });
  assert.equal(stalled.phase, "finalize");
  assert.deepEqual(removed.mock.calls.map((call) => call.arguments[1]), ["stuck"]);
  const crawling = { ...transfers[1], state: "InProgress", bytesTransferred: 4096, placeInQueue: null };
  t.mock.method(client, "getTransfer", async (_, id) => (id === "stuck" ? crawling : transfers[0]));
  crawling.bytesTransferred = 8192;
  assert.equal((await processPipelinePayload({ ...moving, tailSince: Date.now() - 11 * 60 * 1000 })).phase, "poll");
  crawling.bytesTransferred = 12288;
  assert.equal((await processPipelinePayload({ ...moving, tailSince: Date.now() - 21 * 60 * 1000 })).phase,
    "finalize");
  await processPipelinePayload(stalled);
  assert.equal(downloadTracker.getJob(album.ids[0]).status, "done");
  assert.equal(downloadTracker.getJob(album.ids[1]).status, "pending");
});

test("a Soulseek album's next folder gets its own queue window", async (t) => {
  const album = await makeAlbum("soulseek-next-folder");
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  const transfers = [
    { id: "failed", username: "peer", filename: album.files[0], state: "Completed, Errored" },
    { id: "queued", username: "peer", filename: album.files[1], state: "Queued, Remotely", placeInQueue: 4 },
  ];
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  t.mock.method(client, "deleteTransfer", async () => true);
  t.mock.method(client, "getDownloadDirectory", async () => album.folder);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const folder = (user) => ({ raw: { user, files: album.files.map((filePath, index) =>
    ({ file: filePath, size: 0, jobId: album.ids[index] })) } });
  const candidates = [folder("peer"), folder("other")];
  const giveUp = await processPipelinePayload({ ...album.payload, source: "slskd", phase: "poll",
    candidateIndex: 0, candidates, candidate: candidates[0], albumTransfers: transfers,
    tailSince: Date.now() - 11 * 60 * 1000 });
  assert.equal(giveUp.phase, "finalize");
  assert.equal(buildSlskdRankingHistoryOptions().getUserQueuePenalty("peer"), 0);
  const next = await processPipelinePayload(giveUp);
  assert.equal(next.candidateIndex, 1);
  assert.equal(next.tailSince ?? null, null);
  assert.ok(buildSlskdRankingHistoryOptions().getUserQueuePenalty("peer") > 0);
  assert.deepEqual(downloadTracker.getJob(album.ids[0]).deniedRemoteSources, [["slskd", `peer\0${album.files[0]}`]]);
});
