import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig }, { registerSharedPlaylists }, { getWeeklyFlowStatusSnapshot }, { weeklyFlowOperationQueue }] = await setupIsolatedBackend(
  "track-availability",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/routes/weeklyFlow/handlers/sharedPlaylists.js",
  "backend/services/weeklyFlow/weeklyFlowStatusSnapshot.js",
  "backend/services/weeklyFlow/weeklyFlowOperationQueue.js",
);

const handlers = new Map();
registerSharedPlaylists({
  get() {}, post() {}, delete() {},
  put(path, handler) { handlers.set(path, handler); },
});
const updateAvailability = (id, enabled, user = { id: 1, role: "user" }) => {
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handlers.get("/shared-playlists/:playlistId/track-availability")({
    params: { playlistId: id }, body: { enabled }, user,
  }, response);
  return response;
};
const updateRecordHistory = (id, enabled, user = { id: 1, role: "user" }) => {
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handlers.get("/shared-playlists/:playlistId/record-history")({
    params: { playlistId: id }, body: { enabled }, user,
  }, response);
  return response;
};

test.beforeEach(() => {
  for (const playlist of flowPlaylistConfig.getSharedPlaylists()) {
    flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
  }
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true, flows: [], sharedPlaylists: [] });
});
test.after(async () => {
  db.close();
  await cleanupIsolatedState(state);
});

test("availability is opt-in, persists per playlist, and does not queue playback changes", async (t) => {
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", () => { throw new Error("Display settings must not queue playback changes"); });
  const first = flowPlaylistConfig.createSharedPlaylist({ name: "First", ownerUserId: 1, tracks: [{ artistName: "Artist", trackName: "Song" }] });
  const second = flowPlaylistConfig.createSharedPlaylist({ name: "Second", ownerUserId: 1 });
  assert.equal(first.showTrackAvailability, false);
  assert.equal(second.showTrackAvailability, false);
  assert.equal(updateAvailability(first.id, true).statusCode, 200);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(first.id).showTrackAvailability, true);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(second.id).showTrackAvailability, false);
  assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(first.id).tracks, first.tracks);
  assert.equal(dbOps.getSettings().sharedPlaylists.find((p) => p.id === first.id).showTrackAvailability, true);
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js?availability-saved");
  assert.equal(reloaded.getSharedPlaylist(first.id).showTrackAvailability, true);
  assert.equal(reloaded.getSharedPlaylist(second.id).showTrackAvailability, false);
  flowPlaylistConfig.updateSharedPlaylist(first.id, { name: "Renamed" });
  assert.equal(flowPlaylistConfig.getSharedPlaylist(first.id).showTrackAvailability, true);
  const snapshot = getWeeklyFlowStatusSnapshot({ user: { id: 1, role: "user" } });
  assert.equal(snapshot.sharedPlaylists.find((p) => p.id === first.id).showTrackAvailability, true);
  assert.equal(snapshot.sharedPlaylists.find((p) => p.id === second.id).showTrackAvailability, false);
  assert.equal(updateAvailability(first.id, false).body.showTrackAvailability, false);
});

test("availability validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Private", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateAvailability(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateAvailability("missing", true).statusCode, 404);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(playlist.id).showTrackAvailability, false);
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "admin" }).statusCode, 200);
});

test("history is enabled by default, persists per playlist, and does not queue playback changes", async (t) => {
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", () => { throw new Error("History preferences must not queue downloads"); });
  const first = flowPlaylistConfig.createSharedPlaylist({ name: "History On", ownerUserId: 1 });
  const second = flowPlaylistConfig.createSharedPlaylist({ name: "History Off", ownerUserId: 1, recordHistory: false });

  assert.equal(first.recordHistory, true);
  assert.equal(second.recordHistory, false);
  assert.equal(updateRecordHistory(first.id, false).body.recordHistory, false);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(first.id).recordHistory, false);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(second.id).recordHistory, false);
  assert.equal(dbOps.getSettings().sharedPlaylists.find((p) => p.id === first.id).recordHistory, false);

  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js?record-history-saved");
  assert.equal(reloaded.getSharedPlaylist(first.id).recordHistory, false);
  assert.equal(reloaded.getSharedPlaylist(second.id).recordHistory, false);
  const snapshot = getWeeklyFlowStatusSnapshot({ user: { id: 1, role: "user" } });
  assert.equal(snapshot.sharedPlaylists.find((p) => p.id === first.id).recordHistory, false);
  assert.equal(updateRecordHistory(first.id, true).body.recordHistory, true);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(first.id).recordHistory, true);
});

test("history preference validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Private History", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateRecordHistory(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateRecordHistory("missing", false).statusCode, 404);
  assert.equal(flowPlaylistConfig.getSharedPlaylist(playlist.id).recordHistory, true);
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "admin" }).statusCode, 200);
});

test("existing playlists without the preference start disabled after loading", async () => {
  dbOps.updateSettings({ sharedPlaylists: [{ id: "legacy", name: "Existing", ownerUserId: 1, tracks: [] }] });
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js?availability-reload");
  assert.equal(reloaded.getSharedPlaylist("legacy").showTrackAvailability, false);
});

test("existing playlists without history preference start enabled after loading", async () => {
  dbOps.updateSettings({ sharedPlaylists: [{ id: "legacy-history", name: "Existing", ownerUserId: 1, tracks: [] }] });
  const { flowPlaylistConfig: reloaded } = await import("../../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js?history-reload");
  assert.equal(reloaded.getSharedPlaylist("legacy-history").recordHistory, true);
});
