import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { processPlaylistOperation },
  { downloadWorker },
  { flowTrackSource },
  { api },
  { default: axios },
] = await setupIsolatedBackend(
  "flow-auto-download",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/flows/flowTrackSource.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../lib/axiosFetch.ts"),
);

afterAll(() => cleanupIsolatedState(isolatedState));

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER ?? "";
assert.ok(downloadRoot);

const planTrack = (artistName: string, trackName: string) => ({
  artistName,
  trackName,
  albumName: "Album",
  artistMbid: null,
  albumMbid: null,
  trackMbid: null,
  releaseYear: null,
  durationMs: null,
  artistAliases: [],
  reason: "Discover",
});
const owned = planTrack("Owned Artist", "Owned Track");
const missing = planTrack("New Artist", "New Track");
const noSource = { ytdlp: { enabled: false } };
const slskd = { ...noSource, slskd: { enabled: true, url: "http://slskd", apiKey: "test" } };

beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: noSource,
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
  });
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  downloadWorker.stop();
  await fs.rm(downloadRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.spyOn(downloadWorker, "start").mockResolvedValue(undefined);
  vi.spyOn(flowTrackSource, "buildFlowRunPlan").mockResolvedValue({
    primaryTracks: [owned, missing],
  });
});

const useIntegrations = (integrations: typeof slskd) =>
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations });

async function ownTrack(track: typeof owned) {
  const sourcePath = path.join(
    downloadRoot,
    "aurral-weekly-flow",
    "other",
    `${track.trackName}.flac`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const jobId = downloadTracker.addJob(track, "other");
  assert.ok(jobId);
  downloadTracker.setDone(jobId, sourcePath, track.albumName);
}

const createFlow = (fields: { autoDownload?: boolean } = {}) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Dice", size: 2, ...fields });
  flowPlaylistConfig.setEnabled(flow.id, true);
  return flow;
};

const flowStatuses = (flowId: string) =>
  downloadTracker
    .getByPlaylistType(flowId)
    .map((job) => `${job.trackName}:${job.status}`)
    .sort();

const requestPlaylists = (path: string, init?: RequestInit) =>
  signedInAs(testUser(1, { role: "admin", permissions: { accessFlow: true } }))
    .route("/", api)
    .request(`/playlists${path}`, init);

const postFlow = (path: string, body: object) =>
  requestPlaylists(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("a flow with auto-download off lists new tracks without queueing them and reuses owned ones", async () => {
  useIntegrations(slskd);
  await ownTrack(owned);
  const flow = createFlow({ autoDownload: false });

  await processPlaylistOperation({ kind: "manual-start-flow", flowId: flow.id });

  assert.deepEqual(flowStatuses(flow.id), ["New Track:saved", "Owned Track:done"]);
  assert.equal(downloadTracker.getNextPending(), null);
  assert.equal(vi.mocked(downloadWorker.start).mock.calls.length, 0);
  const [run] = dbOps
    .getAurralHistory({ limit: 10 })
    .filter((entry) => entry.kind === "flow_generating");
  assert.equal(run?.status, "completed");
  assert.equal(run?.subtitle, "2 tracks found");
});

test("a scheduled flow still runs without a download source and keeps its tracks listed", async () => {
  const flow = createFlow();
  assert.equal(flow.autoDownload, true);

  await processPlaylistOperation({ kind: "scheduled-flow-refresh", flowId: flow.id });

  assert.deepEqual(flowStatuses(flow.id), ["New Track:saved", "Owned Track:saved"]);
  assert.ok(Number(flowPlaylistConfig.getFlow(flow.id)?.nextRunAt) > Date.now());
});

const recipe = {
  size: 10,
  scheduleDays: [1],
  mix: { discover: 100, mix: 0, trending: 0, focus: 0, newReleases: 0 },
};

test("new flows start with auto-download off until a download source exists", async () => {
  const withoutSource = await postFlow("/flows", { name: "No Source", ...recipe });
  assert.equal((await withoutSource.json()).flow.autoDownload, false);

  useIntegrations(slskd);
  const withSource = await postFlow("/flows", { name: "With Source", ...recipe });
  assert.equal((await withSource.json()).flow.autoDownload, true);
});

test("downloading a flow queues only its listed tracks", async () => {
  useIntegrations(slskd);
  await ownTrack(owned);
  const flow = createFlow({ autoDownload: false });
  await processPlaylistOperation({ kind: "manual-start-flow", flowId: flow.id });

  const result = await processPlaylistOperation({ kind: "flow-download-saved", flowId: flow.id });

  assert.deepEqual(result, { queued: 1 });
  assert.deepEqual(flowStatuses(flow.id), ["New Track:pending", "Owned Track:done"]);
  assert.equal(vi.mocked(downloadWorker.start).mock.calls.length, 1);
});

test("downloading a flow without a download source explains what is missing", async () => {
  const flow = createFlow({ autoDownload: false });

  const response = await postFlow(`/flows/${flow.id}/download`, {});

  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /download source/i);
});

test("a track that is not downloaded plays its Deezer preview", async () => {
  const flow = createFlow({ autoDownload: false });
  await processPlaylistOperation({ kind: "manual-start-flow", flowId: flow.id });
  const job = downloadTracker
    .getByPlaylistType(flow.id)
    .find((entry) => entry.trackName === "New Track");
  assert.ok(job);
  const clip = "https://cdnt-preview.dzcdn.net/42.mp3";
  vi.spyOn(axios, "get").mockImplementation(async (url) => ({
    status: 200,
    statusText: "OK",
    headers: {},
    data: String(url).endsWith("/search")
      ? { data: [{ id: 42, title: "New Track", artist: { name: "New Artist" }, preview: clip }] }
      : { id: 42, title: "New Track", preview: clip },
  }));

  const response = await requestPlaylists(`/stream/${job.id}`);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), clip);
});
