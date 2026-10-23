import { requireFixture, captureRoutes, mockResponse } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { registerStaticPlaylists },
  { getPlaylistStatusSnapshot },
  { playlistOperationQueue },
  { downloadTracker },
  cancellationModule,
] = await setupIsolatedBackend(
  "track-availability",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/routes/playlists/handlers/staticPlaylists.ts"),
  () => import("../../backend/services/playlists/playlistStatusSnapshot.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
);
const { activatePlaylistDownloadGeneration, isDownloadJobCancelled, isPipelinePayloadActive } =
  cancellationModule;

const { handlers, router } = captureRoutes();
registerStaticPlaylists(router);
const updateAvailability = (
  id: string,
  enabled: string | number | boolean | null | undefined,
  user: { id: number; role: string } = { id: 1, role: "user" },
) => {
  const response = mockResponse<{ showTrackAvailability: boolean; recordHistory: boolean }>();
  requireFixture(handlers.get("/shared-playlists/:playlistId/track-availability"))(
    {
      params: { playlistId: id },
      body: { enabled },
      user,
    },
    response,
  );
  return response;
};
const updateRecordHistory = (
  id: string,
  enabled: string | number | boolean | null | undefined,
  user: { id: number; role: string } = { id: 1, role: "user" },
) => {
  const response = mockResponse<{ showTrackAvailability: boolean; recordHistory: boolean }>();
  requireFixture(handlers.get("/shared-playlists/:playlistId/record-history"))(
    {
      params: { playlistId: id },
      body: { enabled },
      user,
    },
    response,
  );
  return response;
};

beforeEach(() => {
  for (const playlist of flowPlaylistConfig.getStaticPlaylists()) {
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  }
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});
afterAll(async () => {
  db.close();
  await cleanupIsolatedState(state);
});

test("availability is opt-in, persists per playlist, and does not queue playback changes", async () => {
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(() => {
    throw new Error("Display settings must not queue playback changes");
  });
  const first = flowPlaylistConfig.createStaticPlaylist({
    name: "First",
    ownerUserId: 1,
    tracks: [{ artistName: "Artist", trackName: "Song" }],
  });
  const second = flowPlaylistConfig.createStaticPlaylist({ name: "Second", ownerUserId: 1 });
  assert.equal(first.showTrackAvailability, false);
  assert.equal(second.showTrackAvailability, false);
  assert.equal(updateAvailability(first.id, true).statusCode, 200);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).showTrackAvailability,
    true,
  );
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(second.id)).showTrackAvailability,
    false,
  );
  assert.deepEqual(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).tracks,
    first.tracks,
  );
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylists().find((p) => p.id === first.id))
      .showTrackAvailability,
    true,
  );
  vi.resetModules();
  const { flowPlaylistConfig: reloaded } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  assert.equal(requireFixture(reloaded.getStaticPlaylist(first.id)).showTrackAvailability, true);
  assert.equal(requireFixture(reloaded.getStaticPlaylist(second.id)).showTrackAvailability, false);
  flowPlaylistConfig.updateStaticPlaylist(first.id, { name: "Renamed" });
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).showTrackAvailability,
    true,
  );
  const snapshot = getPlaylistStatusSnapshot({
    user: { id: 1, role: "user", username: "test", permissions: {} },
  });
  assert.equal(
    requireFixture(snapshot.sharedPlaylists.find((p) => p.id === first.id)).showTrackAvailability,
    true,
  );
  assert.equal(
    requireFixture(snapshot.sharedPlaylists.find((p) => p.id === second.id)).showTrackAvailability,
    false,
  );
  assert.equal(
    requireFixture(updateAvailability(first.id, false)).body.showTrackAvailability,
    false,
  );
});

test("availability validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Private", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateAvailability(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateAvailability("missing", true).statusCode, 404);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).showTrackAvailability,
    false,
  );
  assert.equal(updateAvailability(playlist.id, true, { id: 2, role: "admin" }).statusCode, 200);
});

test("history is enabled by default, persists per playlist, and does not queue playback changes", async () => {
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(() => {
    throw new Error("History preferences must not queue downloads");
  });
  const first = flowPlaylistConfig.createStaticPlaylist({ name: "History On", ownerUserId: 1 });
  const second = flowPlaylistConfig.createStaticPlaylist({
    name: "History Off",
    ownerUserId: 1,
    recordHistory: false,
  });

  assert.equal(first.recordHistory, true);
  assert.equal(second.recordHistory, false);
  assert.equal(requireFixture(updateRecordHistory(first.id, false)).body.recordHistory, false);
  assert.equal(requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).recordHistory, false);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(second.id)).recordHistory,
    false,
  );
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylists().find((p) => p.id === first.id))
      .recordHistory,
    false,
  );

  vi.resetModules();
  const { flowPlaylistConfig: reloaded } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  assert.equal(requireFixture(reloaded.getStaticPlaylist(first.id)).recordHistory, false);
  assert.equal(requireFixture(reloaded.getStaticPlaylist(second.id)).recordHistory, false);
  const snapshot = getPlaylistStatusSnapshot({
    user: { id: 1, role: "user", username: "test", permissions: {} },
  });
  assert.equal(
    requireFixture(snapshot.sharedPlaylists.find((p) => p.id === first.id)).recordHistory,
    false,
  );
  assert.equal(requireFixture(updateRecordHistory(first.id, true)).body.recordHistory, true);
  assert.equal(requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).recordHistory, true);
});

test("history preference validates input and respects playlist ownership", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Private History",
    ownerUserId: 1,
  });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal(updateRecordHistory(playlist.id, value).statusCode, 400);
  }
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "user" }).statusCode, 404);
  assert.equal(updateRecordHistory("missing", false).statusCode, 404);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).recordHistory,
    true,
  );
  assert.equal(updateRecordHistory(playlist.id, false, { id: 2, role: "admin" }).statusCode, 200);
});

test("a failed playlist-delete enqueue restores the active download generation", async () => {
  const user = { id: 1, role: "user" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Delete Retry",
    ownerUserId: user.id,
    tracks: [],
  });
  const generation = activatePlaylistDownloadGeneration(playlist.id);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlist.id);
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => {
    throw new Error("queue unavailable");
  });
  const response = mockResponse<{ showTrackAvailability: boolean; recordHistory: boolean }>();

  await requireFixture(handlers.get("/shared-playlists/:playlistId"))(
    {
      params: { playlistId: playlist.id },
      user,
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId: playlist.id, playlistGeneration: generation }),
    true,
  );
});

test("existing playlists without the preference start disabled after loading", async () => {
  dbOps.updateSettings({
    sharedPlaylists: [{ id: "legacy", name: "Existing", ownerUserId: 1, tracks: [] }],
  });
  vi.resetModules();
  const { flowPlaylistConfig: reloaded } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  assert.equal(requireFixture(reloaded.getStaticPlaylist("legacy")).showTrackAvailability, false);
});

test("existing playlists without history preference start enabled after loading", async () => {
  dbOps.updateSettings({
    sharedPlaylists: [{ id: "legacy-history", name: "Existing", ownerUserId: 1, tracks: [] }],
  });
  vi.resetModules();
  const { flowPlaylistConfig: reloaded } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  assert.equal(requireFixture(reloaded.getStaticPlaylist("legacy-history")).recordHistory, true);
});
