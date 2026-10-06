import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig }, { registerStaticPlaylists }, { getPlaylistStatusSnapshot }, { playlistOperationQueue }, { downloadTracker }, cancellationModule] = await setupIsolatedBackend(
  "track-availability",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/routes/playlists/handlers/staticPlaylists.js",
  "backend/services/playlists/playlistStatusSnapshot.js",
  "backend/services/playlists/playlistOperationQueue.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadCancellation.js",
);
const { activateOwnerDownloadGeneration, isDownloadJobCancelled, isPipelinePayloadActive } = cancellationModule;

const handlers = new Map();
registerStaticPlaylists({
  get() {}, post() {},
  delete(path, handler) { handlers.set(path, handler); },
  put(path, handler) { handlers.set(path, handler); },
});
const updateAvailability = (id, enabled, user = { id: 1, role: "user" }) => {
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handlers.get("/static-playlists/:playlistId/track-availability")({
    params: { playlistId: id }, body: { enabled }, user,
  }, response);
  return response;
};
const updateRecordHistory = (id, enabled, user = { id: 1, role: "user" }) => {
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handlers.get("/static-playlists/:playlistId/record-history")({
    params: { playlistId: id }, body: { enabled }, user,
  }, response);
  return response;
};

test.beforeEach(() => {
  for (const playlist of flowPlaylistConfig.getStaticPlaylists()) {
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  }
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true, flows: [], staticPlaylists: [] });
});
test.after(async () => {
  db.close();
  await cleanupIsolatedState(state);
});

test("availability is opt-in, persists per playlist, and does not queue playback changes", async (t) => {
  t.mock.method(playlistOperationQueue, "enqueuePayload", () => { throw new Error("Display settings must not queue playback changes"); });
  const first = flowPlaylistConfig.createStaticPlaylist({ name: "First", ownerUserId: 1, tracks: [{ artistName: "Artist", trackName: "Song" }] });
  const second = flowPlaylistConfig.createStaticPlaylist({ name: "Second", ownerUserId: 1 });
  assert.equal(first.showTrackAvailability, false);
  assert.equal(second.showTrackAvailability, false);
  assert.equal(updateAvailability(first.id, true).statusCode, 200);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.id).showTrackAvailability, true);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(second.id).showTrackAvailability, false);
  assert.deepEqual(flowPlaylistConfig.getStaticPlaylist(first.id).tracks, first.tracks);
  assert.equal(dbOps.getSettings().staticPlaylists.find((p) => p.id === first.id).showTrackAvailability, true);
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/playlists/flowPlaylistConfig.js?availability-saved");
  assert.equal(reloaded.getStaticPlaylist(first.id).showTrackAvailability, true);
  assert.equal(reloaded.getStaticPlaylist(second.id).showTrackAvailability, false);
  flowPlaylistConfig.updateStaticPlaylist(first.id, { name: "Renamed" });
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.id).showTrackAvailability, true);
  const snapshot = getPlaylistStatusSnapshot({ user: { id: 1, role: "user" } });
  assert.equal(snapshot.staticPlaylists.find((p) => p.id === first.id).showTrackAvailability, true);
  assert.equal(snapshot.staticPlaylists.find((p) => p.id === second.id).showTrackAvailability, false);
  assert.equal(updateAvailability(first.id, false).body.showTrackAvailability, false);
});

test("availability validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Private", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateAvailability(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateAvailability("missing", true).statusCode, 404);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlist.id).showTrackAvailability, false);
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "admin" }).statusCode, 200);
});

test("history is enabled by default, persists per playlist, and does not queue playback changes", async (t) => {
  t.mock.method(playlistOperationQueue, "enqueuePayload", () => { throw new Error("History preferences must not queue downloads"); });
  const first = flowPlaylistConfig.createStaticPlaylist({ name: "History On", ownerUserId: 1 });
  const second = flowPlaylistConfig.createStaticPlaylist({ name: "History Off", ownerUserId: 1, recordHistory: false });

  assert.equal(first.recordHistory, true);
  assert.equal(second.recordHistory, false);
  assert.equal(updateRecordHistory(first.id, false).body.recordHistory, false);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.id).recordHistory, false);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(second.id).recordHistory, false);
  assert.equal(dbOps.getSettings().staticPlaylists.find((p) => p.id === first.id).recordHistory, false);

  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/playlists/flowPlaylistConfig.js?record-history-saved");
  assert.equal(reloaded.getStaticPlaylist(first.id).recordHistory, false);
  assert.equal(reloaded.getStaticPlaylist(second.id).recordHistory, false);
  const snapshot = getPlaylistStatusSnapshot({ user: { id: 1, role: "user" } });
  assert.equal(snapshot.staticPlaylists.find((p) => p.id === first.id).recordHistory, false);
  assert.equal(updateRecordHistory(first.id, true).body.recordHistory, true);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.id).recordHistory, true);
});

test("history preference validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Private History", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateRecordHistory(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateRecordHistory("missing", false).statusCode, 404);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlist.id).recordHistory, true);
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "admin" }).statusCode, 200);
});

test("a failed playlist-delete enqueue restores the active download generation", async (t) => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Delete Retry",
    ownerUserId: user.id,
    tracks: [],
  });
  const generation = activateOwnerDownloadGeneration(playlist.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => {
    throw new Error("queue unavailable");
  });
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  await handlers.get("/static-playlists/:playlistId")({
    params: { playlistId: playlist.id },
    user,
  }, response);

  assert.equal(response.statusCode, 500);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(isPipelinePayloadActive({ jobId, ownerId: playlist.id, ownerGeneration: generation }), true);
});

test("existing playlists without the preference start disabled after loading", async () => {
  dbOps.updateSettings({ staticPlaylists: [{ id: "legacy", name: "Existing", ownerUserId: 1, tracks: [] }] });
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/playlists/flowPlaylistConfig.js?availability-reload");
  assert.equal(reloaded.getStaticPlaylist("legacy").showTrackAvailability, false);
});

test("existing playlists without history preference start enabled after loading", async () => {
  dbOps.updateSettings({ staticPlaylists: [{ id: "legacy-history", name: "Existing", ownerUserId: 1, tracks: [] }] });
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/playlists/flowPlaylistConfig.js?history-reload");
  assert.equal(reloaded.getStaticPlaylist("legacy-history").recordHistory, true);
});
