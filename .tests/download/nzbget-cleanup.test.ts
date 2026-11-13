import { isStepFrom, usenetCandidate } from "./fixtures.ts";
import { createTrackedJob, trackedJob } from "./fixtures.ts";
import {
  test,
  beforeEach,
  afterAll,
  vi,
  type TestContext,
  type MockInstance,
} from "vite-plus/test";
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
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { NzbgetClient },
  { removeNzbgetDownloadFolder },
  { getDownloadClient },
  { processSourcePipelinePayload, stagingDir },
  { usenetSource },
  { syncPathMappings },
  { approveBlockedJob, denyBlockedJob },
  { processPipelinePayload },
  { prowlarrClient },
  { downloadWorker },
] = await setupIsolatedBackend(
  "nzbget-cleanup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/nzbgetClient.ts"),
  () => import("../../backend/services/nzbgetCleanup.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/download/sourcePipeline.ts"),
  () => import("../../backend/services/usenetSource.ts"),
  () => import("../../backend/services/pathMappings.ts"),
  () => import("../../backend/services/downloadJobs/blockedJobReview.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/prowlarrClient.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
);
const exec = promisify(execFile);
let sequence = 0;
let root: string;

beforeEach(async () => {
  resetDatabase(db);
  syncPathMappings([]);
  root = path.join(state.baseDir, `completed-${++sequence}`);
  await fs.mkdir(path.join(root, "aurral", "release"), { recursive: true });
  await fs.rm(stagingDir(usenetSource, ""), { recursive: true, force: true });
});
afterAll(() => cleanupIsolatedState(state));

type SourcePayload = Parameters<typeof processSourcePipelinePayload>[0];

const throwOnFailure = {
  failOrTryNextSource: async (_payload: unknown, _job: unknown, reason: string): Promise<never> => {
    throw new Error(reason);
  },
};

const folder = () => path.join(root, "aurral", "release");
const remove = (
  historyItem: Parameters<typeof removeNzbgetDownloadFolder>[0] = { DestDir: folder() },
  directories: Parameters<typeof removeNzbgetDownloadFolder>[1] = { destDir: root },
) => removeNzbgetDownloadFolder(historyItem, directories, "aurral");
const exists = async (target: string | null) =>
  Boolean(target && (await fs.stat(target).catch(() => null)));

test("removes the download folder and keeps sibling downloads", async () => {
  const sibling = path.join(root, "aurral", "other");
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, "track.flac"), "other download");
  await fs.writeFile(path.join(folder(), "unwanted.flac"), "unused audio");
  await remove();
  assert.equal(await exists(folder()), false);
  assert.equal(await fs.readFile(path.join(sibling, "track.flac"), "utf8"), "other download");
});

test("a download that failed before it started leaves NZBGet's history", async () => {
  const client = new NzbgetClient({ completedPath: root });
  const rpc = vi.spyOn(client, "rpc").mockImplementation(async () => true);
  vi.spyOn(client, "listGroups").mockImplementation(async () => []);
  vi.spyOn(client, "history").mockImplementation(async () => []);
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    categoryDestDir: "",
    destDir: "",
    interDir: "",
    mainDir: "",
    completedPath: root,
  }));
  assert.equal(
    await client.deleteHistoryItem(7, {
      deleteFiles: true,
      historyItem: { NZBID: 7, Status: "FAILURE/FETCH", DestDir: "", FinalDir: "" },
    }),
    true,
  );
  assert.deepEqual(rpc.mock.calls[0], ["editqueue", ["HistoryFinalDelete", "", [7]]]);
  assert.equal(await exists(folder()), true);
});

test("refuses anything but a direct child of NZBGet's download folders", async () => {
  await fs.mkdir(path.join(folder(), "disc2"));
  for (const target of [
    root,
    path.join(root, "aurral"),
    path.join(folder(), "disc2"),
    state.baseDir,
  ]) {
    await assert.rejects(remove({ DestDir: target }), /not inside NZBGet/);
    assert.equal(await exists(target), true);
  }
});

test("a category with path components cannot widen the allowed folders", async () => {
  const outside = path.join(state.baseDir, `outside-${sequence}`, "release");
  await fs.mkdir(outside, { recursive: true });
  const escape = path.relative(root, path.dirname(outside));
  await assert.rejects(
    removeNzbgetDownloadFolder({ DestDir: outside }, { destDir: root }, escape),
    /not inside NZBGet/,
  );
  assert.equal(await exists(outside), true);
});

test("a nested category counts as one of NZBGet's download folders", async () => {
  await fs.mkdir(path.join(root, "music", "aurral", "release"), { recursive: true });
  await removeNzbgetDownloadFolder(
    { DestDir: path.join(root, "music", "aurral", "release") },
    { destDir: root },
    "music/aurral",
  );
  assert.equal(await exists(path.join(root, "music", "aurral", "release")), false);
  assert.equal(await exists(path.join(root, "music", "aurral")), true);
});

test("removes a failed download from the intermediate folder", async () => {
  const inter = path.join(state.baseDir, `inter-${sequence}`);
  await fs.mkdir(path.join(inter, "release.#42"), { recursive: true });
  await remove({ DestDir: path.join(inter, "release.#42") }, { destDir: root, interDir: inter });
  assert.equal(await exists(path.join(inter, "release.#42")), false);
  assert.equal(await exists(inter), true);
});

test("leaves a download that a post-processing script moved", async () => {
  for (const FinalDir of [path.join(root, "sorted"), "D:\\sorted\\release"]) {
    await assert.rejects(remove({ DestDir: folder(), FinalDir }), /post-processing script/);
    assert.equal(await exists(folder()), true);
  }
});

test("refuses symlinks", async () => {
  const outside = path.join(state.baseDir, `outside-${sequence}`);
  await fs.mkdir(path.join(outside, "release"), { recursive: true });
  await fs.symlink(outside, path.join(root, "aurral", "linked"));
  await assert.rejects(remove({ DestDir: path.join(root, "aurral", "linked") }), /not a directory/);
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(
    remove({ DestDir: path.join(root, "escape", "release") }),
    /not inside NZBGet/,
  );
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
  await assert.rejects(
    remove({ DestDir: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" }),
    /unmapped/,
  );
  syncPathMappings([{ source: "nzbget", remote: "D:\\completed", local: root }]);
  await remove({ DestDir: "D:\\completed\\aurral\\release" }, { destDir: "D:\\completed" });
  assert.equal(await exists(folder()), false);
});

test("a folder that is already gone is not an error", async () => {
  await fs.rm(folder(), { recursive: true });
  await remove();
});

test("the client keeps the history item when files cannot be removed", async () => {
  const client = new NzbgetClient({ completedPath: root });
  const rpc = vi.spyOn(client, "rpc").mockImplementation(async () => true);
  vi.spyOn(client, "listGroups").mockImplementation(async () => []);
  vi.spyOn(client, "history").mockImplementation(async () => []);
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    categoryDestDir: "",
    destDir: "",
    interDir: "",
    mainDir: "",
    completedPath: root,
  }));
  await assert.rejects(
    client.deleteHistoryItem(42, { deleteFiles: true, historyItem: { DestDir: root } }),
    /not inside NZBGet/,
  );
  assert.equal(rpc.mock.calls.length, 0);
});

test("the last of two downloads sharing a folder removes it, even when both finish at once", async () => {
  const client = new NzbgetClient({ url: "http://127.0.0.1:9", completedPath: root });
  const history = [42, 43].map((NZBID) => ({ NZBID, NZBName: "release", DestDir: folder() }));
  vi.spyOn(client, "listGroups").mockImplementation(async () => []);
  vi.spyOn(client, "history").mockImplementation(async () => [...history]);
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    categoryDestDir: "",
    destDir: "",
    interDir: "",
    mainDir: "",
    completedPath: root,
  }));
  vi.spyOn(client, "editItem").mockImplementation(async (_command, id) => {
    history.splice(
      history.findIndex((item) => item.NZBID === id),
      1,
    );
    return true;
  });
  await Promise.all(
    history.map((item) =>
      client.deleteHistoryItem(item.NZBID, { deleteFiles: true, historyItem: item }),
    ),
  );
  assert.equal(history.length, 0);
  assert.equal(await exists(folder()), false);
});

test("category-specific completed directories are read from NZBGet configuration", async () => {
  const client = new NzbgetClient({ category: "aurral" });
  vi.spyOn(client, "config").mockImplementation(async () => [
    { Name: "DestDir", Value: "/completed" },
    { Name: "Category1.Name", Value: "music" },
    { Name: "Category1.DestDir", Value: "/music-downloads" },
    { Name: "Category2.Name", Value: "Aurral" },
    { Name: "Category2.DestDir", Value: root },
  ]);
  assert.equal((await client.getDownloadDirectories()).categoryDestDir, root);
});

async function pipelineFixture(
  t: TestContext,
  {
    durationMs = 1000,
    queue = [],
    others = [],
  }: {
    durationMs?: number;
    queue?: Awaited<ReturnType<InstanceType<typeof NzbgetClient>["listGroups"]>>;
    others?: Awaited<ReturnType<InstanceType<typeof NzbgetClient>["history"]>>;
  } = {},
) {
  dbOps.updateSettings({
    integrations: {
      nzbget: {
        enabled: true,
        url: "http://127.0.0.1:9",
        completedPath: root,
        category: "aurral",
      },
    },
  });
  for (const title of ["Wanted", "Unwanted"]) {
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "flac",
      "-metadata",
      `title=${title}`,
      "-metadata",
      "artist=The Band",
      "-metadata",
      "album=Album",
      path.join(folder(), `${title}.flac`),
    ]);
  }
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "The Band", albumName: "Album", trackName: "Wanted", durationMs },
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadSource: "usenet",
    downloadClient: "usenet",
    downloadClientId: "nzbget:42",
  });
  const history = {
    NZBID: 42,
    NZBName: "The Band - Album FLAC",
    Status: "SUCCESS/ALL",
    DestDir: folder(),
    Category: "aurral",
  };
  const client = getDownloadClient("nzbget");
  vi.spyOn(client, "history").mockImplementation(async () => [history, ...others]);
  vi.spyOn(client, "listGroups").mockImplementation(async () => queue);
  vi.spyOn(client, "getDownloadDirectories").mockImplementation(async () => ({
    categoryDestDir: "",
    destDir: "",
    interDir: "",
    mainDir: "",
    completedPath: root,
  }));
  const deleted = vi.spyOn(client, "editItem").mockImplementation(async () => true);
  const candidate = usenetCandidate({
    guid: "release",
    title: "The Band - Album FLAC",
    album: "Album",
  });
  const payload: SourcePayload = {
    jobId,
    source: "usenet",
    phase: "poll",
    pendingId: "nzbget:42",
    destination: `The Band/import-${sequence}`,
    candidates: [candidate],
    candidateIndex: 0,
  };
  return { jobId, deleted, history, candidate, payload };
}

type SourceHelpers = Parameters<typeof processSourcePipelinePayload>[2];

const run = (payload: SourcePayload, helpers: SourceHelpers = throwOnFailure) =>
  processSourcePipelinePayload(payload, usenetSource, helpers);

async function finish(payload: SourcePayload, helpers: SourceHelpers = throwOnFailure) {
  const next = await run(payload, helpers);
  return isStepFrom(next, "usenet") && next.phase === "finalize" ? run(next, helpers) : next;
}

const keptByAurral = async () => fs.readdir(stagingDir(usenetSource, "")).catch((): string[] => []);

const historyDeletes = (deleted: MockInstance<InstanceType<typeof NzbgetClient>["editItem"]>) =>
  deleted.mock.calls.filter((call) => call[0] === "HistoryFinalDelete").length;

test("NZBGet lets go of a finished download once Aurral has its files, and the import keeps only the requested song", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  await finish(payload);
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  assert.equal(await exists(job.finalPath), true);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
  assert.deepEqual(await keptByAurral(), []);
});

test("an import that fails keeps the files Aurral was handed, and its retry imports them", async (t) => {
  const { jobId, payload } = await pipelineFixture(t);
  const obstructed = path.join(state.baseDir, "blocked-destination");
  await fs.mkdir(obstructed, { recursive: true });
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: obstructed });
  await fs.writeFile(path.join(obstructed, "The Band"), "a file cannot contain a track");
  const finalize = await run(payload);
  assert.ok(isStepFrom(finalize, "usenet"));
  await assert.rejects(run(finalize), /E(NOTDIR|EXIST)/);
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "done");
  await fs.rm(path.join(obstructed, "The Band"));
  assert.equal(await run(finalize), null);
  assert.equal(trackedJob(downloadTracker, jobId).status, "done");
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: null });
});

for (const [decision, review] of [
  ["approved", approveBlockedJob],
  ["denied", denyBlockedJob],
] as const) {
  test(`a song held for review keeps its file until it is ${decision}`, async (t: import("vite-plus/test").TestContext) => {
    t.onTestFinished(async () => {
      await downloadWorker.stopAndDrain();
    });
    const { jobId, payload } = await pipelineFixture(t, { durationMs: 15000 });
    vi.spyOn(prowlarrClient, "isConfigured").mockImplementation(() => true);
    for (const id of ["slskd", "deemix", "ytdlp", "sabnzbd"] as const)
      vi.spyOn(getDownloadClient(id), "isConfigured").mockImplementation(() => false);
    const finalize = await processPipelinePayload(payload);
    assert.ok(isStepFrom(finalize, "usenet"));
    await processPipelinePayload(finalize);
    const held = trackedJob(downloadTracker, jobId);
    assert.equal(held.status, "blocked");
    assert.equal(await exists(held.stagingPath), true);
    assert.equal((await review(jobId)).status, 200);
    assert.equal(await exists(held.stagingPath), false);
    assert.deepEqual(await keptByAurral(), []);
  });
}

for (const [sharer, fixture] of [
  [
    "a finished download",
    () => ({
      others: [
        {
          NZBID: 43,
          NZBName: "The Band - Album FLAC (2)",
          Status: "SUCCESS/ALL",
          DestDir: folder(),
        },
      ],
    }),
  ],
  ["a queued download", () => ({ queue: [{ NZBID: 43, NZBName: "The Band - Album FLAC" }] })],
] as const) {
  test(`an import leaves a folder that ${sharer} of the same name shares`, async (t) => {
    const { jobId, payload, deleted } = await pipelineFixture(t, fixture());
    await finish(payload);
    assert.equal(trackedJob(downloadTracker, jobId).status, "done");
    assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
    assert.equal(historyDeletes(deleted), 1);
  });
}

test("an album grab removes the download after importing its songs", async (t) => {
  const { jobId, payload } = await pipelineFixture(t);
  const group = `album-${sequence}`;
  downloadTracker.removeJob(jobId);
  const ids = ["Wanted", "Unwanted"].map((trackName, index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "The Band",
        albumName: "Album",
        albumMbid: group,
        requestGroupId: group,
        trackName,
        trackNumber: index + 1,
        durationMs: 1000,
        albumTrackCount: 2,
        albumTrackTitles: ["Wanted", "Unwanted"],
      },
      "library",
    ),
  );
  for (const id of ids) downloadTracker.setDownloading(id);
  await fs.writeFile(path.join(folder(), "cover.jpg"), "unrequested sidecar");
  await serveGroups(t, [
    brainzmashGroup({
      id: group,
      title: "Album",
      artist: "The Band",
      releases: [
        {
          id: `${group}-release`,
          tracks: ["Wanted", "Unwanted"].map((title) => ({ title, durationMs: 1000 })),
        },
      ],
    }),
  ]);
  await finish({
    ...payload,
    jobId: requireFixture(ids[0]),
    albumGrab: true,
    albumGroupJobIds: ids,
    releaseMbid: `${group}-release`,
  });
  for (const id of ids) {
    const job = trackedJob(downloadTracker, id);
    assert.equal(job.status, "done");
    assert.equal(await exists(job.finalPath), true);
  }
  assert.equal(await exists(folder()), false);
  assert.deepEqual(await keptByAurral(), []);
});

test("a download whose request is cancelled while it is checked is removed", async (t) => {
  const { jobId, payload, history } = await pipelineFixture(t);
  const { cancelDownloadJob } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  vi.spyOn(getDownloadClient("nzbget"), "getHistoryItem").mockImplementation(async () => {
    cancelDownloadJob(jobId);
    return history;
  });
  assert.equal(await run(payload), null);
  assert.equal(await exists(folder()), false);
  assert.deepEqual(await keptByAurral(), []);
});

test("cancelling a song removes its finished download", async (t) => {
  const { jobId, deleted } = await pipelineFixture(t);
  const { cancelPlaylistDownloadWork } =
    await import("../../backend/services/downloadJobs/downloadCancellationService.ts");
  await cancelPlaylistDownloadWork("library", [trackedJob(downloadTracker, jobId)]);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});

for (const [state, settle] of [
  ["finished another way", (jobId: string) => downloadTracker.setDone(jobId, "/elsewhere.flac")],
  ["failed", (jobId: string) => downloadTracker.setFailed(jobId, "Timed out")],
] as const) {
  test(`a download whose song ${state} is removed when it is next checked`, async (t) => {
    const { jobId, payload, deleted } = await pipelineFixture(t);
    settle(jobId);
    assert.equal(await run(payload), null);
    assert.equal(await exists(folder()), false);
    assert.equal(historyDeletes(deleted), 1);
  });
}

const failAttempt = (jobId: string | null) => ({
  failOrTryNextSource: async (_payload: unknown, job: { id: string }, reason: string) => {
    assert.equal(job.id, jobId);
    downloadTracker.setFailed(job.id, reason);
    return null;
  },
});

test("a failed download is removed before Aurral tries the next release", async (t) => {
  const { jobId, payload, deleted, history, candidate } = await pipelineFixture(t);
  history.Status = "FAILURE/PAR";
  const next = await run({ ...payload, candidates: [candidate, candidate] });
  assert.ok(isStepFrom(next, "usenet"));
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
  assert.equal(trackedJob(downloadTracker, jobId).status, "downloading");
});

test("a download keeps polling while NZBGet cannot be read, stops waiting after a long outage, and the next download waits as long again and goes on once NZBGet answers", async (t) => {
  const { payload, deleted, history } = await pipelineFixture(t);
  const client = getDownloadClient("nzbget");
  let down = true;
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => {
    if (down) throw new Error("connect ECONNREFUSED");
    return history;
  });
  const poll = async (current: SourcePayload) => {
    const next = await run(current);
    assert.ok(isStepFrom(next, "usenet"));
    return next;
  };
  let polling = payload;
  let error: Error | undefined;
  for (let attempt = 0; attempt < 1000 && !error; attempt += 1) {
    polling = await poll(polling).catch((caught: Error) => {
      error = caught;
      return polling;
    });
    if (attempt < 100) assert.equal(polling.phase, "poll");
  }
  assert.match(error?.message || "", /ECONNREFUSED/);
  assert.equal(deleted.mock.calls.length, 0);

  vi.spyOn(prowlarrClient, "downloadNzb").mockImplementation(async () => Buffer.from("<nzb/>"));
  vi.spyOn(client, "appendNzb").mockImplementation(async () => ({ nzbId: 43, nzbName: "release" }));
  const next = await poll({
    ...polling,
    phase: "download",
    candidateIndex: 0,
    candidates: [usenetCandidate({ guid: "next", title: "The Band - Album FLAC", album: "Album" })],
  });
  assert.equal(next.pendingId, "nzbget:43");
  const waiting = await poll(next);
  assert.equal(waiting.phase, "poll");
  assert.equal(waiting.unreadPolls, 1);
  down = false;
  assert.equal((await poll(waiting)).phase, "finalize");
});

test("a rejected download is removed", async (t) => {
  const { jobId, payload } = await pipelineFixture(t);
  dbOps.updateSettings({ ...dbOps.getSettings(), qualityProfile: { enabled: ["mp3-320"] } });
  await finish(payload, failAttempt(jobId));
  assert.equal(trackedJob(downloadTracker, jobId).status, "failed");
  assert.equal(await exists(folder()), false);
  assert.deepEqual(await keptByAurral(), []);
});
