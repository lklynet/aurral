import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { registerFlows },
  { registerSharedPlaylists },
  { weeklyFlowOperationQueue },
  { downloadTracker },
  { playlistManager },
  mutationGuards,
  cancellation,
] = await setupIsolatedBackend(
  "cancellation-enqueue",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/routes/weeklyFlow/handlers/flows.js",
  "backend/routes/weeklyFlow/handlers/sharedPlaylists.js",
  "backend/services/weeklyFlow/weeklyFlowOperationQueue.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowMutationGuards.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
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
  delete(path, ...handlers) { flowHandlers.set(path, handlers.at(-1)); },
});

const sharedPlaylistHandlers = new Map();
registerSharedPlaylists({
  get() {},
  post() {},
  put(path, ...handlers) { sharedPlaylistHandlers.set(path, handlers.at(-1)); },
  delete(path, ...handlers) { sharedPlaylistHandlers.set(path, handlers.at(-1)); },
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

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true, flows: [], sharedPlaylists: [] });
  downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a failed flow-delete enqueue restores active download work", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Delete queue rollback" });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-delete-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId")({ params: { flowId: flow.id }, user }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getFlow(flow.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }), true);
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-delete-token");
});

test("a failed flow-disable enqueue restores enabled state and active downloads", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Disable queue rollback", enabled: true });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `weeklyFlowOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-disable-token");
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  let ensureCalls = 0;
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => { ensureCalls += 1; });
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId/enabled")({
    params: { flowId: flow.id },
    body: { enabled: false },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, true);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }), true);
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-disable-token");
  assert.equal(ensureCalls, 2);
});

test("a successful flow disable reports the accepted cleanup operation", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Queued flow disable", enabled: true });
  const generation = activatePlaylistDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  let queuedPayload;
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async (payload) => {
    queuedPayload = payload;
    return { operationId: "disable-operation" };
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId/enabled")({
    params: { flowId: flow.id },
    body: { enabled: false },
    user,
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.queued, true);
  assert.equal(response.body.operationId, "disable-operation");
  assert.equal(queuedPayload.kind, "disable-flow-cleanup");
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(isPipelinePayloadActive({ jobId, playlistId: flow.id, playlistGeneration: generation }), false);
});

test("flow settings updates wait for in-progress playlist mutations", async (t) => {
  const user = { id: 1, role: "user" };
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: { lastfm: { apiKey: "test" } },
  });
  const flow = createFlow({ name: "Serialized flow settings" });
  flowPlaylistConfig.updateFlow(flow.id, { scheduleDays: [1] });
  let signalMutationEntered;
  let releaseMutation;
  const mutationEntered = new Promise((resolve) => { signalMutationEntered = resolve; });
  const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
  const mutation = mutationGuards.withPlaylistMutation(flow.id, async () => {
    signalMutationEntered();
    await mutationGate;
  }, { clearPending: false });
  let update;
  const response = createResponse();

  try {
    await mutationEntered;
    t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
    update = flowUpdateHandlers.get("/flows/:flowId")({
      params: { flowId: flow.id },
      body: { name: "Updated while serialized" },
      user,
    }, response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.body, null);
  } finally {
    releaseMutation();
    await Promise.allSettled([mutation, update].filter(Boolean));
  }

  assert.equal(response.statusCode, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).name, "Updated while serialized");
});

test("a failed shared-track delete enqueue clears only its new job-cancellation marker", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Track queue rollback",
    ownerUserId: user.id,
    tracks: [],
  });
  const generation = activatePlaylistDownloadGeneration(playlist.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await sharedPlaylistHandlers.get("/shared-playlists/:playlistId/tracks/:jobId")({
    params: { playlistId: playlist.id, jobId },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(downloadTracker.getJob(jobId));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: generation }), true);
});

test("a failed shared-playlist delete does not reactivate previously cancelled work", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Already cancelled playlist",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  cancelPlaylistDownloadGeneration(playlist.id);
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await sharedPlaylistHandlers.get("/shared-playlists/:playlistId")({
    params: { playlistId: playlist.id },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getSharedPlaylist(playlist.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: 0 }), false);
});

test("a failed track-delete enqueue preserves an existing job-cancellation marker", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Already cancelled track",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  cancelDownloadJob(jobId);
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await sharedPlaylistHandlers.get("/shared-playlists/:playlistId/tracks/:jobId")({
    params: { playlistId: playlist.id, jobId },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.equal(isDownloadJobCancelled(jobId), true);
});
