import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { dbOps }, { flowPlaylistConfig }, { downloadTracker }, { processOrchestratorJob }, guards, cancellation] = await setupIsolatedBackend(
  "download-mutation-lock", "backend/db/helpers/index.js", "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadTracker.js", "backend/services/slskdOrchestratorWorker.js",
  "backend/services/downloadJobs/mutationGuards.js", "backend/services/downloadJobs/downloadCancellation.js",
);
test.after(() => cleanupIsolatedState(state));
const deferred = () => Promise.withResolvers();

test("playlist mutation waits for the active provider stage before changing ownership", async () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Owner" });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, playlist.id);
  const started = deferred();
  const release = deferred();
  const processing = processOrchestratorJob({ jobId, playlistId: playlist.id, playlistGeneration: 0 }, {
    async processPipelinePayload() { started.resolve(); await release.promise; return null; },
    async continuePipeline() {},
  });
  await started.promise;
  let mutated = false;
  const mutation = guards.withPlaylistMutationLock(playlist.id, () => { mutated = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(mutated, false);
  } finally {
    release.resolve();
    await processing;
    await mutation;
  }
  assert.equal(mutated, true);
});

test("pipeline commit can reuse a live playlist lock", { timeout: 2000 }, async () => {
  const result = await guards.withPlaylistMutationLock("nested", () => cancellation.withPipelineCommitLock({ playlistId: "nested", playlistGeneration: 0 }, () => "committed"));
  assert.deepEqual(result, { cancelled: false, result: "committed" });
});

test("an escaped async context cannot reuse a released lease", async () => {
  const escaped = deferred();
  const release = deferred();
  let delayed;
  await guards.withPlaylistMutationLock("lease", async () => {
    delayed = escaped.promise.then(() => guards.withPlaylistMutationLock("lease", () => "late"));
  });
  const entered = deferred();
  const holder = guards.withPlaylistMutationLock("lease", async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let completed = false;
  delayed.then(() => { completed = true; });
  escaped.resolve();
  await new Promise(setImmediate);
  assert.equal(completed, false);
  release.resolve();
  await holder;
  assert.equal(await delayed, "late");
});

test("a provider stage that needs another playlist lock fails instead of running again", { timeout: 2000 }, async () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Stage owner" });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Stage track" }, playlist.id);
  let runs = 0;
  await assert.rejects(processOrchestratorJob({ jobId, playlistId: playlist.id, playlistGeneration: 0 }, {
    async processPipelinePayload() {
      runs++;
      if (runs > 1) throw new Error("provider stage ran again");
      return guards.withPlaylistMutationLock("unlocked-playlist", () => null);
    },
    async continuePipeline() {},
  }), (error) => error.code === "DOWNLOAD_LOCK_SET_CHANGED");
  assert.equal(runs, 1);
});
