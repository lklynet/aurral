import { requireFixture } from "./fixtures.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
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
  { api },
  { getPlaylistStatusSnapshot },
  { playlistOperationQueue },
  { downloadTracker },
  cancellationModule,
] = await setupIsolatedBackend(
  "track-availability",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/playlists/playlistStatusSnapshot.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
);
const { activatePlaylistDownloadGeneration, isDownloadJobCancelled, isPipelinePayloadActive } =
  cancellationModule;

const flowUser = (id: number, role = "user") =>
  testUser(id, { role, permissions: { accessFlow: true } });

const updatePreference = async (
  preference: "track-availability" | "record-history",
  id: string,
  enabled: string | number | boolean | null | undefined,
  user: RequestUser,
) => {
  const response = await signedInAs(user)
    .route("/", api)
    .request(`/playlists/shared-playlists/${id}/${preference}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  return { status: response.status, body: await response.json() };
};
const updateAvailability = (
  id: string,
  enabled: string | number | boolean | null | undefined,
  user = flowUser(1),
) => updatePreference("track-availability", id, enabled, user);
const updateRecordHistory = (
  id: string,
  enabled: string | number | boolean | null | undefined,
  user = flowUser(1),
) => updatePreference("record-history", id, enabled, user);

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
  assert.equal((await updateAvailability(first.id, true)).status, 200);
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
  assert.equal((await updateAvailability(first.id, false)).body.showTrackAvailability, false);
});

test("availability validates input and respects playlist ownership", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Private", ownerUserId: 1 });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal((await updateAvailability(playlist.id, value)).status, 400);
  }
  assert.equal((await updateAvailability(playlist.id, true, flowUser(2))).status, 404);
  assert.equal((await updateAvailability("missing", true)).status, 404);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).showTrackAvailability,
    false,
  );
  assert.equal((await updateAvailability(playlist.id, true, flowUser(2, "admin"))).status, 200);
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
  assert.equal((await updateRecordHistory(first.id, false)).body.recordHistory, false);
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
  assert.equal((await updateRecordHistory(first.id, true)).body.recordHistory, true);
  assert.equal(requireFixture(flowPlaylistConfig.getStaticPlaylist(first.id)).recordHistory, true);
});

test("history preference validates input and respects playlist ownership", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Private History",
    ownerUserId: 1,
  });
  for (const value of ["true", 1, null, undefined]) {
    assert.equal((await updateRecordHistory(playlist.id, value)).status, 400);
  }
  assert.equal((await updateRecordHistory(playlist.id, false, flowUser(2))).status, 404);
  assert.equal((await updateRecordHistory("missing", false)).status, 404);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).recordHistory,
    true,
  );
  assert.equal((await updateRecordHistory(playlist.id, false, flowUser(2, "admin"))).status, 200);
});

test("a failed playlist-delete enqueue restores the active download generation", async () => {
  const user = flowUser(1);
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
  const response = await signedInAs(user)
    .route("/", api)
    .request(`/playlists/shared-playlists/${playlist.id}`, { method: "DELETE" });

  assert.equal(response.status, 500);
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
