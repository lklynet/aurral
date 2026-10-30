type SlskdPayload = Parameters<
  typeof import("../../backend/services/slskdOrchestrator.ts").processSlskdPipelinePayload
>[0];
type DeemixPayload = Parameters<
  typeof import("../../backend/services/deemixOrchestrator.ts").processDeemixPipelinePayload
>[0];
type PipelinePayload = CorePipelinePayload &
  Omit<Partial<SlskdPayload & DeemixPayload>, keyof CorePipelinePayload>;
import { localDownloadWorker } from "./fixtures.ts";
import type { PipelinePayload as CorePipelinePayload } from "../../backend/services/downloadPipeline.ts";
import type { StoredIntegrations } from "../../backend/db/helpers/settings.ts";
import type { TestContext } from "vite-plus/test";
import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
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
  { downloadTracker, NO_RELEASE_REASON, OFF_RELEASE_REASON },
  { getDownloadClient },
  {
    processPipelinePayload: processStep,
    buildNextSourcePayload,
    enqueuePendingJobsWithoutBatch,
    failPipelineJob,
  },
  { prowlarrClient },
  { downloadWorker: workerInstance, DownloadWorker },
  { getPipelineQueue, listHonkerJobs },
  { clearReleaseManifests },
  { logger },
  { cancelDownloadWorkForJobs },
  { clearApiCaches },
  libraryStore,
  { beginDownloadAttempt, setActiveDownloadAttemptId },
  { processPlaylistOperation },
  { stopDownloadPipelineWorker },
  { denyBlockedJob },
] = await setupIsolatedBackend(
  "release-first-sources",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/prowlarrClient.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/releaseResolver.ts"),
  () => import("../../backend/services/logger.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellationService.ts"),
  () => import("../../backend/services/apiClients/clearCache.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/downloadPipelineWorker.ts"),
  () => import("../../backend/services/downloadJobs/blockedJobReview.ts"),
);
const downloadWorker = localDownloadWorker(workerInstance);

async function processPipelinePayload(
  payload: PipelinePayload | null,
): Promise<PipelinePayload | null> {
  assert.ok(payload, "Expected a pipeline step to continue");
  return processStep(payload);
}

function enqueuePipelineStep(
  payload: PipelinePayload | null,
  options: Parameters<ReturnType<typeof getPipelineQueue>["enqueue"]>[1] = {},
) {
  assert.ok(payload, "Expected a pipeline step to enqueue");
  return getPipelineQueue().enqueue(JSON.parse(JSON.stringify(payload)), options);
}

function soulseekReleaseCandidates(payload: PipelinePayload) {
  assert.equal(payload.source, "slskd");
  assert.ok(payload.candidates);
  return payload.candidates as {
    releaseVerified: boolean;
    raw: {
      user: string;
      files: NonNullable<
        ReturnType<
          typeof import("../../backend/services/albumReleaseSearch.ts").selectSoulseekAlbumFolder
        >["selected"]
      >["files"];
    };
  }[];
}

function deemixCandidates(payload: PipelinePayload) {
  assert.equal(payload.source, "deemix");
  assert.ok(payload.candidates);
  return payload.candidates as NonNullable<DeemixPayload["candidates"]>;
}

// Metadata's retries and rate limit run on fake time that moves to each
// next timer. The rate limit remembers that time between tests, so the
// clock never goes back.
let now = Date.now();
afterAll(() => cleanupIsolatedState(state));
afterEach(() => {
  now = Date.now();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now });
  vi.setTimerTickMode("nextTimerAsync");
  resetDatabase(db);
  // A released track wakes the worker, and a queued step would start the
  // pipeline worker; these tests drive both themselves.
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  vi.spyOn(downloadTracker, "enqueuePipeline").mockImplementation((payload) =>
    enqueuePipelineStep(JSON.parse(JSON.stringify(payload)), {}),
  );
});

const slskd = getDownloadClient("slskd");
const deemix = getDownloadClient("deemix");
const ytdlp = getDownloadClient("ytdlp");

function useSources(integrations: StoredIntegrations) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: { metadata: settings.integrations?.metadata, ...integrations },
  });
}

function album(
  name: string,
  artist: string,
  releases: { id: string; tracks: (string | { title: string; durationMs: number })[] }[],
) {
  return brainzmashGroup({ id: `${name}-group`, title: `${name} Album`, artist, releases });
}

// Tracks of one Library request, each pinned to the release the Library asks for.
function libraryJobs(
  group: ReturnType<typeof brainzmashGroup>,
  titles: string[],
  {
    releaseMbid = group.releases[0].id,
    requestGroupId = group.id,
    requestKind,
    ...extra
  }: Partial<Parameters<typeof downloadTracker.addJob>[0]> & {
    requestKind?: "track" | "album";
  } = {},
) {
  const release = group.releases.find((entry) => entry.id === releaseMbid) || group.releases[0];
  return titles.map((trackName) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: group.artists[0].artistname,
        albumName: group.title,
        albumMbid: group.id,
        releaseMbid,
        requestGroupId,
        trackName,
        trackNumber:
          release.tracks.find((track) => track.trackname === trackName)?.trackposition || null,
        durationMs: 200000,
        ...extra,
      },
      "library",
      { requestKind },
    ),
  );
}

// An attempt holding these tracks, as the tracker holds them when it queues one.
function albumAttempt(ids: string[], extra: Partial<PipelinePayload> = {}): PipelinePayload {
  const downloadAttemptId = beginDownloadAttempt(ids[0]);
  for (const id of ids) {
    setActiveDownloadAttemptId(id, downloadAttemptId);
    downloadTracker.setAlbumGrabAttempted(id, true);
  }
  for (const id of ids.slice(1)) downloadTracker.setDownloading(id);
  return {
    phase: "search",
    downloadAttemptId,
    jobId: ids[0],
    albumGrab: true,
    albumGroupJobIds: ids,
    releaseMbid: trackedJob(downloadTracker, ids[0]).releaseMbid,
    ...extra,
  };
}

function queued(jobId: string) {
  const payload = listHonkerJobs("slskd-pipeline").find(
    (entry) => entry.payload?.jobId === jobId,
  )?.payload;
  if (payload == null) return undefined;
  assert.equal(typeof payload.jobId, "string");
  assert.equal(typeof payload.phase, "string");
  return payload as PipelinePayload;
}
function requireQueued(jobId: string) {
  const payload = queued(jobId);
  assert.ok(payload, `Expected a queued pipeline step for ${jobId}`);
  return payload;
}
const queuedFor = (ids: string[]) =>
  listHonkerJobs("slskd-pipeline").filter(
    (entry) => typeof entry.payload?.jobId === "string" && ids.includes(entry.payload.jobId),
  );

// The step the worker queued for a track, taken off the queue as the
// pipeline worker takes it.
function claimQueued(jobId: string) {
  const row = listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.jobId === jobId);
  assert.ok(row != null);
  const payload = queued(jobId);
  getPipelineQueue().cancel(row.id);
  assert.ok(payload);
  return payload;
}

function soulseekFolder(username: string, directory: string, files: [string, number?][]) {
  return {
    username,
    hasFreeUploadSlot: true,
    uploadSpeed: 500000,
    files: files.map(([name, length = 200]) => ({
      filename: `Music\\${directory}\\${name}.flac`,
      size: 30000000,
      length,
    })),
  };
}

function soulseekFolders(artist: string, albumName: string, titles: string[]) {
  return ["one", "two", "three"].map((username) =>
    soulseekFolder(
      username,
      `${artist}\\${albumName}`,
      titles.map((title, index) => [`0${index + 1} - ${title}`]),
    ),
  );
}

function mockSoulseekSearch(t: TestContext, responses: ReturnType<typeof soulseekFolder>[]) {
  let searches = 0;
  const created = vi.spyOn(slskd, "createSearch").mockImplementation(async (query, options) => {
    const id = `release-first-${++searches}`;
    options?.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  vi.spyOn(slskd, "getSearch").mockImplementation(async () => ({
    state: "Completed, Succeeded",
    fileCount: responses.reduce((count, response) => count + response.files.length, 0),
    responses,
  }));
  vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(slskd, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  return created;
}

test("every album source is searched by release in priority order before any track search, and yt-dlp only searches tracks", async (t) => {
  useSources({
    ytdlp: { enabled: true, priority: 1 },
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 10 },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "disposable" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9", priority: 20 },
  });
  vi.spyOn(ytdlp, "isConfigured").mockImplementation(() => true);
  const ytdlpSearch = vi.spyOn(ytdlp, "search").mockImplementation(async () => []);
  const group = album("priority", "Priority Band", [
    { id: "priority-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group]);
  // Every folder holds the whole release plus a bonus song, so none is the requested release.
  mockSoulseekSearch(
    t,
    soulseekFolders("Priority Band", "priority Album", ["First", "Second", "Third", "Bonus"]),
  );
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => []);
  const usenetSearch = vi.spyOn(prowlarrClient, "search").mockImplementation(async () => []);
  const [jobId] = libraryJobs(group, ["Second"]);

  let payload: PipelinePayload | null = albumAttempt([jobId]);
  const sources: (string | null | undefined)[] = [];
  for (let step = 0; step < 60 && payload?.albumGrab === true; step += 1) {
    payload = await processPipelinePayload(payload);
    if (payload?.albumGrab === true && sources.at(-1) !== payload.source)
      sources.push(payload.source);
  }

  assert.deepEqual(sources, ["slskd", "usenet"]);
  assert.ok(usenetSearch.mock.calls.length > 0);
  assert.ok(usenetSearch.mock.calls.every((call) => !String(call[0]).includes("Second")));
  assert.equal(ytdlpSearch.mock.calls.length, 0);
  assert.ok(payload != null);
  assert.equal(payload.albumGrab, false);
  assert.equal(buildNextSourcePayload<CorePipelinePayload>(payload)?.source, "ytdlp");
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "failed");
});

// yt-dlp ranked above Soulseek, with every search logged in order and
// whether a release attempt made it.
function useQuickSources() {
  useSources({
    ytdlp: { enabled: true, priority: 1 },
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 10 },
  });
  vi.spyOn(ytdlp, "isConfigured").mockImplementation(() => true);
  const searches: string[] = [];
  const log = { albumStep: false };
  const ytdlpSearch = vi.spyOn(ytdlp, "search").mockImplementation(async () => {
    searches.push("yt-dlp");
    return [];
  });
  vi.spyOn(slskd, "createSearch").mockImplementation(async (query, options) => {
    searches.push(log.albumStep ? "soulseek album" : "soulseek track");
    const id = `quick-${searches.length}`;
    options?.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  vi.spyOn(slskd, "getSearch").mockImplementation(async () => ({
    state: "Completed, Succeeded",
    fileCount: 0,
    responses: [],
  }));
  vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(slskd, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  return Object.assign(log, {
    ytdlpSearch,
    searched: () => searches.filter((entry, index) => entry !== searches[index - 1]),
    clear: () => {
      searches.length = 0;
    },
  });
}

async function runToEnd(payload: PipelinePayload | null, sources: { albumStep?: boolean } = {}) {
  for (let step = 0; step < 60 && payload; step += 1) {
    sources.albumStep = payload.albumGrab === true;
    payload = await processPipelinePayload(payload);
  }
  return payload;
}

const storedRequest = (jobId: string) =>
  db
    .prepare<[string], { request_kind: string; quick_searched_sources: string; status: string }>(
      "SELECT request_kind, quick_searched_sources, status FROM playlist_download_jobs WHERE id = ?",
    )
    .get(jobId)!;

test("a track request searches yt-dlp ranked first before its release, and never again after; a whole-album request starts on its release", async (t) => {
  const sources = useQuickSources();
  const group = album("quick", "Quick Band", [
    { id: "quick-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group]);

  const [track] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const quick = queued(track);
  assert.ok(quick != null);
  assert.deepEqual([quick.albumGrab, quick.allowedSources], [undefined, ["ytdlp"]]);
  assert.deepEqual(storedRequest(track), {
    request_kind: "track",
    quick_searched_sources: "[]",
    status: "downloading",
  });
  await runToEnd(claimQueued(track), sources);
  assert.deepEqual(sources.searched(), ["yt-dlp", "soulseek album", "soulseek track"]);
  assert.deepEqual(storedRequest(track), {
    request_kind: "track",
    quick_searched_sources: '["ytdlp"]',
    status: "failed",
  });

  sources.clear();
  const wholeGroup = album("whole", "Whole Band", [
    { id: "whole-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group, wholeGroup]);
  const [whole] = libraryJobs(wholeGroup, ["Second"], { requestKind: "album" });
  await downloadWorker.processJob(trackedJob(downloadTracker, whole));
  assert.deepEqual(requireQueued(whole).albumGroupJobIds, [whole]);
  await runToEnd(claimQueued(whole), sources);
  assert.deepEqual(sources.searched(), ["soulseek album", "yt-dlp", "soulseek track"]);
  assert.deepEqual(storedRequest(whole), {
    request_kind: "album",
    quick_searched_sources: "[]",
    status: "failed",
  });
});

test("a track request starts on its release as before when an album source ranks above yt-dlp", async (t) => {
  const sources = useQuickSources();
  useSources({
    ytdlp: { enabled: true, priority: 20 },
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 10 },
  });
  const group = album("album-first", "First Band", [
    { id: "album-first-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const [track] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  await runToEnd(claimQueued(track), sources);
  assert.deepEqual(sources.searched(), ["soulseek album", "soulseek track", "yt-dlp"]);
  assert.equal(storedRequest(track).quick_searched_sources, "[]");
});

test("a track request asked for again after its search ended searches yt-dlp first again", async (t) => {
  const sources = useQuickSources();
  const group = album("again", "Again Band", [
    { id: "again-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group]);
  const [failed, imported] = libraryJobs(group, ["Second", "Third"], { requestGroupId: null });
  await downloadWorker.processJob(trackedJob(downloadTracker, failed));
  await runToEnd(claimQueued(failed), sources);
  assert.equal(trackedJob(downloadTracker, failed).status, "failed");

  sources.clear();
  await processPlaylistOperation({
    kind: "shared-playlist-research-track",
    playlistId: "library",
    jobId: failed,
  });
  await downloadWorker.processJob(trackedJob(downloadTracker, failed));
  await runToEnd(claimQueued(failed), sources);
  assert.equal(sources.searched()[0], "yt-dlp");

  await downloadWorker.processJob(trackedJob(downloadTracker, imported));
  claimQueued(imported);
  downloadTracker.setDone(imported, path.join(state.baseDir, "Third.m4a"));
  downloadTracker.setPending(imported, "Track file is missing");
  await downloadWorker.processJob(trackedJob(downloadTracker, imported));
  assert.deepEqual(
    [requireQueued(imported).quickSearch, requireQueued(imported).allowedSources],
    [true, ["ytdlp"]],
  );
});

test("a quick search cut off by a restart searches yt-dlp again", async (t) => {
  useQuickSources();
  const group = album("restart", "Restart Band", [
    { id: "restart-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const [track] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  assert.equal(claimQueued(track).quickSearch, true);

  downloadTracker.resetDownloadingToPending();
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  assert.deepEqual(
    [
      requireQueued(track).quickSearch,
      requireQueued(track).albumGrab,
      requireQueued(track).allowedSources,
    ],
    [true, undefined, ["ytdlp"]],
  );
});

test("yt-dlp stays searched once for a track request after the user ranks it below Soulseek mid-search", async (t) => {
  const sources = useQuickSources();
  const group = album("reranked", "Reranked Band", [
    { id: "reranked-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const [track] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const attempt = await processPipelinePayload(claimQueued(track));
  assert.ok(attempt != null);
  assert.equal(attempt.albumGrab, true);

  useSources({
    metadata: dbOps.getSettings().integrations.metadata,
    ytdlp: { enabled: true, priority: 20 },
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 10 },
  });
  await runToEnd(attempt, sources);
  assert.deepEqual(sources.searched(), ["yt-dlp", "soulseek album", "soulseek track"]);
  assert.equal(trackedJob(downloadTracker, track).status, "failed");
});

test("while metadata cannot be read, a track request of a known album starts its quick search, and a track whose album is not known yet waits", async (t) => {
  useQuickSources();
  const group = album("unread", "Unread Band", [
    { id: "unread-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group], { unavailable: () => true, searchable: true });
  clearApiCaches();
  clearReleaseManifests();
  const [track] = libraryJobs(group, ["Second"], { trackMbid: "unread-release-recording-2" });
  const named = createTrackedJob(
    downloadTracker,
    { artistName: "Unread Band", trackName: "Third", albumName: "unread Album" },
    "library",
  );
  for (const id of [track, named]) await downloadWorker.processJob(trackedJob(downloadTracker, id));
  assert.deepEqual([queued(track)?.quickSearch, queued(track)?.allowedSources], [true, ["ytdlp"]]);
  assert.equal(trackedJob(downloadTracker, track).status, "downloading");
  assert.equal(queued(named), undefined);
  assert.equal(trackedJob(downloadTracker, named).status, "pending");
});

// The quick search's step after yt-dlp downloaded a song of the given
// length for a 15-second track, as its download step records it.
async function quickSearchDownloaded(
  t: TestContext,
  name: string,
  artist: string,
  seconds: number,
  { unavailable }: NonNullable<Parameters<typeof serveGroups>[2]> = {},
) {
  const sources = useQuickSources();
  const group = album(name, artist, [
    { id: `${name}-release`, tracks: ["First", { title: "Second", durationMs: 15000 }, "Third"] },
  ]);
  await serveGroups(t, [group], { unavailable });
  const [track] = libraryJobs(group, ["Second"], { durationMs: 15000 });
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const staged = path.join(
    process.env.DOWNLOAD_FOLDER!,
    ".ytdlp-staging",
    track,
    `${artist} - Second.mp3`,
  );
  await mkdir(path.dirname(staged), { recursive: true });
  const written = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc",
    "-t",
    String(seconds),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-metadata",
    "title=Second",
    "-metadata",
    `artist=${artist}`,
    staged,
  ]);
  assert.equal(written.status, 0);
  downloadTracker.updateDownloadMetadata(track, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
    releaseGuid: `${name}-video`,
  });
  const step = {
    ...claimQueued(track),
    source: "ytdlp",
    phase: "finalize",
    downloadedPath: staged,
    candidates: [
      { raw: { id: `${name}-video`, title: "Second" }, resolvedAlbumName: "Second (Single)" },
    ],
    candidateIndex: 0,
  };
  assert.equal(step.quickSearch, true);
  return { sources, track, step };
}

test("a song the quick search imports ends the job before any release search", async (t) => {
  const { sources, track, step } = await quickSearchDownloaded(t, "imported", "Import Band", 15);
  assert.equal(await runToEnd(step, sources), null);
  assert.deepEqual(sources.searched(), []);
  const job = downloadTracker.getJob(track);
  assert.ok(job != null);
  assert.deepEqual(
    [job.status, job.downloadSource, job.albumName],
    ["done", "ytdlp", "imported Album"],
  );
  assert.ok(job.finalPath);
  assert.match(path.basename(job.finalPath), /Second\.mp3$/);
  await access(job.finalPath);
});

test("a file the quick search holds waits with it while the release cannot be read, then goes to review when the release attempt verifies nothing", async (t) => {
  let down = false;
  const { sources, track, step } = await quickSearchDownloaded(t, "held-wait", "Wait Band", 1, {
    unavailable: () => down,
  });
  down = true;
  clearApiCaches();
  clearReleaseManifests();

  let waiting = await processPipelinePayload(step);
  assert.ok(waiting != null);
  waiting = await processPipelinePayload(waiting);
  assert.ok(waiting);
  assert.ok(waiting.delaySeconds != null);
  assert.deepEqual(
    [waiting.quickSearch, waiting.releaseWaits, waiting.delaySeconds > 0],
    [true, 2, true],
  );
  assert.equal(trackedJob(downloadTracker, track).status, "downloading");
  assert.ok(waiting != null);
  assert.ok(waiting.heldForReview != null);
  assert.ok(waiting.heldForReview.sourcePath);
  await access(waiting.heldForReview.sourcePath);

  down = false;
  clearApiCaches();
  sources.albumStep = true;
  const attempt = await processPipelinePayload(waiting);
  assert.ok(attempt != null);
  assert.deepEqual([attempt.albumGrab, attempt.albumGroupJobIds], [true, [track]]);
  await runToEnd(attempt, sources);
  assert.deepEqual(sources.searched(), ["soulseek album", "soulseek track"]);
  assert.equal(sources.ytdlpSearch.mock.calls.length, 0);
  const job = downloadTracker.getJob(track);
  assert.ok(job != null);
  assert.deepEqual([job.status, job.downloadSource], ["blocked", "ytdlp"]);
  assert.ok(job.error);
  assert.match(job.error, /shorter than the requested track/);
  assert.ok(waiting != null);
  assert.ok(waiting.heldForReview != null);
  assert.equal(job.stagingPath, waiting.heldForReview.sourcePath);
  assert.ok(job.stagingPath);
  assert.equal(path.basename(job.stagingPath), `${track}-held.mp3`);
  await access(job.stagingPath);
});

test("a track waiting for its release after its quick search does not hold back another track's quick search", async (t) => {
  for (const job of downloadTracker.getAll()) downloadTracker.removeJob(job.id);
  for (const entry of listHonkerJobs("slskd-pipeline")) getPipelineQueue().cancel(entry.id);
  useQuickSources();
  const group = album("slot", "Slot Band", [{ id: "slot-release", tracks: ["First", "Second"] }]);
  let down = false;
  await serveGroups(t, [group], { unavailable: () => down });
  const [waitingId, nextId] = libraryJobs(group, ["First", "Second"], { requestGroupId: null });
  await downloadWorker.processJob(trackedJob(downloadTracker, waitingId));
  down = true;
  clearApiCaches();
  clearReleaseManifests();
  const waiting = await processPipelinePayload(claimQueued(waitingId));
  assert.ok(waiting != null);
  assert.deepEqual([waiting.quickSearch, waiting.releaseWaits], [true, 1]);
  enqueuePipelineStep(waiting, {});

  const worker = new DownloadWorker(state.baseDir);
  worker.updateWorkerSettings({ concurrency: 1 });
  const dispatched = vi.spyOn(worker, "processJob").mockImplementation(async () => {});
  vi.spyOn(worker, "scheduleReuseLinkRepair").mockImplementation(() => {});
  await worker.start();
  try {
    assert.deepEqual(
      dispatched.mock.calls.map((call) => call[0].id),
      [nextId],
    );
  } finally {
    worker.stop();
    await stopDownloadPipelineWorker();
  }
});

test("a track request whose release cannot be read through every wait after its quick search searches for the track", async (t) => {
  const sources = useQuickSources();
  const group = album("long-unread", "Unread Band", [
    { id: "long-unread-release", tracks: ["First", "Second"] },
  ]);
  let down = false;
  await serveGroups(t, [group], { unavailable: () => down });
  const [track] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  down = true;
  clearApiCaches();
  clearReleaseManifests();

  let payload: PipelinePayload | null = claimQueued(track);
  assert.ok(payload != null);
  let steps = 0;
  for (; payload?.quickSearch === true && steps < 100; steps += 1)
    payload = await processPipelinePayload(payload);
  assert.ok(steps > 2 && steps < 100, `${steps} steps`);
  assert.ok(payload != null);
  assert.deepEqual(
    [payload.albumGrab, payload.source, payload.triedSources],
    [undefined, "slskd", ["ytdlp"]],
  );
  assert.equal(trackedJob(downloadTracker, track).error, NO_RELEASE_REASON);
  await runToEnd(payload, sources);
  assert.deepEqual(sources.searched(), ["yt-dlp", "soulseek track"]);
});

const storedHold = (jobId: string) =>
  JSON.parse(
    db
      .prepare<[string], { held_for_review: string }>(
        "SELECT held_for_review FROM playlist_download_jobs WHERE id = ?",
      )
      .get(jobId)!.held_for_review,
  )?.sourcePath;

test("a file the quick search holds stays with its track when its release attempt fails, goes into the next attempt, and goes to review only after the track search finds nothing", async (t) => {
  const { sources, track, step } = await quickSearchDownloaded(
    t,
    "held-given-back",
    "Given Band",
    1,
  );
  const attempt = await processPipelinePayload(step);
  assert.ok(attempt != null);
  assert.deepEqual([attempt.albumGrab, attempt.albumGroupJobIds], [true, [track]]);
  assert.ok(attempt.heldForReview != null);
  const held = attempt.heldForReview.sourcePath;
  assert.ok(held != null);

  assert.equal(
    await failPipelineJob({ ...attempt, source: "slskd" }, "Request failed with status code 500"),
    null,
  );
  const waiting = downloadTracker.getJob(track);
  assert.ok(waiting != null);
  assert.deepEqual([waiting.status, waiting.retryCycle], ["pending", true]);
  await access(held);
  assert.equal(storedHold(track), held);

  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const next = claimQueued(track);
  assert.ok(next != null);
  assert.deepEqual([next.albumGrab, next.heldForReview?.sourcePath], [true, held]);
  await runToEnd(next, sources);
  assert.deepEqual(sources.searched(), ["soulseek album", "soulseek track"]);
  const job = downloadTracker.getJob(track);
  assert.ok(job != null);
  assert.deepEqual(
    [job.status, job.stagingPath, job.downloadSource, storedHold(track)],
    ["blocked", held, "ytdlp", undefined],
  );
  assert.ok(job.error);
  assert.match(job.error, /shorter than the requested track/);
  await access(held);

  // A denial asks for the track again, release attempt included.
  assert.equal((await denyBlockedJob(track)).status, 200);
  sources.clear();
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const again = await processPipelinePayload(claimQueued(track));
  assert.ok(again != null);
  assert.deepEqual(sources.searched(), ["yt-dlp"]);
  assert.deepEqual([again.albumGrab, again.albumGroupJobIds], [true, [track]]);
});

test("a file the quick search holds stays with its track when its release attempt is dropped because the release cannot be read", async (t) => {
  let down = false;
  const { sources, track, step } = await quickSearchDownloaded(
    t,
    "held-dropped",
    "Dropped Band",
    1,
    { unavailable: () => down },
  );
  const attempt = await processPipelinePayload(step);
  assert.ok(attempt != null);
  assert.equal(attempt.albumGrab, true);
  down = true;
  clearApiCaches();
  clearReleaseManifests();

  assert.equal(await processPipelinePayload(attempt), null);
  assert.equal(trackedJob(downloadTracker, track).status, "pending");
  assert.ok(attempt.heldForReview != null);
  assert.ok(attempt.heldForReview.sourcePath);
  await access(attempt.heldForReview.sourcePath);
  assert.ok(attempt.heldForReview != null);
  assert.equal(storedHold(track), attempt.heldForReview.sourcePath);
  assert.deepEqual(sources.searched(), []);
});

test("a file the quick search holds survives a restart while it waits for the release, and the track's next attempt carries it", async (t) => {
  let down = false;
  const { sources, track, step } = await quickSearchDownloaded(
    t,
    "held-restart",
    "Restart Band",
    1,
    { unavailable: () => down },
  );
  down = true;
  clearApiCaches();
  clearReleaseManifests();
  const waiting = await processPipelinePayload(step);
  assert.ok(waiting != null);
  assert.deepEqual([waiting.phase, waiting.releaseWaits], ["release", 1]);
  assert.ok(waiting.heldForReview != null);
  const held = waiting.heldForReview.sourcePath;
  assert.ok(held != null);

  assert.ok(downloadTracker.resetDownloadingToPending() >= 1);
  assert.equal(trackedJob(downloadTracker, track).status, "pending");
  down = false;
  clearApiCaches();
  clearReleaseManifests();
  await downloadWorker.processJob(trackedJob(downloadTracker, track));
  const next = claimQueued(track);
  assert.ok(next != null);
  assert.deepEqual([next.albumGrab, next.heldForReview?.sourcePath], [true, held]);
  assert.equal(await processPipelinePayload(waiting), null);
  await access(held);
  assert.equal(storedHold(track), held);

  await runToEnd(next, sources);
  const job = downloadTracker.getJob(track);
  assert.ok(job != null);
  assert.deepEqual([job.status, job.stagingPath], ["blocked", held]);
  await access(held);
});

test("one wanted track of an exact Soulseek release downloads only that track's file", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("single", "Single Band", [
    { id: "single-soulseek", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group]);
  mockSoulseekSearch(
    t,
    soulseekFolders("Single Band", "single Album", ["First", "Second", "Third"]),
  );
  const enqueue = vi
    .spyOn(slskd, "enqueueBatch")
    .mockImplementation(async ({ files, username }) => ({
      username,
      transferId: null,
      response: null,
      transfers: files.map((_, index) => ({ id: `transfer-${index}` })),
    }));
  const [jobId] = libraryJobs(group, ["Second"]);

  let payload: PipelinePayload | null = albumAttempt([jobId], { source: "slskd" });
  while (payload?.phase === "search") payload = await processPipelinePayload(payload);

  assert.ok(payload != null);
  assert.ok(payload.candidates != null);
  assert.equal(payload.phase, "download");
  assert.ok(payload != null);
  assert.ok(payload.candidates != null);
  assert.ok(payload.candidates.length > 0);
  for (const candidate of soulseekReleaseCandidates(payload)) {
    assert.equal(candidate.releaseVerified, true);
    assert.deepEqual(
      candidate.raw.files.map((file) => [file.jobId, file.file!.split("\\").at(-1)]),
      [[jobId, "02 - Second.flac"]],
    );
  }
  const polling = await processPipelinePayload(payload);
  assert.ok(polling != null);
  assert.equal(polling.phase, "poll");
  assert.deepEqual(polling.candidate, soulseekReleaseCandidates(payload)[0]);
  assert.equal(enqueue.mock.calls.length, 1);
  assert.deepEqual(
    enqueue.mock.calls[0][0].files.map((file) => file.filename!.split("\\").at(-1)),
    ["02 - Second.flac"],
  );
});

function mockDeemix(t: TestContext, tracks: string[]) {
  vi.spyOn(deemix, "searchAlbums").mockImplementation(async () => [
    {
      id: "42",
      title: "deezer Album",
      artist: "Deezer Band",
      url: "https://www.deezer.com/album/42",
    },
  ]);
  vi.spyOn(deemix, "getAlbumTracks").mockImplementation(async () =>
    tracks.map((title, index) => ({
      id: `track-${index + 1}`,
      title,
      artist: "Deezer Band",
      durationSec: 200,
      trackNumber: index + 1,
      discNumber: 1,
      url: `https://www.deezer.com/track/${index + 1}`,
      readable: true,
      album: "deezer Album",
      albumId: "7",
      albumUrl: "https://www.deezer.com/album/7",
    })),
  );
  vi.spyOn(deemix, "getQueueItem").mockImplementation(async (uuid) => ({
    status: "completed",
    type: "track",
    files: [{ path: `/deemix/${uuid}.flac` }],
  }));
  return {
    track: vi.spyOn(deemix, "addToQueue").mockImplementation(async (_url, id) => `${id}_9`),
    album: vi
      .spyOn(deemix, "addAlbumToQueue")
      .mockImplementation(async (_url, id) => `album_${id}_9`),
  };
}

test("an exact deemix release queues each wanted track by its own URL, and the album URL only when every track is wanted", async (t) => {
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const titles = ["First", "Second", "Third"];
  const queued = mockDeemix(t, titles);
  const group = album("deezer", "Deezer Band", [{ id: "deemix-release", tracks: titles }]);
  await serveGroups(t, [group]);
  const ids = libraryJobs(group, ["First", "Third"]);

  const searched = await processPipelinePayload(albumAttempt(ids, { source: "deemix" }));
  assert.ok(searched != null);
  assert.ok(searched.candidates != null);
  assert.deepEqual(
    deemixCandidates(searched).map((candidate) => [
      candidate.kind,
      candidate.releaseVerified,
      candidate.raw.tracks!.map((track) => [track.jobId, track.url]),
    ]),
    [
      [
        "tracks",
        true,
        [
          [ids[0], "https://www.deezer.com/track/1"],
          [ids[1], "https://www.deezer.com/track/3"],
        ],
      ],
    ],
  );
  const polling = await processPipelinePayload(searched);
  assert.ok(polling != null);
  assert.deepEqual(
    queued.track.mock.calls.map((call) => call),
    [
      ["https://www.deezer.com/track/1", "track-1"],
      ["https://www.deezer.com/track/3", "track-3"],
    ],
  );
  assert.equal(queued.album.mock.calls.length, 0);
  const finalizing = await processPipelinePayload(polling);
  assert.ok(finalizing != null);
  assert.equal(finalizing.phase, "finalize");
  assert.equal(finalizing.albumGrab, true);
  assert.deepEqual(finalizing.downloadedPaths, [
    "/deemix/track-1_9.flac",
    "/deemix/track-3_9.flac",
  ]);

  resetDatabase(db);
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const whole = libraryJobs(group, titles);
  const searchedWhole = await processPipelinePayload(albumAttempt(whole, { source: "deemix" }));
  assert.ok(searchedWhole != null);
  assert.ok(searchedWhole.candidates != null);
  assert.deepEqual(
    deemixCandidates(searchedWhole).map((candidate) => candidate.kind),
    ["album"],
  );
  await processPipelinePayload(searchedWhole);
  assert.deepEqual(
    queued.album.mock.calls.map((call) => call),
    [["https://www.deezer.com/album/42", "42"]],
  );
  assert.equal(queued.track.mock.calls.length, 2);
});

test("every deemix track an attempt queued is removed on cancel, and its track search after a fallback removes only its own", async (t) => {
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const titles = ["First", "Second", "Third"];
  mockDeemix(t, titles);
  const removed = vi.spyOn(deemix, "removeFromQueue").mockImplementation(async () => true);
  const removedIds = () => removed.mock.calls.map((call) => call[0]).sort();
  const group = album("deezer", "Deezer Band", [{ id: "deemix-cancelled", tracks: titles }]);
  await serveGroups(t, [group]);

  const cancelled = libraryJobs(group, ["First", "Third"]);
  assert.ok(cancelled.every((value) => value != null));
  enqueuePipelineStep(
    await processPipelinePayload(
      await processPipelinePayload(albumAttempt(cancelled, { source: "deemix" })),
    ),
    {},
  );
  await cancelDownloadWorkForJobs(cancelled.map((id) => trackedJob(downloadTracker, id)));
  assert.deepEqual(removedIds(), ["track-1_9", "track-3_9"]);

  resetDatabase(db);
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  removed.mockClear();
  const ids = libraryJobs(group, ["First", "Third"]);
  const finalizing = await processPipelinePayload(
    await processPipelinePayload(
      await processPipelinePayload(albumAttempt(ids, { source: "deemix" })),
    ),
  );
  assert.ok(finalizing != null);
  const fallback = await processPipelinePayload(finalizing);
  assert.ok(fallback != null);
  assert.equal(fallback.albumGrab, false);
  assert.equal(trackedJob(downloadTracker, ids[1]).status, "pending");
  vi.spyOn(deemix, "search").mockImplementation(async () => [
    {
      id: "track-1",
      title: "First",
      artist: "Deezer Band",
      album: "deezer Album",
      albumId: "7",
      albumUrl: "https://www.deezer.com/album/7",
      durationSec: 200,
      url: "https://www.deezer.com/track/1",
      readable: true,
    },
  ]);
  const polling = await processPipelinePayload(await processPipelinePayload(fallback));
  assert.ok(polling != null);
  assert.equal(polling.phase, "poll");
  removed.mockClear();
  await processPipelinePayload({ ...polling, pollAttempts: 200 });
  assert.deepEqual(removedIds(), ["track-1_9"]);
});

test("a later deemix release queues only the tracks its attempt still wants, by their own URLs", async (t) => {
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const titles = ["First", "Second", "Third"];
  const queued = mockDeemix(t, titles);
  vi.spyOn(deemix, "searchAlbums").mockImplementation(async () =>
    ["42", "43"].map((id) => ({
      id,
      title: "deezer Album",
      artist: "Deezer Band",
      url: `https://www.deezer.com/album/${id}`,
    })),
  );
  vi.spyOn(deemix, "removeFromQueue").mockImplementation(async () => true);
  const group = album("deezer", "Deezer Band", [{ id: "deemix-later", tracks: titles }]);
  await serveGroups(t, [group]);
  const ids = libraryJobs(group, titles);
  assert.ok(ids.every((value) => value != null));

  const searched = await processPipelinePayload(albumAttempt(ids, { source: "deemix" }));
  assert.ok(searched != null);
  assert.ok(searched.candidates != null);
  assert.deepEqual(
    deemixCandidates(searched).map((candidate) => [candidate.kind, candidate.raw.albumId]),
    [
      ["album", "42"],
      ["album", "43"],
    ],
  );
  const next = await processPipelinePayload(await processPipelinePayload(searched));
  assert.ok(next != null);
  assert.equal(next.phase, "download");
  downloadTracker.setDone(ids[2], "/library/Deezer Band/03 Third.flac");
  const polling = await processPipelinePayload(next);
  assert.ok(polling != null);
  assert.deepEqual(
    queued.album.mock.calls.map((call) => call),
    [["https://www.deezer.com/album/42", "42"]],
  );
  assert.deepEqual(
    queued.track.mock.calls.map((call) => call),
    [
      ["https://www.deezer.com/track/1", "track-1"],
      ["https://www.deezer.com/track/2", "track-2"],
    ],
  );
  const finalizing = await processPipelinePayload(polling);
  assert.ok(finalizing != null);
  assert.deepEqual(finalizing.downloadedPaths, [
    "/deemix/track-1_9.flac",
    "/deemix/track-2_9.flac",
  ]);
});

test("a finished album download waits while its release cannot be read, and goes on without the wait's delay once it can", async (t) => {
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const titles = ["First", "Second", "Third"];
  mockDeemix(t, titles);
  const removed = vi.spyOn(deemix, "removeFromQueue").mockImplementation(async () => true);
  const group = album("deezer", "Deezer Band", [{ id: "deemix-blink", tracks: titles }]);
  let down = false;
  await serveGroups(t, [group], { unavailable: () => down });
  const ids = libraryJobs(group, ["First", "Third"]);
  const finalizing = await processPipelinePayload(
    await processPipelinePayload(
      await processPipelinePayload(albumAttempt(ids, { source: "deemix" })),
    ),
  );
  assert.ok(finalizing != null);
  down = true;
  clearApiCaches();
  const waiting = await processPipelinePayload(finalizing);
  assert.ok(waiting != null);
  assert.ok(waiting.delaySeconds != null);
  assert.deepEqual(
    [waiting.phase, waiting.albumGrab, waiting.delaySeconds > 0],
    ["finalize", true, true],
  );
  assert.equal(removed.mock.calls.length, 0);
  assert.equal(trackedJob(downloadTracker, ids[1]).status, "downloading");

  down = false;
  clearApiCaches();
  const fallback = await processPipelinePayload(waiting);
  assert.ok(fallback != null);
  assert.deepEqual([fallback.albumGrab, fallback.delaySeconds || 0], [false, 0]);
  assert.deepEqual(removed.mock.calls.map((call) => call[0]).sort(), ["track-1_9", "track-3_9"]);
});

test("a finished album download takes the release a merge left in its place, and a later outage waits as long again before it goes on without one", async (t) => {
  useSources({ deemix: { enabled: true, url: "http://127.0.0.1:9", bitrate: 9 } });
  const titles = ["First", "Second", "Third"];
  mockDeemix(t, titles);
  const removed = vi.spyOn(deemix, "removeFromQueue").mockImplementation(async () => true);
  const group = album("deezer", "Deezer Band", [{ id: "deemix-waits", tracks: titles }]);
  let unknown = false;
  await serveGroups(t, [group], { missing: () => unknown });
  const ids = libraryJobs(group, ["First", "Third"]);
  let step = await processPipelinePayload(
    await processPipelinePayload(
      await processPipelinePayload(albumAttempt(ids, { source: "deemix" })),
    ),
  );
  assert.ok(step != null);
  unknown = true;
  clearApiCaches();
  for (let index = 0; index < 25; index += 1) step = await processPipelinePayload(step);
  assert.ok(step);
  assert.deepEqual([step.phase, step.albumGrab], ["finalize", true]);

  unknown = false;
  group.releases[0].id = "deemix-waits-merged";
  clearApiCaches();
  step = await processPipelinePayload(step);
  assert.ok(step != null);
  assert.deepEqual(
    [step.phase, step.releaseMbid, step.delaySeconds],
    ["finalize", "deemix-waits-merged", 0],
  );
  assert.deepEqual(
    ids.map((id) => trackedJob(downloadTracker, id).releaseMbid),
    ["deemix-waits-merged", "deemix-waits-merged"],
  );
  assert.equal(removed.mock.calls.length, 0);

  unknown = true;
  clearApiCaches();
  let waits = 0;
  for (; step?.albumGrab === true && waits < 100; waits += 1)
    step = await processPipelinePayload(step);
  assert.ok(step != null);
  assert.ok(waits > 30 && waits < 100, `${waits} steps`);
  assert.equal(step.albumGrab, false);
  assert.equal(trackedJob(downloadTracker, ids[1]).error, NO_RELEASE_REASON);
  assert.equal(removed.mock.calls.length, 2);
});

test("an album attempt whose release cannot be read when it searches gives every track back untried, and they wait to search by release until it can", async (t) => {
  for (const job of downloadTracker.getAll()) downloadTracker.removeJob(job.id);
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("outage", "Outage Band", [
    { id: "outage-release", tracks: ["First", "Second", "Third"] },
  ]);
  let down = false;
  await serveGroups(t, [group], { unavailable: () => down });
  const created = mockSoulseekSearch(t, []);
  const ids = libraryJobs(group, ["First", "Second", "Third"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
  const attempt = claimQueued(ids[0]);
  assert.ok(attempt != null);
  assert.deepEqual(attempt.albumGroupJobIds, ids);

  down = true;
  clearApiCaches();
  assert.equal(await processPipelinePayload(attempt), null);
  assert.equal(created.mock.calls.length, 0);
  for (const id of ids) {
    assert.deepEqual(
      [trackedJob(downloadTracker, id).status, trackedJob(downloadTracker, id).albumGrabAttempted],
      ["pending", false],
    );
  }
  for (const id of ids) await downloadWorker.processJob(trackedJob(downloadTracker, id));
  assert.deepEqual(queuedFor(ids), []);
  for (const id of ids) {
    assert.deepEqual(
      [trackedJob(downloadTracker, id).status, trackedJob(downloadTracker, id).albumGrabAttempted],
      ["pending", false],
    );
    assert.notEqual(trackedJob(downloadTracker, id).error, NO_RELEASE_REASON);
  }
  assert.equal(downloadWorker._getNextReadyPendingJob(), null);
  vi.setSystemTime(Date.now() + 61 * 1000);
  assert.ok(ids.some((id) => id === downloadWorker._getNextReadyPendingJob()?.id));
  vi.setSystemTime(Date.now() - 61 * 1000);

  down = false;
  clearApiCaches();
  await downloadWorker.processJob(trackedJob(downloadTracker, ids[1]));
  assert.deepEqual(
    [requireQueued(ids[1]).albumGrab, requireQueued(ids[1]).albumGroupJobIds],
    [true, [ids[1], ids[0], ids[2]]],
  );
  assert.deepEqual(
    ids.map((id) => trackedJob(downloadTracker, id).error),
    [null, null, null],
  );
});

test("a track that waited for its release through every wait of an outage searches for the track", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("long-outage", "Outage Band", [
    { id: "long-outage-release", tracks: ["First", "Second"] },
  ]);
  let down = true;
  await serveGroups(t, [group], { unavailable: () => down });
  const [jobId] = libraryJobs(group, ["First"]);
  let waits = 0;
  for (; waits < 100 && !queued(jobId); waits += 1)
    await downloadWorker.processJob(trackedJob(downloadTracker, jobId));
  assert.ok(waits > 2 && waits < 100, `${waits} steps`);
  assert.deepEqual(
    [requireQueued(jobId).albumGrab, trackedJob(downloadTracker, jobId).error],
    [undefined, NO_RELEASE_REASON],
  );

  claimQueued(jobId);
  downloadTracker.setPending(jobId);
  down = false;
  clearApiCaches();
  await downloadWorker.processJob(trackedJob(downloadTracker, jobId));
  assert.equal(requireQueued(jobId).albumGrab, true);
});

test("a track known by its album's name waits while metadata cannot be read, keeps the release it names, and searches by release once it can", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("named", "Named Band", [
    { id: "named-standard", tracks: ["Intro", "Song"] },
    { id: "named-pressing", tracks: ["Intro", "Song"] },
    { id: "named-deluxe", tracks: ["Intro", "Song", "Bonus"] },
  ]);
  let down = true;
  await serveGroups(t, [group], { unavailable: () => down, searchable: true });
  const named = createTrackedJob(
    downloadTracker,
    { artistName: "Named Band", trackName: "Song", albumName: "named Album" },
    "library",
  );
  const listened = createTrackedJob(
    downloadTracker,
    {
      artistName: "Named Band",
      trackName: "Song",
      albumName: "named Album",
      releaseMbid: "named-deluxe",
    },
    "library",
  );
  const row = (id: string) =>
    db
      .prepare<
        [string],
        { album_mbid: string | null; release_mbid: string | null; error: string | null }
      >("SELECT album_mbid, release_mbid, error FROM playlist_download_jobs WHERE id = ?")
      .get(id)!;

  for (const id of [named, listened])
    await downloadWorker.processJob(trackedJob(downloadTracker, id));
  assert.deepEqual(queuedFor([named, listened]), []);
  assert.deepEqual(
    [row(named), row(listened)].map(({ album_mbid, release_mbid }) => [album_mbid, release_mbid]),
    [
      [null, null],
      [null, "named-deluxe"],
    ],
  );
  assert.notEqual(row(named).error, NO_RELEASE_REASON);

  down = false;
  for (const id of [named, listened])
    await downloadWorker.processJob(trackedJob(downloadTracker, id));
  assert.deepEqual(
    [named, listened].map((id) => [requireQueued(id).albumGrab, row(id).album_mbid]),
    [
      [true, group.id],
      [true, group.id],
    ],
  );
  assert.equal(requireQueued(listened).releaseMbid, "named-deluxe");
});

test("an album attempt whose leading track stopped gives the rest back untried and removes the download its source started", async (t) => {
  useSources({
    nzbget: { enabled: true, url: "http://127.0.0.1:9" },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  const group = album("orphan", "Orphan Band", [
    { id: "orphan-release", tracks: ["First", "Second"] },
  ]);
  let down = false;
  await serveGroups(t, [group], { unavailable: () => down });
  const nzbget = getDownloadClient("nzbget");
  const removedQueue = vi.spyOn(nzbget, "deleteQueueItem").mockImplementation(async () => true);
  const removedHistory = vi.spyOn(nzbget, "deleteHistoryItem").mockImplementation(async () => true);
  const finalizing = async (ids: string[], nzbId: string) => {
    await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
    const attempt = claimQueued(ids[0]);
    assert.ok(attempt != null);
    assert.deepEqual(attempt.albumGroupJobIds, ids);
    downloadTracker.setFailed(ids[0], "Stopped");
    return { ...attempt, phase: "finalize", source: "usenet", downloadClient: "nzbget", nzbId };
  };

  const stopped = libraryJobs(group, ["First", "Second"]);
  assert.equal(await processPipelinePayload(await finalizing(stopped, "nzb-stopped")), null);
  assert.deepEqual(
    [
      trackedJob(downloadTracker, stopped[1]).status,
      trackedJob(downloadTracker, stopped[1]).albumGrabAttempted,
    ],
    ["pending", false],
  );
  assert.deepEqual(
    [removedQueue, removedHistory].map((mock) => mock.mock.calls.map((call) => call[0])),
    [["nzb-stopped"], ["nzb-stopped"]],
  );

  resetDatabase(db);
  useSources({
    nzbget: { enabled: true, url: "http://127.0.0.1:9" },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  removedQueue.mockClear();
  const blinked = libraryJobs(group, ["First", "Second"], { requestGroupId: "blinked-request" });
  const payload = await finalizing(blinked, "nzb-blinked");
  down = true;
  clearApiCaches();
  assert.equal(await processPipelinePayload(payload), null);
  assert.equal(trackedJob(downloadTracker, blinked[1]).status, "pending");
  assert.deepEqual(
    removedQueue.mock.calls.map((call) => call[0]),
    ["nzb-blinked"],
  );
});

test("a Soulseek album attempt whose leading track stopped removes the transfers it queued", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("transfers", "Transfer Band", [
    { id: "transfers-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const removed = vi.spyOn(slskd, "deleteTransfer").mockImplementation(async () => true);
  const ids = libraryJobs(group, ["First", "Second"]);
  assert.ok(ids.every((value) => value != null));
  downloadTracker.setDone(ids[0], "/library/Transfer Band/01 First.flac");

  assert.equal(
    await processPipelinePayload(
      albumAttempt(ids, {
        phase: "poll",
        source: "slskd",
        candidate: { raw: { user: "peer", files: [] } },
        albumTransfers: [{ id: "first" }, { id: "second" }],
      }),
    ),
    null,
  );
  assert.deepEqual(
    removed.mock.calls.map((call) => call.slice(0, 2)),
    [
      ["peer", "first"],
      ["peer", "second"],
    ],
  );
  assert.equal(trackedJob(downloadTracker, ids[1]).status, "pending");
});

test("cancelling only the leading track of a queued album attempt gives the rest back untried to start their own", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("leader-cancel", "Cancel Band", [
    { id: "leader-cancel-release", tracks: ["First", "Second", "Third"] },
  ]);
  await serveGroups(t, [group]);
  const stopped = vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  const ids = libraryJobs(group, ["First", "Second", "Third"]);
  assert.ok(ids.every((value) => value != null));
  await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
  const attempt = queued(ids[0]);
  assert.ok(attempt != null);
  enqueuePipelineStep({ ...claimQueued(ids[0]), searchIds: ["album-search"] }, {});
  assert.deepEqual(attempt.albumGroupJobIds, ids);

  await cancelDownloadWorkForJobs([trackedJob(downloadTracker, ids[0])]);
  downloadTracker.removeJob(ids[0]);
  assert.deepEqual(queuedFor(ids), []);
  assert.deepEqual(
    stopped.mock.calls.map((call) => call[0]),
    ["album-search"],
  );
  for (const id of ids.slice(1)) {
    assert.deepEqual(
      [trackedJob(downloadTracker, id).status, trackedJob(downloadTracker, id).albumGrabAttempted],
      ["pending", false],
    );
  }
  await downloadWorker.processJob(trackedJob(downloadTracker, ids[1]));
  assert.deepEqual(
    [requireQueued(ids[1]).albumGrab, requireQueued(ids[1]).albumGroupJobIds],
    [true, [ids[1], ids[2]]],
  );
});

test("an album step that fails on every retry blocks the release it downloaded, starts again after fresh work, and searches for each track after the third time", async (t) => {
  useSources({
    nzbget: { enabled: true, url: "http://127.0.0.1:9" },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  const group = album("retries", "Retry Band", [
    { id: "retries-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const nzbget = getDownloadClient("nzbget");
  const removedQueue = vi.spyOn(nzbget, "deleteQueueItem").mockImplementation(async () => true);
  vi.spyOn(nzbget, "deleteHistoryItem").mockImplementation(async () => true);
  vi.spyOn(nzbget, "getHistoryItem").mockImplementation(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const ids = libraryJobs(group, ["First", "Second"]);
  assert.ok(ids.every((value) => value != null));
  const failAttempt = async (attempt: number) => {
    await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
    const finalizing = {
      ...claimQueued(ids[0]),
      phase: "finalize",
      source: "usenet",
      downloadClient: "nzbget",
      nzbId: `nzb-${attempt}`,
      candidateIndex: 0,
      candidates: [
        { raw: { release: { guid: `guid-${attempt}`, title: "Retry Band - retries Album" } } },
      ],
    };
    assert.equal(finalizing.albumGrab, true);
    await assert.rejects(processPipelinePayload(finalizing), /ECONNREFUSED/);
    return failPipelineJob(finalizing, "connect ECONNREFUSED");
  };

  for (const attempt of [1, 2]) {
    assert.equal(await failAttempt(attempt), null);
    for (const id of ids) {
      const job = trackedJob(downloadTracker, id);
      assert.ok(job != null);
      assert.deepEqual(
        [
          job.status,
          job.albumGrabAttempted,
          (job.deniedRemoteSources || []).map((entry) => entry[1]),
        ],
        ["pending", false, Array.from({ length: attempt }, (_, index) => `guid-${index + 1}`)],
      );
    }
    const fresh = createTrackedJob(
      downloadTracker,
      { artistName: "Other Band", trackName: `Fresh Song ${attempt}` },
      "library",
    );
    assert.ok(fresh != null);
    const order = downloadTracker.peekPending(100).map((job) => job.id);
    assert.ok(
      order.indexOf(fresh) >= 0 && order.indexOf(fresh) < order.indexOf(ids[0]),
      "fresh work goes first",
    );
    assert.deepEqual(queuedFor(ids), []);
  }
  const trackSearch = await failAttempt(3);
  assert.ok(trackSearch != null);
  assert.deepEqual(
    removedQueue.mock.calls.map((call) => call[0]),
    ["nzb-1", "nzb-2", "nzb-3"],
  );
  assert.deepEqual(
    [trackSearch.jobId, trackSearch.albumGrab, trackSearch.phase],
    [ids[0], false, "search"],
  );
  assert.deepEqual(
    [
      trackedJob(downloadTracker, ids[1]).status,
      trackedJob(downloadTracker, ids[1]).albumGrabAttempted,
    ],
    ["pending", true],
  );
  assert.match(trackedJob(downloadTracker, ids[1]).error ?? "", /ECONNREFUSED/);
});

test("an album source whose step fails on every retry hands the attempt to the next album source", async (t) => {
  useSources({
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
    nzbget: { enabled: true, url: "http://127.0.0.1:9" },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  const group = album("refused", "Refused Band", [
    { id: "refused-release", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const stopped = vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(slskd, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  const ids = libraryJobs(group, ["First", "Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
  const searching = {
    ...claimQueued(ids[0]),
    source: "slskd",
    activeSearch: { id: "refused-search", query: "Refused Band", startedAt: 0 },
  };

  const next = await failPipelineJob(searching, "Request failed with status code 401");
  assert.ok(next != null);
  assert.deepEqual(
    [next.source, next.phase, next.albumGrab, next.albumGroupJobIds, next.downloadAttemptId],
    ["usenet", "search", true, ids, searching.downloadAttemptId],
  );
  assert.deepEqual(
    stopped.mock.calls.map((call) => call[0]),
    ["refused-search"],
  );
  assert.equal(trackedJob(downloadTracker, ids[1]).status, "downloading");
});

test("a track step that fails on every retry hands the track to the next source and removes its search", async () => {
  useSources({
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 1 },
    nzbget: { enabled: true, url: "http://127.0.0.1:9", priority: 2 },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  const stopped = vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  const id = createTrackedJob(
    downloadTracker,
    { artistName: "Lone Band", trackName: "Lone Song", durationMs: 200000 },
    "library",
  );
  await downloadWorker.processJob(trackedJob(downloadTracker, id));
  const queuedStep = claimQueued(id);

  for (const failed of [
    queuedStep,
    {
      ...queuedStep,
      source: "slskd",
      activeSearch: { id: "lone-search", query: "Lone Band", startedAt: 0 },
    },
  ]) {
    const next = await failPipelineJob(failed, "Request failed with status code 401");
    assert.deepEqual(
      [next?.source, next?.phase, next?.albumGrab === true],
      ["usenet", "search", false],
    );
    assert.equal(trackedJob(downloadTracker, id).status, "pending");
  }
  assert.deepEqual(
    stopped.mock.calls.map((call) => call[0]),
    ["lone-search"],
  );
});

test("an album attempt whose first source is down searches the next source once, then searches for the track on every other source before the one that failed", async (t) => {
  useSources({
    slskd: { enabled: true, url: "http://127.0.0.1:9", priority: 1 },
    nzbget: { enabled: true, url: "http://127.0.0.1:9", priority: 2 },
    ytdlp: { enabled: true, priority: 3 },
    prowlarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "key" },
  });
  const group = album("down", "Down Band", [{ id: "down-release", tracks: ["First", "Second"] }]);
  await serveGroups(t, [group]);
  const searches: string[] = [];
  vi.spyOn(slskd, "createSearch").mockImplementation(async () => {
    searches.push("soulseek");
    throw Object.assign(new Error("Request failed with status code 401"), {
      response: { status: 401 },
    });
  });
  vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => [
    {
      id: 1,
      name: "indexer",
      musicSearch: true,
      protocol: "usenet",
      enabledInProwlarr: true,
      enabled: true,
      supportsSearch: true,
      priority: 1,
      categories: [3000],
    },
  ]);
  vi.spyOn(prowlarrClient, "search").mockImplementation(async (query) => {
    searches.push(String(query).includes("Second") ? "usenet track" : "usenet album");
    return [];
  });
  vi.spyOn(ytdlp, "isConfigured").mockImplementation(() => true);
  vi.spyOn(ytdlp, "search").mockImplementation(async () => {
    searches.push("yt-dlp");
    return [];
  });
  const [id] = libraryJobs(group, ["Second"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, id));

  let payload: PipelinePayload | null = claimQueued(id);
  assert.ok(payload != null);
  for (let step = 0; step < 20 && payload; step += 1) {
    payload = await processPipelinePayload(payload).catch((error) =>
      failPipelineJob(payload!, error.message),
    );
  }
  assert.deepEqual(
    searches.filter((entry, index) => entry === "soulseek" || entry !== searches[index - 1]),
    ["soulseek", "usenet album", "usenet track", "yt-dlp", "soulseek"],
  );
  const job = trackedJob(downloadTracker, id);
  assert.ok(job != null);
  assert.equal(job.status, "failed");
  assert.ok(job.error);
  assert.match(job.error, /401/);
});

const GROUP = "b2b2b2b2-0000-4000-8000-000000000002";
const resolvedGroup = brainzmashGroup({
  id: GROUP,
  title: "Resolved Album",
  artist: "Resolved Band",
  releases: [{ id: "resolved-release", tracks: ["First", "Second", "Third"] }],
});

function resolvedJobs(titles: string[], requestGroupId: string = GROUP) {
  return titles.map((trackName, index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "Resolved Band",
        albumName: "Resolved Album",
        albumMbid: GROUP,
        requestGroupId,
        trackName,
        trackNumber: index + 2,
        durationMs: 200000,
      },
      "library",
    ),
  );
}

test("a track's release is chosen once, pinned on every track of its attempt, and the queued attempt carries only its ID", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const metadata = await serveGroups(t, [resolvedGroup]);
  const created = mockSoulseekSearch(t, []);
  const [leader, sibling] = resolvedJobs(["Second", "Third"]);

  await downloadWorker.processJob(trackedJob(downloadTracker, leader));
  const payload = queued(leader);
  assert.ok(payload != null);
  assert.deepEqual(payload.albumGroupJobIds, [leader, sibling]);
  assert.equal(payload.releaseMbid, "resolved-release");
  assert.equal("release" in payload, false);
  assert.deepEqual(
    db
      .prepare<[string, string, string], { release_mbid: string }>(
        "SELECT release_mbid FROM playlist_download_jobs WHERE id IN (?, ?) ORDER BY id = ?",
      )
      .all(sibling, leader, leader)
      .map((row) => row.release_mbid),
    ["resolved-release", "resolved-release"],
  );
  assert.equal(created.mock.calls.length, 0);

  // A restart empties the process caches; the release loads again from the metadata cache.
  clearReleaseManifests();
  const lookups = metadata.mock.calls.length;
  const searching = await processPipelinePayload(payload);
  assert.ok(searching != null);
  assert.equal(searching.albumGrab, true);
  assert.equal(created.mock.calls.length, 1);
  assert.equal(metadata.mock.calls.length, lookups);
});

test("each track joins only an attempt for the release it is pinned to and listed on, and a track on none says why", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const group = album("pinned", "Pinned Band", [
    { id: "standard", tracks: ["First", "Second"] },
    { id: "deluxe", tracks: ["First", "Second", "Bonus Song"] },
  ]);
  await serveGroups(t, [group]);
  const info = vi.spyOn(logger, "info");
  const [offRelease, first] = libraryJobs(group, ["Bonus Song", "First"], {
    releaseMbid: "standard",
  });
  const [deluxeSecond, deluxeBonus] = libraryJobs(group, ["Second", "Bonus Song"], {
    releaseMbid: "deluxe",
  });

  await downloadWorker.processJob(trackedJob(downloadTracker, offRelease));
  assert.equal(requireQueued(offRelease).albumGrab, undefined);
  assert.equal(trackedJob(downloadTracker, offRelease).error, OFF_RELEASE_REASON);
  assert.equal(
    info.mock.calls.filter((call) => call[1] === "Searching for the track without its release")
      .length,
    1,
  );
  for (const id of [first, deluxeSecond, deluxeBonus]) {
    assert.equal(trackedJob(downloadTracker, id).status, "pending");
    assert.notEqual(trackedJob(downloadTracker, id).albumGrabAttempted, true);
  }

  await downloadWorker.processJob(trackedJob(downloadTracker, first));
  assert.deepEqual(
    [requireQueued(first).releaseMbid, requireQueued(first).albumGroupJobIds],
    ["standard", [first]],
  );
  assert.equal(trackedJob(downloadTracker, deluxeSecond).status, "pending");

  await downloadWorker.processJob(trackedJob(downloadTracker, deluxeSecond));
  assert.deepEqual(
    [requireQueued(deluxeSecond).releaseMbid, requireQueued(deluxeSecond).albumGroupJobIds],
    ["deluxe", [deluxeSecond, deluxeBonus]],
  );
});

test("tracks pinned to a release MusicBrainz merged away share one attempt on the release chosen in its place, which their Library album asks for from then on", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  await serveGroups(t, [resolvedGroup]);
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:resolved-band",
    mbid: "resolved-band",
    name: "Resolved Band",
  });
  libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${GROUP}`,
    mbid: GROUP,
    releaseGroupMbid: GROUP,
    artistId: artist.id,
    title: "Resolved Album",
    metadata: { requestedRelease: "merged-away-release", edition: "standard" },
  });
  const ids = ["First", "Second", "Third"].map((trackName, index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "Resolved Band",
        albumName: "Resolved Album",
        albumMbid: GROUP,
        requestGroupId: GROUP,
        releaseMbid: "merged-away-release",
        trackName,
        trackNumber: index + 1,
        durationMs: 200000,
      },
      "library",
    ),
  );

  await downloadWorker.processJob(trackedJob(downloadTracker, ids[0]));
  assert.deepEqual(
    [requireQueued(ids[0]).releaseMbid, requireQueued(ids[0]).albumGroupJobIds],
    ["resolved-release", ids],
  );
  assert.deepEqual(
    ids.map(
      (id) =>
        db
          .prepare<[string], { release_mbid: string }>(
            "SELECT release_mbid FROM playlist_download_jobs WHERE id = ?",
          )
          .get(id)!.release_mbid,
    ),
    ["resolved-release", "resolved-release", "resolved-release"],
  );
  assert.equal(
    JSON.parse(
      db
        .prepare<[string], { metadata_json: string }>(
          "SELECT metadata_json FROM library_albums WHERE release_group_mbid = ?",
        )
        .get(GROUP)!.metadata_json,
    ).requestedRelease,
    "resolved-release",
  );
});

test("a track that can search by release, found mid-search with no queued step, goes back through the worker to search by release", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  await serveGroups(t, [resolvedGroup]);
  const [interrupted] = resolvedJobs(["Second"]);
  db.prepare("UPDATE playlist_download_jobs SET slskd_search_id = ? WHERE id = ?").run(
    "interrupted-search",
    interrupted,
  );
  downloadTracker.reconcileCommittedJobs();

  assert.equal(enqueuePendingJobsWithoutBatch(), 0);
  assert.equal(queued(interrupted), undefined);
  await downloadWorker.processJob(trackedJob(downloadTracker, interrupted));
  assert.deepEqual(
    [requireQueued(interrupted).albumGrab, requireQueued(interrupted).releaseMbid],
    [true, "resolved-release"],
  );
});

test("an album attempt with no album source enabled searches for the track instead of failing", async (t) => {
  useSources({ ytdlp: { enabled: true } });
  vi.spyOn(ytdlp, "isConfigured").mockImplementation(() => true);
  const search = vi.spyOn(ytdlp, "search").mockImplementation(async () => []);
  const group = album("video", "Video Band", [
    { id: "no-album-source", tracks: ["First", "Second"] },
  ]);
  await serveGroups(t, [group]);
  const [jobId] = libraryJobs(group, ["Second"]);

  await processPipelinePayload(albumAttempt([jobId]));
  assert.ok(search.mock.calls.length > 0);
  assert.doesNotMatch(String(trackedJob(downloadTracker, jobId).error || ""), /not configured/i);
});

// The album attempt the previous version queued: no release ID at all.
function legacyAttempt(ids: string[], extra: Partial<PipelinePayload> = {}) {
  const { releaseMbid: _releaseMbid, ...payload } = albumAttempt(ids, extra);
  for (const id of ids) downloadTracker.setAlbumGrabAttempted(id, true);
  return payload;
}

const legacyTransfer = {
  phase: "poll",
  source: "slskd",
  candidate: { raw: { user: "peer", files: [] } },
  albumTransfers: [],
};

test("an album transfer queued before attempts named their release keeps its transfer on the release it resolves to", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const metadata = await serveGroups(t, [resolvedGroup]);
  const transfer = vi.spyOn(slskd, "getTransfer").mockImplementation(async () => null);
  const [leader, sibling] = resolvedJobs(["Second", "Third"]);

  const resumed = await processPipelinePayload(legacyAttempt([leader, sibling], legacyTransfer));
  assert.ok(resumed != null);
  assert.deepEqual(
    [resumed.phase, resumed.albumGrab, resumed.releaseMbid],
    ["poll", true, "resolved-release"],
  );
  assert.deepEqual(
    [leader, sibling].map((id) => trackedJob(downloadTracker, id).releaseMbid),
    ["resolved-release", "resolved-release"],
  );
  assert.equal(transfer.mock.calls.length, 0);
  const lookups = metadata.mock.calls.length;
  await processPipelinePayload(resumed);
  assert.equal(metadata.mock.calls.length, lookups);
});

test("an album transfer queued before attempts named their release waits while its release cannot be read, and finishes without one only after the last wait", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  let down = true;
  let unknown = false;
  await serveGroups(t, [resolvedGroup], { unavailable: () => down, missing: () => unknown });
  const unresolved = resolvedJobs(["Second", "Third"]);

  const waiting = await processPipelinePayload(legacyAttempt(unresolved, legacyTransfer));
  assert.ok(waiting != null);
  assert.deepEqual(
    [
      waiting.phase,
      waiting.albumGrab,
      "releaseMbid" in waiting,
      waiting.albumTransfers,
      waiting.candidate,
    ],
    ["poll", true, false, [], legacyTransfer.candidate],
  );
  assert.ok(waiting.delaySeconds != null);
  assert.ok(waiting.delaySeconds > 0);
  assert.equal(trackedJob(downloadTracker, unresolved[1]).status, "downloading");
  down = false;
  clearApiCaches();
  const adopted = await processPipelinePayload(waiting);
  assert.ok(adopted != null);
  assert.deepEqual(
    [adopted.phase, adopted.releaseMbid, adopted.delaySeconds],
    ["poll", "resolved-release", 0],
  );

  unknown = true;
  clearApiCaches();
  let step = await processPipelinePayload(
    legacyAttempt(resolvedJobs(["Second", "Third"], "outage-request"), legacyTransfer),
  );
  assert.ok(step != null);
  let waits = 1;
  for (; step?.releaseMbid === undefined && waits < 100; waits += 1)
    step = await processPipelinePayload(step);
  assert.ok(step != null);
  assert.ok(waits > 2 && waits < 100, `${waits} steps`);
  assert.deepEqual([step.phase, step.albumGrab, step.releaseMbid], ["poll", true, null]);
});

test("an album search queued before attempts named their release stops its search and gives its tracks back to start one again", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  await serveGroups(t, [resolvedGroup]);
  const created = mockSoulseekSearch(t, []);
  const stopped = vi.spyOn(slskd, "deleteSearch").mockImplementation(async () => true);
  const [leader, sibling] = resolvedJobs(["Second", "Third"]);
  await downloadWorker.processJob(trackedJob(downloadTracker, leader));
  const { releaseMbid: _releaseMbid, ...queuedLegacy } = claimQueued(leader);

  assert.equal(
    await processPipelinePayload({
      ...queuedLegacy,
      source: "slskd",
      searchIds: ["legacy-search"],
      activeSearch: {
        id: "legacy-search",
        query: "Resolved Band Resolved Album",
        startedAt: Date.now(),
      },
    }),
    null,
  );
  assert.equal(created.mock.calls.length, 0);
  assert.deepEqual(
    stopped.mock.calls.map((call) => call[0]),
    ["legacy-search"],
  );
  for (const id of [leader, sibling]) {
    assert.deepEqual(
      [trackedJob(downloadTracker, id).status, trackedJob(downloadTracker, id).albumGrabAttempted],
      ["pending", false],
    );
  }

  await downloadWorker.processJob(trackedJob(downloadTracker, leader));
  assert.deepEqual(
    [requireQueued(leader).releaseMbid, requireQueued(leader).albumGroupJobIds],
    ["resolved-release", [leader, sibling]],
  );
});

test("a two-disc Soulseek release pairs each track with its own disc, in disc folders or numbered straight through", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  const tracklist: [number, number, string][] = [
    [1, 1, "Bomb"],
    [1, 2, "Swim"],
    [2, 1, "Bomb"],
    [2, 2, "Little Things"],
  ];
  const group = brainzmashGroup({
    id: "two-disc-group",
    title: "Disc Album",
    artist: "Disc Band",
    releases: [
      {
        id: "two-disc",
        tracks: tracklist.map(([disc, position, title]) => ({ title, disc, position })),
      },
    ],
  });
  await serveGroups(t, [group]);
  const ids = tracklist.map(([discNumber, trackNumber, trackName]) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "Disc Band",
        albumName: "Disc Album",
        albumMbid: "two-disc-group",
        releaseMbid: "two-disc",
        requestGroupId: "two-disc-group",
        trackName,
        trackNumber,
        discNumber,
        durationMs: 200000,
      },
      "library",
    ),
  );
  mockSoulseekSearch(t, [
    soulseekFolder(
      "discs",
      "Disc Band\\Disc Album",
      tracklist.map(([disc, position, title]) => [`CD${disc}\\0${position} - ${title}`]),
    ),
    soulseekFolder(
      "straight",
      "Disc Band\\Disc Album",
      tracklist.map(([, , title], index) => [`0${index + 1} - ${title}`]),
    ),
  ]);

  let payload: PipelinePayload | null = albumAttempt(ids, { source: "slskd" });
  while (payload?.phase === "search") payload = await processPipelinePayload(payload);

  assert.ok(payload != null);
  assert.ok(payload.candidates != null);
  const byUser = Object.fromEntries(
    soulseekReleaseCandidates(payload).map((candidate) => [
      candidate.raw.user,
      candidate.raw.files.map((file) => [file.jobId, file.file!.split("\\").slice(-2).join("/")]),
    ]),
  );
  assert.deepEqual(
    byUser.discs,
    ids.map((id, index) => [
      id,
      `CD${tracklist[index][0]}/0${tracklist[index][1]} - ${tracklist[index][2]}.flac`,
    ]),
  );
  assert.deepEqual(
    byUser.straight,
    ids.map((id, index) => [id, `Disc Album/0${index + 1} - ${tracklist[index][2]}.flac`]),
  );
});

test("after an album attempt falls back, a sibling's own track search puts the copy from a folder of its release first", async (t) => {
  useSources({ slskd: { enabled: true, url: "http://127.0.0.1:9" } });
  await serveGroups(t, [resolvedGroup]);
  const titles = ["First", "Second", "Third", "Bonus"];
  const folder = (username: string, held: string[]) =>
    soulseekFolder(
      username,
      "Resolved Band\\Resolved Album",
      held.map((title) => [`0${titles.indexOf(title) + 1} - ${title}`]),
    );
  // The first folder is the release plus a bonus song; the second is the release missing one song.
  mockSoulseekSearch(t, [folder("bonus", titles), folder("exact", ["First", "Third"])]);
  const [leader, sibling] = resolvedJobs(["Second", "Third"], "affinity-request");

  await downloadWorker.processJob(trackedJob(downloadTracker, leader));
  let payload: PipelinePayload | null | undefined = queued(leader);
  assert.ok(payload != null);
  assert.deepEqual(payload.albumGroupJobIds, [leader, sibling]);
  // The queued step stays in the queue while the attempt runs and falls back.
  assert.ok(payload != null);
  while (payload?.albumGrab) payload = await processPipelinePayload(payload);
  assert.ok(payload);
  assert.equal(payload.jobId, leader);
  assert.equal(trackedJob(downloadTracker, sibling).status, "pending");

  await downloadWorker.processJob(trackedJob(downloadTracker, sibling));
  let step: PipelinePayload | null | undefined = queued(sibling);
  assert.ok(step != null);
  assert.equal(step.albumGrab, undefined);
  assert.equal(trackedJob(downloadTracker, sibling).status, "pending");
  while (step?.phase === "search") step = await processPipelinePayload(step);
  assert.ok(step != null);
  assert.ok(step.candidates != null);
  assert.deepEqual(
    soulseekReleaseCandidates(step).map((candidate) => candidate.raw.user),
    ["exact", "bonus"],
  );
});
