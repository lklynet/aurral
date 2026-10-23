import { usenetCandidate } from "./fixtures.ts";
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

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { NzbgetClient },
  { removeNzbgetDownloadFolder },
  { getDownloadClient },
  { processUsenetPipelinePayload },
  { syncPathMappings },
  { approveBlockedJob, denyBlockedJob },
  { processPipelinePayload, failPipelineJob },
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
  () => import("../../backend/services/usenetOrchestrator.ts"),
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
});
afterAll(() => cleanupIsolatedState(state));

type UsenetPayload = Parameters<typeof processUsenetPipelinePayload>[0];

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

test("the client keeps the history item when files cannot be removed, and honors the opt-out", async () => {
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
  client.updateConfig({ completedPath: root, deleteLeftovers: false });
  assert.equal(
    await client.deleteHistoryItem(42, { deleteFiles: true, historyItem: { DestDir: folder() } }),
    true,
  );
  assert.equal(await exists(folder()), true);
  assert.deepEqual(rpc.mock.calls[0], ["editqueue", ["HistoryFinalDelete", "", [42]]]);
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
    deleteLeftovers = true,
    durationMs = 1000,
    queue = [],
    others = [],
  }: {
    deleteLeftovers?: boolean;
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
        deleteLeftovers,
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
    downloadClient: "nzbget",
    downloadClientId: 42,
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
  return {
    jobId,
    deleted,
    payload: {
      jobId,
      source: "usenet",
      phase: "finalize",
      downloadClient: "nzbget",
      nzbId: 42,
      history,
      destination: `The Band/import-${sequence}`,
      candidate: usenetCandidate({
        raw: { release: { title: "The Band - Album FLAC", guid: "release" } },
        resolvedAlbumName: "Album",
      }),
    },
  };
}

const finishThroughPipeline = (
  t: TestContext,
  payload: Awaited<ReturnType<typeof pipelineFixture>>["payload"],
) => {
  vi.spyOn(prowlarrClient, "isConfigured").mockImplementation(() => true);
  for (const id of ["slskd", "deemix", "ytdlp", "sabnzbd"] as const) {
    vi.spyOn(getDownloadClient(id), "isConfigured").mockImplementation(() => false);
  }
  return processPipelinePayload(payload);
};

const historyDeletes = (deleted: MockInstance<InstanceType<typeof NzbgetClient>["editItem"]>) =>
  deleted.mock.calls.filter((call) => call[0] === "HistoryFinalDelete").length;

test("a single-track import keeps the requested song and removes the rest of the album", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  await processUsenetPipelinePayload(payload, throwOnFailure);
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
  assert.equal(job.status, "done");
  assert.equal(await exists(job.finalPath), true);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});

test("turning off Delete leftover files keeps the rest of the album", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t, { deleteLeftovers: false });
  await processUsenetPipelinePayload(payload, throwOnFailure);
  assert.equal(trackedJob(downloadTracker, jobId).status, "done");
  assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
  assert.equal(historyDeletes(deleted), 1);
});

test("a failed import keeps the download and its history", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const obstructed = path.join(state.baseDir, "blocked-destination");
  await fs.mkdir(obstructed, { recursive: true });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    downloadFolderPath: obstructed,
    integrations: {
      ...settings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 2 },
    },
  });
  vi.spyOn(prowlarrClient, "isConfigured").mockImplementation(() => true);
  await fs.writeFile(path.join(obstructed, "The Band"), "a file cannot contain a track");
  const failure = await processUsenetPipelinePayload(payload, throwOnFailure).then(
    () => null,
    (error) => error,
  );
  assert.match(failure?.message || "", /E(NOTDIR|EXIST)/);
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "done");
  assert.equal(await failPipelineJob(payload, failure.message), null);
  assert.equal(trackedJob(downloadTracker, jobId).status, "failed");
  assert.equal(await exists(path.join(folder(), "Wanted.flac")), true);
  assert.equal(deleted.mock.calls.length, 0);
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: null });
});

for (const [decision, review] of [
  ["approved", approveBlockedJob],
  ["denied", denyBlockedJob],
] as const) {
  test(`a song held for review keeps its download until it is ${decision}`, async (t: import("vite-plus/test").TestContext) => {
    t.onTestFinished(async () => {
      await downloadWorker.stopAndDrain();
    });
    const { jobId, payload, deleted } = await pipelineFixture(t, { durationMs: 15000 });
    await finishThroughPipeline(t, payload);
    assert.equal(trackedJob(downloadTracker, jobId).status, "blocked");
    assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
    assert.equal(deleted.mock.calls.length, 0);
    assert.equal((await review(jobId)).status, 200);
    assert.equal(await exists(folder()), false);
    assert.equal(historyDeletes(deleted), 1);
  });
}

test("removing a song held for review removes its download", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t, { durationMs: 15000 });
  const removed = new Promise<void>((resolve) => {
    deleted.mockImplementation(async (command) => {
      if (command === "HistoryFinalDelete") resolve();
      return true;
    });
  });
  await finishThroughPipeline(t, payload);
  assert.equal(trackedJob(downloadTracker, jobId).status, "blocked");
  downloadTracker.removeJob(jobId);
  await removed;
  assert.equal(await exists(folder()), false);
});

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
    await processUsenetPipelinePayload(payload, throwOnFailure);
    assert.equal(trackedJob(downloadTracker, jobId).status, "done");
    assert.equal(await exists(path.join(folder(), "Unwanted.flac")), true);
    assert.equal(historyDeletes(deleted), 1);
  });
}

test("an album grab removes the download after importing its songs", async (t) => {
  const { jobId, payload } = await pipelineFixture(t);
  const group = `album-${sequence}`;
  // Recreate the leader with album ownership so both requests share one NZB.
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
  await processUsenetPipelinePayload(
    {
      ...payload,
      jobId: ids[0],
      albumGrab: true,
      albumGroupJobIds: ids,
      releaseMbid: `${group}-release`,
    },
    throwOnFailure,
  );
  for (const id of ids) {
    const job = downloadTracker.getJob(id);
    assert.ok(job != null);
    assert.equal(job.status, "done");
    assert.equal(await exists(job.finalPath), true);
  }
  assert.equal(await exists(folder()), false);
});

test("a download whose request is cancelled while it is checked is removed", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const { cancelDownloadJob } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  vi.spyOn(getDownloadClient("nzbget"), "getHistoryItem").mockImplementation(async () => {
    cancelDownloadJob(jobId);
    return payload.history;
  });
  assert.equal(
    await processUsenetPipelinePayload({ ...payload, history: null }, throwOnFailure),
    null,
  );
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});

const failAttempt = (jobId: string | null) => ({
  failOrTryNextSource: async (_payload: unknown, job: { id: string }, reason: string) => {
    assert.equal(job.id, jobId);
    downloadTracker.setFailed(job.id, reason);
    return null;
  },
});

test("a failed download is removed before Aurral tries the next release", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  payload.history.Status = "FAILURE/PAR";
  const next = await processUsenetPipelinePayload(
    {
      ...payload,
      phase: "poll",
      candidateIndex: 0,
      candidates: [payload.candidate, payload.candidate],
    },
    throwOnFailure,
  );
  assert.ok(next != null);
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
  assert.equal(trackedJob(downloadTracker, jobId).status, "downloading");
});

test("a download keeps polling while NZBGet cannot be read, goes on once it can, stops waiting after a long outage, and the next download waits as long again", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  const client = getDownloadClient("nzbget");
  let down = true;
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => {
    if (down) throw new Error("connect ECONNREFUSED");
    return payload.history;
  });
  const poll = async (current: UsenetPayload) => {
    const next = await processUsenetPipelinePayload(current, throwOnFailure);
    assert.ok(next != null);
    return next as UsenetPayload;
  };
  let polling: UsenetPayload = { ...payload, phase: "poll", history: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    polling = await poll(polling);
    assert.equal(polling.phase, "poll");
  }
  assert.equal(deleted.mock.calls.length, 0);
  assert.equal(trackedJob(downloadTracker, jobId).status, "downloading");
  down = false;
  assert.equal((await processUsenetPipelinePayload(polling, throwOnFailure))!.phase, "finalize");

  down = true;
  let error: Error | undefined;
  for (let attempt = 0; attempt < 1000 && !error; attempt += 1) {
    polling = await poll(polling).catch((caught) => {
      error = caught;
      return polling;
    });
  }
  assert.match(error?.message || "", /ECONNREFUSED/);
  assert.equal(deleted.mock.calls.length, 0);

  vi.spyOn(prowlarrClient, "downloadNzb").mockImplementation(async () => Buffer.from("<nzb/>"));
  vi.spyOn(client, "appendNzb").mockImplementation(async () => ({ nzbId: 43, nzbName: "release" }));
  const next = await processUsenetPipelinePayload(
    {
      ...polling,
      phase: "download",
      candidateIndex: 0,
      candidates: [
        usenetCandidate({
          raw: {
            release: {
              ...payload.candidate.raw.release,
              guid: "next",
              downloadUrl: "http://indexer/next",
            },
          },
        }),
      ],
    },
    throwOnFailure,
  );
  assert.ok(next != null);
  assert.equal(next.nzbId, 43);
  assert.equal((await poll(next as UsenetPayload)).phase, "poll");
});

test("a rejected download is removed", async (t) => {
  const { jobId, payload, deleted } = await pipelineFixture(t);
  dbOps.updateSettings({ ...dbOps.getSettings(), qualityProfile: { enabled: ["mp3-320"] } });
  await processUsenetPipelinePayload(payload, failAttempt(jobId));
  assert.equal(trackedJob(downloadTracker, jobId).status, "failed");
  assert.equal(await exists(folder()), false);
  assert.equal(historyDeletes(deleted), 1);
});
