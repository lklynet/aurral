import assert from "node:assert/strict";
import { mock } from "node:test";
import { createIsolatedStateDir, applyIsolatedBackendEnv, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const state = await createIsolatedStateDir("playlist-owner-status");
applyIsolatedBackendEnv(state);
process.env.NODE_ENV = "production";
const [{ dbOps }, owner, { getDatabaseRevision }, { websocketService }, { startPlaylistStatusBroadcasts }] = await Promise.all([
  import("../../backend/db/helpers/index.ts"),
  import("../../backend/services/downloadJobs/downloadOwnerClient.ts"),
  import("../../backend/config/db-sqlite.ts"),
  import("../../backend/services/websocketService.ts"),
  import("../../backend/services/playlists/playlistStatusBroadcaster.ts"),
]);
dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
type OwnerStatus = NonNullable<ReturnType<Parameters<typeof owner.configureDownloadOwnerClient>[0]["getStatus"]>>;
type Client = Parameters<typeof websocketService.clients.add>[0];
type StatusMessage = { status: { hint: { phase: string }; worker: { currentJob: { id: string } | null } } };
let status: OwnerStatus | null = null;
owner.configureDownloadOwnerClient({ request: () => Promise.reject(new Error("unused")), getStatus: () => status });
const messages: StatusMessage[] = [];
const client: Client = {
  id: "owner-probe",
  user: { id: 1, role: "admin" } as NonNullable<Client["user"]>,
  authSource: "session",
  connectedAt: Date.now(),
  subscriptions: new Set(["playlists"]),
  ws: { readyState: 1, send: (message: string) => messages.push(JSON.parse(message)) } as unknown as Client["ws"],
};
websocketService.clients.add(client);
mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
const stop = startPlaylistStatusBroadcasts();
try {
  const revision = getDatabaseRevision();
  status = { running: true, processing: true, activeCount: 1, currentJob: { id: "disposable-progress" } } as OwnerStatus;
  mock.timers.tick(4000);
  assert.equal(messages.at(-1)?.status.hint.phase, "downloading");
  assert.equal(messages.at(-1)?.status.worker.currentJob?.id, "disposable-progress");
  status = { ...status, processing: false, operationWorker: { running: true, currentLabel: "scheduled:mix" } };
  mock.timers.tick(4000);
  assert.equal(messages.at(-1)?.status.hint.phase, "preparing");
  status = null;
  mock.timers.tick(4000);
  assert.equal(messages.at(-1)?.status.hint.phase, "idle");
  assert.equal(messages.at(-1)?.status.worker.currentJob, null);
  assert.equal(getDatabaseRevision(), revision, "transient updates must not require database changes");
} finally {
  stop();
  websocketService.clients.clear();
  mock.timers.reset();
  await cleanupIsolatedState(state);
}
process.exit(0);
