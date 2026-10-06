import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { registerFlows },
  { registerStaticPlaylists },
  { playlistOperationQueue },
  { downloadTracker },
  { playlistManager },
  mutationGuards,
  cancellation,
] = await setupIsolatedBackend(
  "cancellation-enqueue",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/routes/playlists/handlers/flows.js",
  "backend/routes/playlists/handlers/staticPlaylists.js",
  "backend/services/playlists/playlistOperationQueue.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/downloadJobs/mutationGuards.js",
  "backend/services/downloadJobs/downloadCancellation.js",
);
const {
  activateOwnerDownloadGeneration,
  cancelDownloadJob,
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

const staticPlaylistHandlers = new Map();
registerStaticPlaylists({
  get() {},
  post() {},
  put(path, ...handlers) { staticPlaylistHandlers.set(path, handlers.at(-1)); },
  delete(path, ...handlers) { staticPlaylistHandlers.set(path, handlers.at(-1)); },
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
  invalidateFlowPlaylistConfigCache();
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true, flows: [], staticPlaylists: [] });
  downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a failed flow-delete enqueue restores active download work", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Delete queue rollback" });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `playlistOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-delete-token");
  const generation = activateOwnerDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await flowHandlers.get("/flows/:flowId")({ params: { flowId: flow.id }, user }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getFlow(flow.id));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: flow.id, ownerGeneration: generation }), true);
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-delete-token");
});

test("a failed flow-disable enqueue restores enabled state and active downloads", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Disable queue rollback", enabled: true });
  const tokenScope = `flow:${flow.id}:mutation`;
  const tokenKey = `playlistOperationTokens:${encodeURIComponent(tokenScope)}`;
  dbOps.setJSONSetting(tokenKey, "previous-disable-token");
  const generation = activateOwnerDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  let ensureCalls = 0;
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => { ensureCalls += 1; });
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
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
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: flow.id, ownerGeneration: generation }), true);
  assert.equal(dbOps.getJSONSetting(tokenKey), "previous-disable-token");
  assert.equal(ensureCalls, 2);
});

test("a failed flow disable does not undo a later disable", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Overlapping flow disables", enabled: true });
  const generation = activateOwnerDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  let signalFirstEnsure;
  let failFirstEnsure;
  const firstEnsureStarted = new Promise((resolve) => { signalFirstEnsure = resolve; });
  const firstEnsure = new Promise((resolve, reject) => { failFirstEnsure = reject; });
  let ensureCalls = 0;
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {
    ensureCalls += 1;
    if (ensureCalls === 1) {
      signalFirstEnsure();
      return firstEnsure;
    }
  });
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => ({
    operationId: "later-disable-operation",
  }));
  const disable = (response) => flowHandlers.get("/flows/:flowId/enabled")({
    params: { flowId: flow.id },
    body: { enabled: false },
    user,
  }, response);
  const firstResponse = createResponse();
  const secondResponse = createResponse();

  const first = disable(firstResponse);
  await firstEnsureStarted;
  await disable(secondResponse);
  failFirstEnsure(new Error("smart playlists unavailable"));
  await first;

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).enabled, false);
  assert.equal(isDownloadJobCancelled(jobId), true);
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: flow.id, ownerGeneration: generation }), false);
});

test("a successful flow disable reports the accepted cleanup operation", async (t) => {
  const user = { id: 1, role: "user" };
  const flow = createFlow({ name: "Queued flow disable", enabled: true });
  const generation = activateOwnerDownloadGeneration(flow.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, flow.id);
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  let queuedPayload;
  t.mock.method(playlistOperationQueue, "enqueuePayload", async (payload) => {
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
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: flow.id, ownerGeneration: generation }), false);
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
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Track queue rollback",
    ownerUserId: user.id,
    tracks: [],
  });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Artist", trackName: "Song" },
  ]);
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/static-playlists/:playlistId/tracks/:jobId")({
    params: { playlistId: playlist.id, jobId },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(downloadTracker.getJob(jobId));
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: "library", ownerGeneration: 0 }), true);
});

test("a failed static playlist delete restores only the downloads it cancelled", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled playlist",
    ownerUserId: user.id,
    tracks: [],
  });
  const [cancelledJobId, activeJobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Artist", trackName: "Cancelled" },
    { artistName: "Artist", trackName: "Active" },
  ]);
  cancelDownloadJob(cancelledJobId);
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/static-playlists/:playlistId")({
    params: { playlistId: playlist.id },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.ok(flowPlaylistConfig.getStaticPlaylist(playlist.id));
  assert.equal(isDownloadJobCancelled(cancelledJobId), true);
  assert.equal(isDownloadJobCancelled(activeJobId), false);
});

test("a failed track-delete enqueue preserves an existing job-cancellation marker", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Already cancelled track",
    ownerUserId: user.id,
    tracks: [],
  });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Artist", trackName: "Song" },
  ]);
  cancelDownloadJob(jobId);
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = createResponse();

  await staticPlaylistHandlers.get("/static-playlists/:playlistId/tracks/:jobId")({
    params: { playlistId: playlist.id, jobId },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.equal(isDownloadJobCancelled(jobId), true);
});
