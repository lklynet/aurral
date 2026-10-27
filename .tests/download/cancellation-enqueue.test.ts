import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { api },
  { playlistOperationQueue },
  { downloadTracker },
  { playlistManager },
  mutationGuards,
  cancellation,
] = await setupIsolatedBackend(
  "cancellation-enqueue",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/mutationGuards.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
);
const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
} = cancellation;

const user = testUser(1, { permissions: { accessFlow: true } });
const app = signedInAs(user).route("/", api);
const send = async (method: string, path: string, body?: Record<string, unknown>) =>
  app.request(
    `/playlists${path}`,
    body
      ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method },
  );

const createFlow = ({
  enabled = false,
  name = "Test flow",
}: { enabled?: boolean; name?: string } = {}) => {
  const flow = flowPlaylistConfig.createFlow({
    name,
    ownerUserId: 1,
    mix: { discover: 100 },
  });
  if (enabled) flowPlaylistConfig.setEnabled(flow.id, true);
  return flow;
};

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  downloadTracker.clearAll();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a failed flow-delete enqueue restores active download work", async () => {
  const flow = createFlow({ name: "Delete queue rollback" });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-delete-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    flow.id,
  );
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = await send("DELETE", `/flows/${flow.id}`);

  assert.equal(response.status, 500);
  assert.ok(flowPlaylistConfig.getFlow(flow.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    true,
  );
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-delete-token");
});

test("a failed flow-disable enqueue restores enabled state and active downloads", async () => {
  const flow = createFlow({ name: "Disable queue rollback", enabled: true });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-disable-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    flow.id,
  );
  const playlistSync = vi
    .spyOn(playlistManager, "requestPlaylistSync")
    .mockImplementation(() => null);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = await send("PUT", `/flows/${flow.id}/enabled`, { enabled: false });

  assert.equal(response.status, 500);
  assert.equal(flowPlaylistConfig.getFlow(flow.id)!.enabled, true);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    true,
  );
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-disable-token");
  assert.equal(playlistSync.mock.calls.length, 0);
});

test("a failed flow disable does not undo a later disable", async () => {
  const flow = createFlow({ name: "Overlapping flow disables", enabled: true });
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    flow.id,
  );
  let signalFirstEnqueue!: () => void;
  let failFirstEnqueue!: (reason: Error) => void;
  const firstEnqueueStarted = new Promise<void>((resolve) => {
    signalFirstEnqueue = resolve;
  });
  const firstEnqueue = new Promise<
    Awaited<ReturnType<typeof playlistOperationQueue.enqueuePayload>>
  >((resolve, reject) => {
    failFirstEnqueue = reject;
  });
  let enqueueCalls = 0;
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    enqueueCalls += 1;
    if (enqueueCalls === 1) {
      signalFirstEnqueue();
      return firstEnqueue;
    }
    return { queued: true, operationId: 101 };
  });
  const disable = () => send("PUT", `/flows/${flow.id}/enabled`, { enabled: false });

  const first = disable();
  await firstEnqueueStarted;
  const secondResponse = await disable();
  failFirstEnqueue(new Error("queue unavailable"));
  const firstResponse = await first;

  assert.equal(firstResponse.status, 500);
  assert.equal(secondResponse.status, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id)!.enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    false,
  );
});

test("a successful flow disable reports the accepted cleanup operation", async () => {
  const flow = createFlow({ name: "Queued flow disable", enabled: true });
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    flow.id,
  );
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  let queuedPayload: import("../../backend/services/honkerDb.ts").HonkerPayload | undefined;
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload) => {
    queuedPayload = payload;
    return { queued: true, operationId: 102 };
  });
  const response = await send("PUT", `/flows/${flow.id}/enabled`, { enabled: false });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queued, true);
  assert.equal(body.operationId, 102);
  assert.ok(queuedPayload != null);
  assert.equal(queuedPayload.kind, "disable-flow-cleanup");
  assert.equal(flowPlaylistConfig.getFlow(flow.id)!.enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    false,
  );
});

test("flow settings updates wait for in-progress playlist mutations", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: { lastfm: { apiKey: "test" } },
  });
  const flow = createFlow({ name: "Serialized flow settings" });
  flowPlaylistConfig.updateFlow(flow.id, { scheduleDays: [1] });
  let signalMutationEntered!: () => void;
  let releaseMutation!: () => void;
  const mutationEntered = new Promise<void>((resolve) => {
    signalMutationEntered = resolve;
  });
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const mutation = mutationGuards.withPlaylistMutation(
    flow.id,
    async () => {
      signalMutationEntered();
      await mutationGate;
    },
    { clearPending: false },
  );
  let update: Promise<Response> | undefined;
  let answered = false;

  try {
    await mutationEntered;
    vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
    update = send("PUT", `/flows/${flow.id}`, { name: "Updated while serialized" }).finally(() => {
      answered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(answered, false);
  } finally {
    releaseMutation();
    await Promise.allSettled([mutation, update].filter(Boolean));
  }

  assert.equal((await update)?.status, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id)!.name, "Updated while serialized");
});

test("a failed shared-track delete enqueue clears only its new job-cancellation marker", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Track queue rollback",
    ownerUserId: user.id,
    tracks: [],
  });
  const generation = activatePlaylistDownloadGeneration(playlist.id);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlist.id,
  );
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = await send("DELETE", `/shared-playlists/${playlist.id}/tracks/${jobId}`);

  assert.equal(response.status, 500);
  assert.ok(trackedJob(downloadTracker, jobId));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: generation }),
    true,
  );
});

test("a failed static playlist delete does not reactivate previously cancelled work", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled playlist",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlist.id,
  );
  cancelPlaylistDownloadGeneration(playlist.id);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = await send("DELETE", `/shared-playlists/${playlist.id}`);

  assert.equal(response.status, 500);
  assert.ok(flowPlaylistConfig.getStaticPlaylist(playlist.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: 0 }),
    false,
  );
});

test("a failed track-delete enqueue preserves an existing job-cancellation marker", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled track",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlist.id,
  );
  cancelDownloadJob(jobId);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = await send("DELETE", `/shared-playlists/${playlist.id}/tracks/${jobId}`);

  assert.equal(response.status, 500);
  assert.equal(isDownloadJobCancelled(jobId), true);
});
