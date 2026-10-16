import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { parseFile } from "music-metadata";
import express from "express";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.js";

const execFileAsync = promisify(execFile);
const [state, { dbOps, userOps }, { downloadTracker }, { getDownloadClient },
  { processUsenetPipelinePayload }, { processPipelinePayload }, { downloadWorker },
  { buildSlskdRankingHistoryOptions }, { prowlarrClient },
  { beginDownloadAttempt, getActiveDownloadAttemptId, setActiveDownloadAttemptId },
  { queueQualityUpgrade, runQualityUpgradeCheck }, { resolveDownloadRoot }, { registerJobs },
  { flowPlaylistConfig }] = await setupIsolatedBackend(
  "album-source-grabs",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/download/downloadClientSettings.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/downloadPipeline.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/slskdTransferHistory.js",
  "backend/services/prowlarrClient.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/qualityProfileService.js",
  "backend/services/downloadPaths.js",
  "backend/routes/playlists/handlers/jobs.js",
  "backend/services/playlists/flowPlaylistConfig.js",
);

test.after(async () => {
  await downloadWorker.stopAndDrain();
  await cleanupIsolatedState(state);
});

// Serves the album's one release from the metadata provider and returns its ID.
async function serveRelease(t, group, titles, title = "Album") {
  await serveGroups(t, [brainzmashGroup({ id: group, title, artist: "The Band", artistId: "the-band",
    releases: [{ id: `${group}-release`, tracks: titles.map((title) => ({ title, durationMs: 1000 })) }] })]);
  return `${group}-release`;
}

function useSlskd() {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { metadata: settings.integrations?.metadata,
    slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
}

async function writeTracks(folder, titles, numbers = titles.map((_, index) => index + 1)) {
  await mkdir(folder, { recursive: true });
  const files = [];
  for (const [index, title] of titles.entries()) {
    const filePath = join(folder, `${String(numbers[index]).padStart(2, "0")} ${title}.flac`);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
      "-metadata", `title=${title}`, "-metadata", "artist=The Band", filePath]);
    files.push(filePath);
  }
  return files;
}

function addAlbumJobs(group, titles, wanted = titles, { requestGroupId = group, playlist = "library" } = {}) {
  const ids = wanted.map((trackName) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group,
    trackName, trackNumber: titles.indexOf(trackName) + 1, durationMs: 1000,
    requestGroupId, albumTrackCount: titles.length, albumTrackTitles: titles,
  }, playlist));
  const downloadAttemptId = beginDownloadAttempt(ids[0]);
  for (const id of ids) setActiveDownloadAttemptId(id, downloadAttemptId);
  for (const id of ids.slice(1)) downloadTracker.setDownloading(id);
  return ids;
}

async function makeAlbum(t, group) {
  const titles = ["First", "Second"];
  const folder = join(state.baseDir, group);
  const files = await writeTracks(folder, titles);
  const ids = addAlbumJobs(group, titles);
  return { folder, files, ids, payload: {
    source: "usenet", phase: "download", jobId: ids[0], downloadAttemptId: getActiveDownloadAttemptId(ids[0]),
    playlistId: "library", playlistGeneration: 0, releaseMbid: await serveRelease(t, group, titles),
    destination: `The Band/${group}`, albumGrab: true, albumGroupJobIds: ids,
  } };
}

test("one Usenet NZB fills two sibling jobs", async (t) => {
  const album = await makeAlbum(t, "usenet-grab");
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  const append = t.mock.method(client, "appendNzb", async () => ({ nzbId: "nzb-one" }));
  t.mock.method(client, "getHistoryItem", async () => ({ Status: "SUCCESS", FinalDir: album.folder }));
  const candidate = { raw: { release: { title: "The Band - Album", guid: "release-one",
    downloadUrl: "https://nzb.test/release" } }, score: 10, resolvedAlbumName: "Other Release" };
  const queued = await processUsenetPipelinePayload({ ...album.payload, candidates: [candidate],
    candidateIndex: 0 }, { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } });
  assert.equal(append.mock.callCount(), 1);
  assert.equal(queued.phase, "poll");
  const polled = await processUsenetPipelinePayload(queued);
  assert.equal(polled.phase, "finalize");
  await processUsenetPipelinePayload(polled);
  for (const id of album.ids) {
    const job = downloadTracker.getJob(id);
    assert.deepEqual([job.status, job.albumName], ["done", "Album"]);
    assert.ok((await stat(job.finalPath)).isFile());
  }
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const activity = (await getAurralHistoryRequests()).filter((item) => album.ids.includes(item.jobId));
  assert.equal(activity.length, 2);
  assert.ok(activity.every((item) => item.downloadMethod === "album" && item.actualDownloadSource === "usenet"));
});

test("a Usenet NZB short of the pinned release imports nothing, blocks it for every track, and hands the album to the next album source", async (t) => {
  const group = "usenet-short-release";
  const titles = ["First", "Second", "Third"];
  const folder = join(state.baseDir, group);
  await writeTracks(folder, titles.slice(0, 2));
  const ids = addAlbumJobs(group, titles);
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: {
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9", priority: 1 },
    deemix: { enabled: true, url: "http://127.0.0.1:9", priority: 2 },
  } });
  t.after(() => dbOps.updateSettings(settings));
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "deleteHistoryItem", async () => true);
  t.mock.method(client, "deleteQueueItem", async () => true);
  const releaseMbid = await serveRelease(t, group, titles);
  const next = await processUsenetPipelinePayload({
    source: "usenet", phase: "finalize", jobId: ids[0], playlistId: "library", playlistGeneration: 0,
    downloadAttemptId: getActiveDownloadAttemptId(ids[0]),
    destination: `The Band/${group}`, albumGrab: true, albumGroupJobIds: ids, releaseMbid,
    nzbId: "short-nzb", downloadedPath: folder, history: { Status: "SUCCESS", FinalDir: folder },
    candidateIndex: 0, candidates: [{ raw: { release: {
      title: "The Band - Album", guid: "short-release", downloadUrl: "https://nzb.test/short",
    } }, resolvedAlbumName: "Album", releaseVerified: false }],
  });
  assert.deepEqual([next.source, next.phase, next.albumGrab, next.jobId], ["deemix", "search", true, ids[0]]);
  assert.deepEqual(next.albumGroupJobIds, ids);
  assert.equal(next.releaseMbid, releaseMbid);
  for (const id of ids) {
    const job = downloadTracker.getJob(id);
    assert.notEqual(job.status, "done");
    assert.deepEqual(job.deniedRemoteSources, [["usenet", "short-release"]]);
  }
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

// A Library track at MP3 128 pinned to its album's release, beside a
// sibling of the same request still waiting to download.
async function pinnedUpgrade(t, group, { releaseCodec = "flac" } = {}) {
  const titles = ["First", "Second"];
  const releaseMbid = await serveRelease(t, group, titles, group);
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { metadata: settings.integrations?.metadata,
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9" } } });
  const mp3 = ["-c:a", "libmp3lame", "-b:a", "128k"];
  const original = join(resolveDownloadRoot(), "The Band", group, "02 - Second.mp3");
  await mkdir(dirname(original), { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc",
    "-t", "1", ...mp3, original]);
  const folder = join(state.baseDir, `${group}-release`);
  await mkdir(folder, { recursive: true });
  for (const [index, title] of titles.entries()) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", ...(releaseCodec === "flac" ? ["-c:a", "flac"] : mp3),
      "-metadata", `title=${title}`, "-metadata", "artist=The Band",
      join(folder, `0${index + 1} ${title}.${releaseCodec}`)]);
  }
  const album = { artistName: "The Band", albumName: group, albumMbid: group, releaseMbid, requestGroupId: group,
    durationMs: 1000, albumTrackCount: 2, albumTrackTitles: titles };
  const sourceId = downloadTracker.addJob({ ...album, trackName: "Second", trackNumber: 2 }, "library");
  downloadTracker.setDone(sourceId, original, group);
  downloadTracker.updateQuality(sourceId, { tier: "mp3-128" });
  const siblingId = downloadTracker.addJob({ ...album, trackName: "First", trackNumber: 1 }, "library");
  const queued = [];
  t.mock.method(downloadTracker, "enqueuePipeline", (payload) => queued.push(payload));
  assert.equal(await queueQualityUpgrade(downloadTracker.getJob(sourceId)), "queued");
  const [attempt] = queued;
  assert.deepEqual([attempt.albumGrab, attempt.releaseMbid, attempt.albumGroupJobIds],
    [true, releaseMbid, [attempt.jobId]]);
  const candidate = { raw: { release: { title: `The Band - ${group}`, guid: `${group}-nzb`,
    downloadUrl: `https://nzb.test/${group}` } }, score: 10, resolvedAlbumName: group, releaseVerified: false };
  return { original, folder, sourceId, siblingId, upgradeId: attempt.jobId,
    download: { ...attempt, source: "usenet", phase: "download", candidates: [candidate], candidateIndex: 0 } };
}

test("an upgrade downloads its release first, imports only its own track, and replaces the old file", async (t) => {
  const upgrade = await pinnedUpgrade(t, "upgrade-by-release");
  const { append } = mockNzbget(t, upgrade.folder);
  const trackSearch = t.mock.method(prowlarrClient, "search", async () => []);

  let payload = upgrade.download;
  while (payload) payload = await processPipelinePayload(payload);

  assert.equal(append.mock.callCount(), 1);
  assert.equal(trackSearch.mock.callCount(), 0);
  assert.equal(downloadTracker.getJob(upgrade.upgradeId), null);
  const upgraded = downloadTracker.getJob(upgrade.sourceId);
  assert.deepEqual([upgraded.status, basename(upgraded.finalPath), upgraded.qualityTier],
    ["done", "02 - Second.flac", "flac-standard"]);
  assert.ok((await stat(upgraded.finalPath)).isFile());
  await assert.rejects(stat(upgrade.original));
  assert.deepEqual((await readdir(dirname(upgraded.finalPath))).filter((name) => name.includes("First")), []);
  assert.deepEqual([downloadTracker.getJob(upgrade.siblingId).status, downloadTracker.getJob(upgrade.siblingId).finalPath],
    ["pending", null]);
});

test("an upgrade's release with no better copy imports nothing and the upgrade searches for its track", async (t) => {
  const upgrade = await pinnedUpgrade(t, "upgrade-not-better", { releaseCodec: "mp3" });
  mockNzbget(t, upgrade.folder);
  t.mock.method(prowlarrClient, "getEnabledUsenetIndexers", async () => [{ id: 1, name: "indexer" }]);
  const trackSearch = t.mock.method(prowlarrClient, "search", async () => []);

  let payload = upgrade.download;
  while (payload) payload = await processPipelinePayload(payload);

  assert.ok(trackSearch.mock.calls.some((call) => JSON.stringify(call.arguments).includes("Second")));
  assert.equal(downloadTracker.getJob(upgrade.upgradeId), null);
  const kept = downloadTracker.getJob(upgrade.sourceId);
  assert.deepEqual([kept.status, kept.finalPath, kept.qualityTier], ["done", upgrade.original, "mp3-128"]);
  assert.ok((await stat(upgrade.original)).isFile());
  assert.equal(downloadTracker.getAll().some((job) => job.status === "blocked"), false);
});

// Two tracks of one album at MP3 128, by default both in the Library from one
// request and pinned to one release, and a Usenet download of the album in
// FLAC not yet fetched.
async function releaseUpgrades(t, group, {
  requestGroupIds = [group, group],
  owners = ["library", "library"],
  pins = [`${group}-release`, `${group}-release`],
  missing,
} = {}) {
  for (const job of downloadTracker.getAll()) downloadTracker.removeJob(job.id);
  const titles = ["First", "Second"];
  await serveGroups(t, [brainzmashGroup({ id: group, title: group, artist: "The Band", artistId: "the-band",
    releases: [...new Set(pins)].map((id) => ({ id, tracks: titles.map((title) => ({ title, durationMs: 1000 })) })) })],
  { missing });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { metadata: settings.integrations?.metadata,
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9" } } });
  const folder = join(state.baseDir, `${group}-nzb`);
  await mkdir(folder, { recursive: true });
  const album = { artistName: "The Band", albumName: group, albumMbid: group,
    durationMs: 1000, albumTrackCount: 2, albumTrackTitles: titles };
  const sourceIds = [];
  for (const [index, title] of titles.entries()) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-t", "1", "-c:a", "flac", "-metadata", `title=${title}`, "-metadata", "artist=The Band",
      join(folder, `0${index + 1} ${title}.flac`)]);
    const original = join(resolveDownloadRoot(), "The Band", group, `0${index + 1} - ${title}.mp3`);
    await mkdir(dirname(original), { recursive: true });
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "1",
      "-c:a", "libmp3lame", "-b:a", "128k", original]);
    const id = downloadTracker.addJob({ ...album, trackName: title, trackNumber: index + 1,
      releaseMbid: pins[index], requestGroupId: requestGroupIds[index] }, owners[index]);
    downloadTracker.setDone(id, original, group);
    downloadTracker.updateQuality(id, { tier: "mp3-128" });
    sourceIds.push(id);
  }
  const queued = [];
  t.mock.method(downloadTracker, "enqueuePipeline", (payload) => queued.push(payload));
  t.mock.method(prowlarrClient, "getEnabledUsenetIndexers", async () => [{ id: 1, name: "indexer" }]);
  const trackSearch = t.mock.method(prowlarrClient, "search", async () => []);
  const candidate = { raw: { release: { title: `The Band - ${group}`, guid: `${group}-guid`,
    downloadUrl: `https://nzb.test/${group}` } }, score: 10, resolvedAlbumName: group, releaseVerified: false };
  const download = (attempt) => ({ ...attempt, source: "usenet", phase: "download", candidates: [candidate],
    candidateIndex: 0 });
  const landed = () => sourceIds.map((id) => {
    const job = downloadTracker.getJob(id);
    return [job.status, basename(job.finalPath), job.qualityTier];
  });
  return { folder, sourceIds, queued, trackSearch, download, landed };
}

// NZBGet downloads a release again into the folder of the same name, and
// Prowlarr finds the album's one NZB for any search.
async function oneFolderNzbget(t, group, upgrades) {
  const pristine = `${upgrades.folder}-pristine`;
  await cp(upgrades.folder, pristine, { recursive: true });
  const { append } = mockNzbget(t, upgrades.folder);
  append.mock.mockImplementation(async () => {
    await cp(pristine, upgrades.folder, { recursive: true, force: true });
    return { nzbId: 78 + append.mock.callCount() };
  });
  upgrades.trackSearch.mock.mockImplementation(async () => [{ guid: `${group}-guid`, protocol: "usenet",
    title: `The Band - ${group} FLAC`, downloadUrl: `https://nzb.test/${group}`,
    indexerId: 1, size: 100 * 1024 * 1024, categories: [3040] }]);
  return append;
}

async function stepUntil(payload, done) {
  for (let step = 0; step < 20 && payload && !done(payload); step += 1) payload = await processPipelinePayload(payload);
  return payload;
}

test("an upgrade started while another upgrade downloads the same release waits for it on NZBGet, then downloads the release whole, and both land", async (t) => {
  const upgrades = await releaseUpgrades(t, "upgrade-each-release");
  const append = await oneFolderNzbget(t, "upgrade-each-release", upgrades);

  for (const id of upgrades.sourceIds) assert.equal(await queueQualityUpgrade(downloadTracker.getJob(id)), "queued");
  assert.deepEqual(upgrades.queued.map((attempt) => [attempt.albumGrab, attempt.albumGroupJobIds.length]),
    [[true, 1], [true, 1]]);
  let [first, second] = upgrades.queued;
  first = await stepUntil(first, (payload) => payload.phase === "poll");
  assert.equal(append.mock.callCount(), 1);
  second = await processPipelinePayload(second);
  assert.deepEqual([second.phase, second.delaySeconds > 0], ["waiting", true]);
  second = await processPipelinePayload(second);
  assert.equal(second.phase, "waiting");
  assert.equal(append.mock.callCount(), 1);

  await stepUntil(first, () => false);
  assert.deepEqual(upgrades.landed()[0], ["done", "01 - First.flac", "flac-standard"]);
  await stepUntil(second, () => false);
  assert.equal(append.mock.callCount(), 2);
  assert.deepEqual(upgrades.landed(),
    [["done", "01 - First.flac", "flac-standard"], ["done", "02 - Second.flac", "flac-standard"]]);
  assert.equal(downloadTracker.getAll().some((job) => job.upgradeForJobId), false);
});

test("an upgrade pinned to another pressing of the album waits for the upgrade downloading the album, so NZBGet never holds its NZB twice, and both land", async (t) => {
  const group = "upgrade-two-pressings";
  const upgrades = await releaseUpgrades(t, group,
    { requestGroupIds: ["album-request", null], pins: [`${group}-cd`, `${group}-vinyl`] });
  const append = await oneFolderNzbget(t, group, upgrades);

  assert.equal(await runQualityUpgradeCheck({ force: true }), 2);
  assert.deepEqual(upgrades.queued.map((attempt) => [attempt.releaseMbid, attempt.albumGroupJobIds.length]),
    [[`${group}-cd`, 1], [`${group}-vinyl`, 1]]);
  let [first, second] = upgrades.queued;
  first = await stepUntil(first, (payload) => payload.phase === "poll");
  second = await processPipelinePayload(second);
  assert.equal(second.phase, "waiting");
  assert.equal(append.mock.callCount(), 1);

  await stepUntil(first, () => false);
  await stepUntil(second, () => false);
  assert.equal(append.mock.callCount(), 2);
  assert.deepEqual(upgrades.landed(),
    [["done", "01 - First.flac", "flac-standard"], ["done", "02 - Second.flac", "flac-standard"]]);
});

test("an upgrade stops waiting once the upgrade ahead of it gives up on the release and searches for its track", async (t) => {
  const upgrades = await releaseUpgrades(t, "upgrade-ahead-falls-back");
  for (const id of upgrades.sourceIds) assert.equal(await queueQualityUpgrade(downloadTracker.getJob(id)), "queued");
  let [first, second] = upgrades.queued;
  second = await processPipelinePayload(second);
  assert.equal(second.phase, "waiting");

  first = await stepUntil(first, (payload) => payload.albumGrab !== true);
  assert.deepEqual([first.albumGrab, downloadTracker.getJob(first.jobId).status], [false, "downloading"]);
  second = await processPipelinePayload(second);
  assert.deepEqual([second.phase, second.albumGrab], ["search", false]);
});

test("an upgrade waiting for the upgrade ahead of it on the same album stops waiting after 30 minutes and searches anyway", async (t) => {
  const upgrades = await releaseUpgrades(t, "upgrade-wait-ends");
  for (const id of upgrades.sourceIds) assert.equal(await queueQualityUpgrade(downloadTracker.getJob(id)), "queued");
  let second = upgrades.queued[1];
  let waitedSeconds = 0;
  let steps = 0;
  do {
    second = await processPipelinePayload(second);
    if (second?.phase === "waiting") waitedSeconds += second.delaySeconds;
    steps += 1;
  } while (second?.phase === "waiting" && steps < 100);
  assert.equal(waitedSeconds, 30 * 60);
  assert.notEqual(second?.phase, "waiting");
  assert.ok(upgrades.trackSearch.mock.callCount() > 0);
});

test("the upgrade check skips the tracks of a user who is not active, and the Library's upgrade of the same album reaches its search", async (t) => {
  const user = userOps.createUser("upgrade-check-disabled", "hash");
  userOps.updateUser(user.id, { status: "disabled" });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Disabled mix", ownerUserId: user.id });
  const upgrades = await releaseUpgrades(t, "upgrade-check-inactive-owner",
    { requestGroupIds: ["playlist-request", null], owners: [playlist.id, "library"] });

  assert.equal(await runQualityUpgradeCheck({ force: true }), 1);
  assert.deepEqual(upgrades.queued.map((attempt) => attempt.albumGroupJobIds
    .map((id) => downloadTracker.getJob(id).upgradeForJobId)), [[upgrades.sourceIds[1]]]);
  await processPipelinePayload(upgrades.queued[0]);
  assert.ok(upgrades.trackSearch.mock.callCount() > 0);
});

test("an upgrade of a user who is not active never leads a release attempt that the Library's upgrade of the album waits for", async (t) => {
  const user = userOps.createUser("upgrade-queue-disabled", "hash");
  userOps.updateUser(user.id, { status: "disabled" });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Disabled queue", ownerUserId: user.id });
  const upgrades = await releaseUpgrades(t, "upgrade-queue-inactive-owner",
    { requestGroupIds: ["playlist-request", null], owners: [playlist.id, "library"] });

  for (const id of upgrades.sourceIds) assert.equal(await queueQualityUpgrade(downloadTracker.getJob(id)), "queued");
  assert.deepEqual(upgrades.queued.map((attempt) => attempt.albumGrab === true), [false, true]);
  const library = await processPipelinePayload(upgrades.queued[1]);
  assert.notEqual(library?.phase, "waiting");
  assert.ok(upgrades.trackSearch.mock.callCount() > 0);
});

test("an upgrade whose user is disabled while the upgrade check runs is not held by the Library's release attempt", async (t) => {
  const user = userOps.createUser("upgrade-check-disabling", "hash");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Disabling mix", ownerUserId: user.id });
  const upgrades = await releaseUpgrades(t, "upgrade-owner-disabled-midway", {
    requestGroupIds: [null, "playlist-request"],
    owners: ["library", playlist.id],
    missing: () => {
      userOps.updateUser(user.id, { status: "disabled" });
      return false;
    },
  });

  assert.equal(await runQualityUpgradeCheck({ force: true }), 2);
  assert.deepEqual(upgrades.queued[0].albumGroupJobIds.map((id) => downloadTracker.getJob(id).upgradeForJobId),
    [upgrades.sourceIds[0]]);
});

test("Search all starts the upgrades of one release's tracks from different requests in the Library and a static playlist as one attempt and one Usenet download, and both land", async (t) => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Upgrade mix" });
  const upgrades = await releaseUpgrades(t, "upgrade-all-release",
    { requestGroupIds: [null, "playlist-request"], owners: ["library", playlist.id] });
  const { append } = mockNzbget(t, upgrades.folder);
  const app = express();
  app.use((req, _res, next) => {
    req.user = { role: "admin" };
    next();
  });
  const router = express.Router();
  registerJobs(router);
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/quality-upgrades`, { method: "POST" });
  assert.equal((await response.json()).queued, 2);
  assert.equal(upgrades.queued.length, 1);
  const [attempt] = upgrades.queued;
  assert.deepEqual(attempt.albumGroupJobIds.map((id) => downloadTracker.getJob(id).upgradeForJobId), upgrades.sourceIds);
  let payload = upgrades.download(attempt);
  while (payload) payload = await processPipelinePayload(payload);
  assert.equal(append.mock.callCount(), 1);
  assert.equal(upgrades.trackSearch.mock.callCount(), 0);
  assert.deepEqual(upgrades.landed(),
    [["done", "01 - First.flac", "flac-standard"], ["done", "02 - Second.flac", "flac-standard"]]);
  assert.equal(downloadTracker.getAll().some((job) => job.upgradeForJobId), false);
});

test("the upgrade check starts each album's upgrades before it adds the next album's, and removes the ones it could not start", async (t) => {
  for (const job of downloadTracker.getAll()) downloadTracker.removeJob(job.id);
  const groups = ["started-first", "started-second"];
  const seen = { queuedWhenSecondRead: null };
  const queued = [];
  await serveGroups(t, groups.map((group) => brainzmashGroup({ id: group, title: group, artist: "The Band",
    artistId: "the-band", releases: [{ id: `${group}-release`, tracks: [{ title: "Only", durationMs: 1000 }] }] })),
  { missing: (pathname) => {
    if (pathname === "/album/started-second") seen.queuedWhenSecondRead ??= queued.length;
    return false;
  } });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { metadata: settings.integrations?.metadata,
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9" } } });
  const sourceIds = [];
  for (const group of groups) {
    const original = join(resolveDownloadRoot(), "The Band", group, "01 - Only.mp3");
    await mkdir(dirname(original), { recursive: true });
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "1",
      "-c:a", "libmp3lame", "-b:a", "128k", original]);
    const id = downloadTracker.addJob({ artistName: "The Band", albumName: group, albumMbid: group,
      releaseMbid: `${group}-release`, trackName: "Only", trackNumber: 1, durationMs: 1000 }, "library");
    downloadTracker.setDone(id, original, group);
    downloadTracker.updateQuality(id, { tier: "mp3-128" });
    sourceIds.push(id);
  }
  t.mock.method(downloadTracker, "enqueuePipeline", (payload) => {
    if (payload.releaseMbid === "started-second-release") throw new Error("queue unavailable");
    queued.push(payload);
  });

  await assert.rejects(runQualityUpgradeCheck({ force: true }), /queue unavailable/);
  assert.equal(seen.queuedWhenSecondRead, 1);
  assert.deepEqual(queued.map((payload) => downloadTracker.getJob(payload.jobId).upgradeForJobId), [sourceIds[0]]);
  assert.deepEqual(downloadTracker.getAll().filter((job) => job.upgradeForJobId).map((job) => job.upgradeForJobId),
    [sourceIds[0]]);
});

test("an upgrade removed while its release details are read is not queued", async (t) => {
  for (const job of downloadTracker.getAll()) downloadTracker.removeJob(job.id);
  const removing = { upgrade: null };
  await serveGroups(t, [], { missing: () => {
    const upgrade = downloadTracker.getAll().find((job) => job.upgradeForJobId);
    if (upgrade) removing.upgrade = downloadTracker.removeJob(upgrade.id) && upgrade.id;
    return true;
  } });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { metadata: settings.integrations?.metadata,
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9" } } });
  const original = join(resolveDownloadRoot(), "The Band", "removed-upgrade", "01 - First.mp3");
  await mkdir(dirname(original), { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "1",
    "-c:a", "libmp3lame", "-b:a", "128k", original]);
  const id = downloadTracker.addJob({ artistName: "The Band", albumName: "removed-upgrade", albumMbid: "removed-upgrade",
    trackName: "First", trackNumber: 1, durationMs: 1000 }, "library");
  downloadTracker.setDone(id, original, "removed-upgrade");
  downloadTracker.updateQuality(id, { tier: "mp3-128" });
  const queued = t.mock.method(downloadTracker, "enqueuePipeline", () => {});

  assert.equal(await queueQualityUpgrade(downloadTracker.getJob(id)), "ineligible");
  assert.ok(removing.upgrade);
  assert.equal(queued.mock.callCount(), 0);
  assert.equal(downloadTracker.getJob(id).finalPath, original);
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

test("a Usenet download of a whole two-disc album takes the copy of a repeated title from the requested disc", async (t) => {
  const group = "usenet-two-disc";
  const tracklist = [[1, 1, "Bomb"], [1, 2, "Swim"], [2, 1, "Bomb"], [2, 2, "Little Things"]];
  await serveGroups(t, [brainzmashGroup({ id: group, title: "Disc Album", artist: "The Band", releases: [{
    id: `${group}-release`, tracks: tracklist.map(([disc, position, title]) => ({ title, disc, position, durationMs: 1000 })) }] })]);
  const folder = join(state.baseDir, group);
  for (const [disc, position, title] of tracklist) {
    await mkdir(join(folder, `CD${disc}`), { recursive: true });
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", `title=${title}`,
      "-metadata", "artist=The Band", "-metadata", `track=${position}`, "-metadata", `comment=CD${disc}`,
      join(folder, `CD${disc}`, `0${position} ${title}.flac`)]);
  }
  const jobId = downloadTracker.addJob({ artistName: "The Band", albumName: "Disc Album", albumMbid: group,
    releaseMbid: `${group}-release`, trackName: "Bomb", trackNumber: 1, discNumber: 2, durationMs: 1000 }, "library");
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  t.mock.method(client, "appendNzb", async () => ({ nzbId: "nzb-two-disc" }));
  t.mock.method(client, "getHistoryItem", async () => ({ Status: "SUCCESS", FinalDir: folder }));
  t.mock.method(client, "deleteHistoryItem", async () => true);
  const candidate = { raw: { release: { title: "The Band - Disc Album", guid: "release-two-disc",
    downloadUrl: "https://nzb.test/two-disc" } }, score: 10, resolvedAlbumName: "Disc Album" };
  let payload = { source: "usenet", phase: "download", jobId, playlistId: "library", playlistGeneration: 0,
    destination: "The Band/Disc Album", candidates: [candidate], candidateIndex: 0 };
  while (payload?.phase) payload = await processUsenetPipelinePayload(payload, failOnSourceFallback);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  const { common } = await parseFile(job.finalPath);
  assert.deepEqual(common.comment?.map((entry) => entry.text ?? entry), ["CD2"]);
});

test("a Usenet download of a pinned track is not imported when its only copy runs longer than the release lists", async (t) => {
  const group = "usenet-long-copy";
  await serveGroups(t, [brainzmashGroup({ id: group, title: "Long Album", artist: "The Band", releases: [{
    id: `${group}-release`, tracks: [{ title: "Alpha", durationMs: 1000 }, { title: "Beta", durationMs: 1000 }] }] })]);
  const folder = join(state.baseDir, group);
  await mkdir(folder, { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "7", "-c:a", "flac", "-metadata", "title=Beta",
    "-metadata", "artist=The Band", "-metadata", "album=Long Album", "-metadata", "track=2",
    join(folder, "02 Beta.flac")]);
  const jobId = downloadTracker.addJob({ artistName: "The Band", albumName: "Long Album", albumMbid: group,
    releaseMbid: `${group}-release`, trackName: "Beta", trackNumber: 2, durationMs: 1000 }, "library");
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async () => Buffer.from("<nzb></nzb>"));
  t.mock.method(client, "appendNzb", async () => ({ nzbId: "nzb-long-copy" }));
  t.mock.method(client, "getHistoryItem", async () => ({ Status: "SUCCESS", FinalDir: folder }));
  t.mock.method(client, "deleteHistoryItem", async () => true);
  t.mock.method(client, "deleteQueueItem", async () => true);
  const candidate = { raw: { release: { title: "The Band - Beta", guid: "release-long-copy",
    downloadUrl: "https://nzb.test/long-copy" } }, score: 10, resolvedAlbumName: "Long Album" };
  const reasons = [];
  let payload = { source: "usenet", phase: "download", jobId, playlistId: "library", playlistGeneration: 0,
    destination: "The Band/Long Album", candidates: [candidate], candidateIndex: 0 };
  while (payload?.phase) {
    payload = await processUsenetPipelinePayload(payload, { failOrTryNextSource: (_, __, reason) => reasons.push(reason) && null });
  }
  assert.notEqual(downloadTracker.getJob(jobId).status, "done");
  assert.equal(downloadTracker.getJob(jobId).finalPath, null);
  assert.equal(reasons.length, 1);
});

test("one Soulseek batch fills two sibling jobs", async (t) => {
  const album = await makeAlbum(t, "soulseek-grab");
  useSlskd();
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
      resolvedAlbumName: "Album", releaseVerified: true }] });
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
  const album = await makeAlbum(t, "soulseek-queued");
  useSlskd();
  const client = getDownloadClient("slskd");
  const transfers = album.files.map((filename, index) => ({ id: `queued-${index}`, username: "peer",
    filename, state: "Requested", bytesTransferred: 0 }));
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  const removed = t.mock.method(client, "deleteTransfer", async () => true);
  const remoteFiles = album.files.map((file, index) => ({ file, size: 0, jobId: album.ids[index] }));
  const polling = { ...album.payload, source: "slskd", phase: "poll", candidateIndex: 0,
    candidate: { raw: { user: "peer", files: remoteFiles }, releaseVerified: true }, albumTransfers: transfers };
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
  const album = await makeAlbum(t, "soulseek-unused");
  await rm(album.files[1]);
  const unused = join(album.folder, "02 Somebody Else.flac");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
    "-metadata", "title=Somebody Else", "-metadata", "artist=The Band", unused]);
  useSlskd();
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => state.baseDir);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const files = [album.files[0], unused];
  const remoteFiles = files.map((file, index) => ({ file, size: 0, jobId: album.ids[index] }));
  const transfers = files.map((filename, index) => ({ id: `transfer-${index}`, username: "peer",
    filename, state: "Completed, Succeeded" }));
  await processPipelinePayload({ ...album.payload, source: "slskd", phase: "finalize", candidateIndex: 0,
    candidates: [{ raw: { user: "peer", files: remoteFiles }, releaseVerified: true }],
    candidate: { raw: { user: "peer", files: remoteFiles }, releaseVerified: true }, albumTransfers: transfers });
  assert.equal(downloadTracker.getJob(album.ids[0]).status, "done");
  assert.equal(downloadTracker.getJob(album.ids[1]).status, "pending");
  assert.equal(await stat(unused).catch(() => null), null);
  assert.equal(await stat(album.folder).catch(() => null), null);
});

test("a Soulseek album queued before candidates said a listing proved their release is judged by the files it downloaded", async (t) => {
  useSlskd();
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => state.baseDir);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const legacyFinalize = async (album) => {
    for (const id of album.ids) downloadTracker.setAlbumGrabAttempted(id, true);
    const { releaseMbid: _releaseMbid, ...legacy } = album.payload;
    const files = (await readdir(album.folder)).map((name) => join(album.folder, name)).sort();
    const remoteFiles = files.map((file, index) => ({ file, size: 0, jobId: album.ids[index] }));
    const adopted = await processPipelinePayload({ ...legacy, source: "slskd", phase: "finalize", candidateIndex: 0,
      candidates: [{ raw: { user: "peer", files: remoteFiles } }], candidate: { raw: { user: "peer", files: remoteFiles } },
      albumTransfers: files.map((filename, index) => ({ id: `transfer-${index}`, username: "peer", filename,
        state: "Completed, Succeeded" })) });
    assert.deepEqual([adopted.phase, adopted.releaseMbid], ["finalize", album.payload.releaseMbid]);
    return processPipelinePayload(adopted);
  };

  const whole = await makeAlbum(t, "soulseek-legacy-whole");
  await legacyFinalize(whole);
  assert.deepEqual(whole.ids.map((id) => downloadTracker.getJob(id).status), ["done", "done"]);

  const short = await makeAlbum(t, "soulseek-legacy-short");
  await rm(short.files[1]);
  const fallback = await legacyFinalize(short);
  assert.deepEqual([fallback.albumGrab, fallback.jobId], [false, short.ids[0]]);
  assert.deepEqual(short.ids.map((id) => downloadTracker.getJob(id).status), ["pending", "pending"]);
});

test("a Usenet album needs every track of the pinned release, imports only the wanted ones, and tries the next release", async (t) => {
  const group = "usenet-next-release";
  const titles = Array.from({ length: 10 }, (_, index) => `Song ${index + 1}`);
  const wanted = ["Song 4", "Song 9"];
  const folders = { partial: join(state.baseDir, `${group}-partial`), complete: join(state.baseDir, `${group}-complete`) };
  await writeTracks(folders.partial, wanted, [4, 9]);
  await writeTracks(folders.complete, titles);
  const ids = addAlbumJobs(group, titles, wanted);
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
  } }, score: 10, resolvedAlbumName: "Album", releaseVerified: false }));
  const helpers = { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } };
  let payload = { source: "usenet", phase: "download", jobId: ids[0], playlistId: "library",
    downloadAttemptId: getActiveDownloadAttemptId(ids[0]),
    playlistGeneration: 0, destination: `The Band/${group}`, albumGrab: true,
    albumGroupJobIds: ids, releaseMbid: await serveRelease(t, group, titles), candidates, candidateIndex: 0 };
  while (payload) payload = await processUsenetPipelinePayload(payload, helpers);
  assert.equal(append.mock.callCount(), 2);
  for (const id of ids) {
    const job = downloadTracker.getJob(id);
    assert.equal(job.status, "done");
    assert.deepEqual(job.deniedRemoteSources.filter(([, guid]) => guid === "guid-partial"), [["usenet", "guid-partial"]]);
  }
  assert.deepEqual(ids.map((id) => basename(downloadTracker.getJob(id).finalPath)), ["04 - Song 4.flac", "09 - Song 9.flac"]);
  const library = join(downloadTracker.getJob(ids[0]).finalPath, "..");
  assert.deepEqual((await readdir(library)).filter((name) => name.includes("Song")).sort(),
    ["04 - Song 4.flac", "09 - Song 9.flac"]);
});

test("one playlist track outside any album request tries the next Usenet release after one short of its release", async (t) => {
  const group = "usenet-single-track";
  const titles = ["First", "Second", "Third"];
  const folders = { short: join(state.baseDir, `${group}-short`), whole: join(state.baseDir, `${group}-whole`) };
  await writeTracks(folders.short, titles.slice(0, 2));
  await writeTracks(folders.whole, titles);
  const [jobId] = addAlbumJobs(group, titles, ["Second"], { requestGroupId: null, playlist: "static" });
  const client = getDownloadClient("nzbget");
  t.mock.method(prowlarrClient, "downloadNzb", async (url) => Buffer.from(url));
  const append = t.mock.method(client, "appendNzb", async ({ content }) => ({ nzbId: content.toString() }));
  t.mock.method(client, "getHistoryItem", async (nzbId) => ({ Status: "SUCCESS",
    FinalDir: nzbId.endsWith("short") ? folders.short : folders.whole }));
  t.mock.method(client, "deleteQueueItem", async () => true);
  t.mock.method(client, "deleteHistoryItem", async () => true);
  const candidates = ["short", "whole"].map((name) => ({ raw: { release: {
    title: `The Band - Album ${name}`, guid: `guid-${name}`, downloadUrl: `https://nzb.test/${name}`,
  } }, score: 10, resolvedAlbumName: "Album", releaseVerified: false }));
  const helpers = { failOrTryNextSource: (_, __, reason) => { throw new Error(reason); } };
  let payload = { source: "usenet", phase: "download", jobId, playlistId: "static", playlistGeneration: 0,
    downloadAttemptId: getActiveDownloadAttemptId(jobId),
    destination: `The Band/${group}`, albumGrab: true, albumGroupJobIds: [jobId],
    releaseMbid: await serveRelease(t, group, titles), candidates, candidateIndex: 0 };
  while (payload) payload = await processUsenetPipelinePayload(payload, helpers);
  assert.equal(append.mock.callCount(), 2);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.match(basename(job.finalPath), /^02 - Second\b/);
  assert.deepEqual(job.deniedRemoteSources, [["usenet", "guid-short"]]);
});

test("a Soulseek album gives up on files left queued or crawling and keeps the ones that finished", async (t) => {
  const album = await makeAlbum(t, "soulseek-stalled");
  useSlskd();
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
    candidate: { raw: { user: "peer", files: remoteFiles }, releaseVerified: true }, albumTransfers: transfers };
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

test("a track that takes the lead of a Soulseek album after the leading track lands brings the file it holds for review", async (t) => {
  const album = await makeAlbum(t, "soulseek-new-lead");
  useSlskd();
  const client = getDownloadClient("slskd");
  const transfers = [
    { id: "done", username: "peer", filename: album.files[0], state: "Completed, Succeeded" },
    { id: "stuck", username: "peer", filename: album.files[1], state: "Queued, Remotely", placeInQueue: 9 },
  ];
  t.mock.method(client, "getTransfer", async (_, id) => transfers.find((item) => item.id === id));
  t.mock.method(client, "deleteTransfer", async () => true);
  t.mock.method(client, "getDownloadDirectory", async () => album.folder);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const remoteFiles = album.files.map((filePath, index) => ({ file: filePath, size: 0, jobId: album.ids[index] }));
  const folders = ["peer", "other"].map((user) => ({ raw: { user, files: remoteFiles }, releaseVerified: true }));
  const held = { source: "ytdlp", sourcePath: join(state.baseDir, "soulseek-new-lead-held.mp3"), reason: "Shorter",
    metadata: {} };
  assert.equal(downloadTracker.keepHeldForReview(album.ids[1], held), true);

  const polling = { ...album.payload, source: "slskd", phase: "poll", candidates: folders, candidateIndex: 0,
    candidate: folders[0], albumTransfers: transfers, tailSince: Date.now() - 11 * 60 * 1000 };
  const finalizing = await processPipelinePayload(polling);
  assert.equal(finalizing.phase, "finalize");
  const next = await processPipelinePayload(finalizing);
  assert.equal(downloadTracker.getJob(album.ids[0]).status, "done");
  assert.deepEqual([next.jobId, next.candidateIndex, next.heldForReview?.sourcePath], [album.ids[1], 1, held.sourcePath]);
});

test("a Soulseek album's next folder gets its own queue window", async (t) => {
  const album = await makeAlbum(t, "soulseek-next-folder");
  useSlskd();
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
    ({ file: filePath, size: 0, jobId: album.ids[index] })) }, releaseVerified: true });
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
