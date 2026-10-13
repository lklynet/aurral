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

async function makeUpgrades(group, titles, { files = titles } = {}) {
  const folder = join(state.baseDir, group);
  const originals = join(state.baseDir, `${group}-originals`);
  await mkdir(folder, { recursive: true });
  await mkdir(originals, { recursive: true });
  for (const [index, title] of files.entries()) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band", join(folder, `0${index + 1} ${title}.flac`)]);
  }
  const upgradeIds = [];
  for (const [index, title] of titles.entries()) {
    const original = join(originals, `${index} ${title}.mp3`);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc", "-t", "1", "-c:a", "libmp3lame", "-b:a", "128k", original]);
    const sourceId = downloadTracker.addJob({ artistName: "The Band", albumName: group, trackName: title,
      durationMs: 1000 }, "library");
    downloadTracker.setDone(sourceId, original, group);
    downloadTracker.updateQuality(sourceId, { tier: "mp3-128" });
    const upgradeId = downloadTracker.addUpgradeJob(downloadTracker.getJob(sourceId));
    downloadTracker.setDownloading(upgradeId);
    upgradeIds.push(upgradeId);
  }
  const candidate = { raw: { release: { title: `The Band - ${group} FLAC`, guid: `${group}-release`,
    downloadUrl: `https://nzb.test/${group}` } }, score: 10, resolvedAlbumName: group };
  const start = (jobId, helpers) => processUsenetPipelinePayload({ source: "usenet", phase: "download", jobId,
    upgradeForJobId: downloadTracker.getJob(jobId).upgradeForJobId, playlistId: "library", playlistGeneration: 0,
    destination: `The Band/${group}`, candidates: [candidate], candidateIndex: 0 }, helpers);
  return { folder, upgradeIds, start };
}

function mockNzbget(t, folder, nzbIds = [77]) {
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  const append = t.mock.method(client, "appendNzb", async () => ({ nzbId: nzbIds.shift() ?? 99 }));
  t.mock.method(client, "getHistoryItem", async (nzbId) => ({ NZBID: nzbId, Status: "SUCCESS", FinalDir: folder }));
  const removed = t.mock.method(client, "deleteHistoryItem", async () => true);
  t.mock.method(client, "deleteQueueItem", async () => true);
  return { append, removed };
}

const failOnSourceFallback = { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } };

async function runToEnd(payload, helpers = failOnSourceFallback) {
  while (payload?.phase) payload = await processUsenetPipelinePayload(payload, helpers);
}

test("upgrades for two tracks of one album share a single Usenet download", async (t) => {
  const titles = ["First", "Second"];
  const { folder, upgradeIds, start } = await makeUpgrades("shared-upgrade", titles);
  const { append, removed } = mockNzbget(t, folder);

  const [first, second] = await Promise.all(upgradeIds.map((id) => start(id, failOnSourceFallback)));
  assert.equal(append.mock.callCount(), 1);
  assert.deepEqual([first.nzbId, second.nzbId], [77, 77]);

  await runToEnd(first);
  assert.equal(downloadTracker.getJob(upgradeIds[0]), null);
  assert.equal(removed.mock.callCount(), 0);

  await runToEnd(second);
  assert.equal(downloadTracker.getJob(upgradeIds[1]), null);
  assert.equal(removed.mock.callCount(), 1);
  const upgraded = downloadTracker.getAll().filter((job) => job.albumName === "shared-upgrade" && !job.upgradeForJobId);
  assert.deepEqual(upgraded.map((job) => job.trackName).sort(), titles);
  for (const job of upgraded) {
    assert.match(job.finalPath, /\.flac$/);
    assert.ok((await stat(job.finalPath)).isFile());
  }
});

test("the last upgrade to reject a shared Usenet download removes it", async (t) => {
  const { folder, upgradeIds, start } = await makeUpgrades("shared-rejected", ["First", "Second"],
    { files: ["Other", "Another"] });
  const { append, removed } = mockNzbget(t, folder);
  const ended = [];
  const helpers = { failOrTryNextSource: (_, job) => { ended.push(job.id); return null; } };

  const started = await Promise.all(upgradeIds.map((id) => start(id, helpers)));
  assert.equal(append.mock.callCount(), 1);
  for (const payload of started) await runToEnd(payload, helpers);
  assert.deepEqual(ended.sort(), [...upgradeIds].sort());
  assert.equal(removed.mock.callCount(), 1);
});

test("an upgrade never attaches to a Usenet download that is being removed", async (t) => {
  const { folder, upgradeIds, start } = await makeUpgrades("removing-download", ["First", "Second"],
    { files: ["Other"] });
  const { append, removed } = mockNzbget(t, folder, [101, 102]);
  let finishRemoval;
  let removalStarted;
  const started = new Promise((resolve) => { removalStarted = resolve; });
  removed.mock.mockImplementation(() => {
    removalStarted();
    return new Promise((resolve) => { finishRemoval = () => resolve(true); });
  });
  const helpers = { failOrTryNextSource: () => null };

  const rejecting = runToEnd(await start(upgradeIds[0], helpers), helpers);
  await started;
  const next = await start(upgradeIds[1], helpers);
  finishRemoval();
  await rejecting;

  assert.equal(append.mock.callCount(), 2);
  assert.equal(next.nzbId, 102);
});

test("upgrades for two copies of one track download the release separately", async (t) => {
  const { folder, upgradeIds, start } = await makeUpgrades("same-track", ["First", "First"], { files: ["First"] });
  const { append } = mockNzbget(t, folder, [81, 82]);

  const started = await Promise.all(upgradeIds.map((id) => start(id, failOnSourceFallback)));
  assert.equal(append.mock.callCount(), 2);
  assert.deepEqual(started.map((payload) => payload.nzbId).sort(), [81, 82]);
});

test("after a failed Usenet submission, one waiting upgrade submits the release for the others", async (t) => {
  const { upgradeIds, start } = await makeUpgrades("failed-submission", ["First", "Second", "Third"]);
  const client = getDownloadClient("nzbget");
  let fetches = 0;
  t.mock.method(prowlarrClient, "downloadNzb", async () => {
    fetches += 1;
    if (fetches === 1) throw new Error("HTTP 429");
    return Buffer.from("<nzb></nzb>");
  });
  const append = t.mock.method(client, "appendNzb", async () => ({ nzbId: 91 }));
  const helpers = { failOrTryNextSource: () => null };

  const started = await Promise.all(upgradeIds.map((id) => start(id, helpers)));
  assert.equal(fetches, 2);
  assert.equal(append.mock.callCount(), 1);
  assert.deepEqual(started.filter(Boolean).map((payload) => payload.nzbId), [91, 91]);
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
