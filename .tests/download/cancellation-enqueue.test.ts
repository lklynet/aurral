import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { registerFlows },
  { registerStaticPlaylists },
  { playlistOperationQueue },
  { downloadTracker },
  { playlistManager },
  mutationGuards,
  cancellation,
] = await setupIsolatedBackend(
  "cancellation-enqueue",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/playlists/flowPlaylistConfig.ts",
  "backend/routes/playlists/handlers/flows.ts",
  "backend/routes/playlists/handlers/staticPlaylists.ts",
  "backend/services/playlists/playlistOperationQueue.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/playlists/playlistManager.ts",
  "backend/services/downloadJobs/mutationGuards.ts",
  "backend/services/downloadJobs/downloadCancellation.ts",
);
const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
} = cancellation;

const flowHandlers = new Map();
const flowUpdateHandlers = new Map();
registerFlows({
  get() {},
  post() {},
  put(path, ...handlers) {
    flowHandlers.set(path, handlers.at(-1));
    flowUpdateHandlers.set(path, handlers.at(-1));
  },
  delete(path, ...handlers) {
    flowHandlers.set(path, handlers.at(-1));
  },
});

const staticPlaylistHandlers = new Map();
registerStaticPlaylists({
  get() {},
  post() {},
  put(path, ...handlers) {
    staticPlaylistHandlers.set(path, handlers.at(-1));
  },
  delete(path, ...handlers) {
    staticPlaylistHandlers.set(path, handlers.at(-1));
  },
});

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const createFlow = ({ enabled = false, name } = {}) => {
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
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Delete queue rollback" });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-delete-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId")({ params: { flowId: flow.id }, user }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getFlow(flow.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    true,
  );
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-delete-token");
});

test("a failed flow-disable enqueue restores enabled state and active downloads", async () => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Disable queue rollback", enabled: true });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-disable-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  const playlistSync = vi
    .spyOn(playlistManager, "requestPlaylistSync")
    .mockImplementation(() => null);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId/enabled")(
    {
      params: { flowId: flow.id },
      body: { enabled: false },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, true);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    true,
  );
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-disable-token");
  assert.equal(playlistSync.mock.calls.length, 0);
});

test("a failed flow disable does not undo a later disable", async () => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Overlapping flow disables", enabled: true });
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  let signalFirstEnqueue;
  let failFirstEnqueue;
  const firstEnqueueStarted = new Promise((resolve) => {
    signalFirstEnqueue = resolve;
  });
  const firstEnqueue = new Promise((resolve, reject) => {
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
    return { operationId: "later-disable-operation" };
  });
  const disable = (response) =>
    flowHandlers.get("/flows/:flowId/enabled")(
      {
        params: { flowId: flow.id },
        body: { enabled: false },
        user,
      },
      response,
    );
  const firstResponse = createResponse();
  const secondResponse = createResponse();

  const first = disable(firstResponse);
  await firstEnqueueStarted;
  await disable(secondResponse);
  failFirstEnqueue(new Error("queue unavailable"));
  await first;

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    false,
  );
});

test("a successful flow disable reports the accepted cleanup operation", async () => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Queued flow disable", enabled: true });
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  let queuedPayload;
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload) => {
    queuedPayload = payload;
    return { operationId: "disable-operation" };
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId/enabled")(
    {
      params: { flowId: flow.id },
      body: { enabled: false },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.queued, true);
  assert.equal(response.body.operationId, "disable-operation");
  assert.equal(queuedPayload.kind, "disable-flow-cleanup");
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }),
    false,
  );
});

test("flow settings updates wait for in-progress playlist mutations", async () => {
  const user = { id: 1, role: "user" };
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: { lastfm: { apiKey: "test" } },
  });
  const flow = createFlow({ name: "Serialized flow settings" });
  flowPlaylistConfig.updateFlow(flow.id, { scheduleDays: [1] });
  let signalMutationEntered;
  let releaseMutation;
  const mutationEntered = new Promise((resolve) => {
    signalMutationEntered = resolve;
  });
  const mutationGate = new Promise((resolve) => {
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
  let update;
  const response = createResponse();

  try {
    await mutationEntered;
    vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
    update = flowUpdateHandlers.get("/flows/:flowId")(
      {
        params: { flowId: flow.id },
        body: { name: "Updated while serialized" },
        user,
      },
      response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.body, null);
  } finally {
    releaseMutation();
    await Promise.allSettled([mutation, update].filter(Boolean));
  }

  assert.equal(response.statusCode, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).name, "Updated while serialized");
});

test("a failed shared-track delete enqueue clears only its new job-cancellation marker", async () => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Track queue rollback",
    ownerUserId: user.id,
    tracks: [],
  });
  const generation = activatePlaylistDownloadGeneration(playlist.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/shared-playlists/:playlistId/tracks/:jobId")(
    {
      params: { playlistId: playlist.id, jobId },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.ok(downloadTracker.getJob(jobId));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: generation }),
    true,
  );
});

test("a failed static playlist delete does not reactivate previously cancelled work", async () => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled playlist",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  cancelPlaylistDownloadGeneration(playlist.id);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/shared-playlists/:playlistId")(
    {
      params: { playlistId: playlist.id },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getStaticPlaylist(playlist.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: 0 }),
    false,
  );
});

test("a failed track-delete enqueue preserves an existing job-cancellation marker", async () => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled track",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  cancelDownloadJob(jobId);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/shared-playlists/:playlistId/tracks/:jobId")(
    {
      params: { playlistId: playlist.id, jobId },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.equal(isDownloadJobCancelled(jobId), true);
});
