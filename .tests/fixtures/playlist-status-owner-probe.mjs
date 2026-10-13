import assert from "node:assert/strict";
import { mock } from "node:test";
import { createIsolatedStateDir, applyIsolatedBackendEnv, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const state = await createIsolatedStateDir("playlist-owner-status");
applyIsolatedBackendEnv(state);
process.env.NODE_ENV = "production";
const [{ dbOps }, owner, { getDatabaseRevision }, { websocketService }, { startPlaylistStatusBroadcasts }] = await Promise.all([
  import("../../backend/db/helpers/index.js"),
  import("../../backend/services/downloadJobs/downloadOwnerClient.js"),
  import("../../backend/config/db-sqlite.js"),
  import("../../backend/services/websocketService.js"),
  import("../../backend/services/playlists/playlistStatusBroadcaster.js"),
]);
dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
let status = null;
owner.configureDownloadOwnerClient({ getStatus: () => status });
const messages = [];
const client = { id: "owner-probe", user: { id: 1, role: "admin" }, subscriptions: new Set(["playlists"]), ws: { readyState: 1, send: (message) => messages.push(JSON.parse(message)) } };
websocketService.clients.add(client);
mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
const stop = startPlaylistStatusBroadcasts();
try {
  const revision = getDatabaseRevision();
  status = { running: true, processing: true, activeCount: 1, currentJob: { id: "disposable-progress" } };
  mock.timers.tick(4000);
  assert.equal(messages.at(-1).status.hint.phase, "downloading");
  assert.equal(messages.at(-1).status.worker.currentJob.id, "disposable-progress");
  status = { ...status, processing: false, operationWorker: { running: true, currentLabel: "scheduled:mix" } };
  mock.timers.tick(4000);
  assert.equal(messages.at(-1).status.hint.phase, "preparing");
  status = null;
  mock.timers.tick(4000);
  assert.equal(messages.at(-1).status.hint.phase, "idle");
  assert.equal(messages.at(-1).status.worker.currentJob, null);
  assert.equal(getDatabaseRevision(), revision, "transient updates must not require database changes");
} finally {
  stop();
  websocketService.clients.clear();
  mock.timers.reset();
  await cleanupIsolatedState(state);
}
process.exit(0);
