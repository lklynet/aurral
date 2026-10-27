import { testWebSocketClient } from "../helpers/userFixtures.ts";
import { requireFixture } from "./fixtures.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import Database from "better-sqlite3";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { downloadTracker },
  { startPlaylistStatusBroadcasts },
  { setPlaylistArtworkState, getPlaylistArtworkState },
] = await setupIsolatedBackend(
  "status-broadcaster",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistStatusBroadcaster.ts"),
  () => import("../../backend/services/playlistArtworkState.ts"),
);

type StatusMessage = {
  type: string;
  status: ReturnType<
    typeof import("../../backend/services/playlists/playlistStatusSnapshot.ts").getPlaylistStatusSnapshot
  >;
};
type Client = ReturnType<typeof testWebSocketClient> & {
  messages: ({ channel: string } & StatusMessage)[];
};
class SocketTransport extends EventEmitter {
  clients = new Set<Client>();
  inspections = 0;

  connect(id: string, user: { id: number; role: string }, channels: string[] = ["playlists"]) {
    const client: Client = Object.assign(
      testWebSocketClient(user.id, channels, () => {}),
      {
        id,
        messages: [],
      },
    );
    client.user!.role = user.role;
    this.clients.add(client);
    this.emit("subscriptions-changed");
    return client;
  }

  disconnect(client: Client) {
    this.clients.delete(client);
    this.emit("subscriptions-changed");
  }

  getStats() {
    const channels: Record<string, number> = {};
    for (const client of this.clients) {
      for (const channel of client.subscriptions) channels[channel] = (channels[channel] || 0) + 1;
    }
    return { channels };
  }

  broadcastPerClient(channel: string, buildData: (client: Client) => StatusMessage | null) {
    this.inspections++;
    for (const client of this.clients) {
      if (!client.subscriptions.has(channel) && !client.subscriptions.has("*")) continue;
      const data = buildData(client);
      if (data) client.messages.push({ channel, ...data });
    }
  }
}

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  invalidateFlowPlaylistConfigCache();
});
afterAll(() => cleanupIsolatedState(state));

function start(t: import("vite-plus/test").TestContext, websocket: SocketTransport) {
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    now: Date.now(),
  });
  const stop = startPlaylistStatusBroadcasts({
    websocket: websocket as unknown as NonNullable<
      Parameters<typeof startPlaylistStatusBroadcasts>[0]
    >["websocket"],
  });
  t.onTestFinished(stop);
  return stop;
}

test("unchanged playlist subscribers avoid rebuilding their status", (t) => {
  flowPlaylistConfig.createStaticPlaylist({
    name: "Large mix",
    tracks: Array.from({ length: 1000 }, (_, i) => ({
      artistName: "Artist",
      trackName: `Track ${i}`,
    })),
  });
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "admin" });
  start(t, socket);
  assert.equal(client.messages.length, 1);
  vi.advanceTimersByTime(4000);
  const inspections = socket.inspections;
  vi.advanceTimersByTime(60000);
  assert.equal(
    socket.inspections,
    inspections,
    "an unchanged status must not traverse or rebuild client payloads",
  );
  assert.equal(client.messages.length, 1);
});

test("new and wildcard subscribers receive current status immediately with ownership intact", (t) => {
  const own = flowPlaylistConfig.createStaticPlaylist({ name: "Mine", ownerUserId: 1 });
  flowPlaylistConfig.createStaticPlaylist({ name: "Someone else's", ownerUserId: 2 });
  const socket = new SocketTransport();
  start(t, socket);
  const user = socket.connect("user", { id: 1, role: "user" });
  assert.deepEqual(
    user.messages[0]?.status.sharedPlaylists.map((playlist) => playlist.id),
    [own.id],
  );
  const admin = socket.connect("admin", { id: 3, role: "admin" }, ["*"]);
  assert.equal(admin.messages[0]?.status.sharedPlaylists.length, 2);
  assert.equal(user.messages.length, 1);
});

test("local and external commits refresh status and reconnects receive an unchanged snapshot", (t: import("vite-plus/test").TestContext) => {
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  t.onTestFinished(() => {
    process.env.NODE_ENV = previousMode;
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Original", ownerUserId: 1 });
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "user" });
  start(t, socket);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Waiting" }, playlist.id);
  vi.advanceTimersByTime(4000);
  assert.equal(
    requireFixture(requireFixture(client).messages.at(-1)).status.sharedPlaylistStats[playlist.id]
      .pending,
    1,
  );
  const external = new Database(state.dbPath);
  try {
    external.prepare("UPDATE playlist_download_jobs SET status = 'failed' WHERE id = ?").run(jobId);
    vi.advanceTimersByTime(4000);
    assert.equal(
      requireFixture(requireFixture(client).messages.at(-1)).status.sharedPlaylistStats[playlist.id]
        .failed,
      1,
    );
  } finally {
    external.close();
  }
  socket.disconnect(client);
  const inspections = socket.inspections;
  vi.advanceTimersByTime(60000);
  assert.equal(socket.inspections, inspections);
  const reconnected = socket.connect("second", { id: 1, role: "user" });
  assert.equal(reconnected.messages[0]?.status.sharedPlaylistStats[playlist.id].failed, 1);
});

test("completed flow countdowns advance without a database write", (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Scheduled mix" });
  dbOps.updateSettings({ flows: [{ ...flow, enabled: true, nextRunAt: Date.now() + 120000 }] });
  invalidateFlowPlaylistConfigCache();
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Finished" }, flow.id);
  assert.ok(jobId != null);
  downloadTracker.setFailed(jobId, "No match");
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "admin" });
  start(t, socket);
  assert.equal(
    requireFixture(requireFixture(client).messages.at(-1)).status.hint.message,
    "Next update in 2 minutes",
  );
  vi.advanceTimersByTime(60000);
  assert.equal(
    requireFixture(requireFixture(client).messages.at(-1)).status.hint.message,
    "Next update in 1 minute",
  );
  vi.advanceTimersByTime(60000);
  assert.equal(
    requireFixture(requireFixture(client).messages.at(-1)).status.hint.message,
    "Next update soon",
  );
});

test("download owner heartbeats and retirement refresh transient status without database writes", () => {
  const probe = fileURLToPath(
    new URL("../fixtures/playlist-status-owner-probe.mts", import.meta.url),
  );
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("each user's countdown advances while the globally earliest countdown stays unchanged", (t) => {
  const first = flowPlaylistConfig.createFlow({ name: "Earlier mix", ownerUserId: 1 });
  const second = flowPlaylistConfig.createFlow({ name: "Later mix", ownerUserId: 2 });
  dbOps.updateSettings({
    flows: [
      { ...first, enabled: true, nextRunAt: Date.now() + 15000 },
      { ...second, enabled: true, nextRunAt: Date.now() + 65000 },
    ],
  });
  invalidateFlowPlaylistConfigCache();
  for (const flow of [first, second]) {
    const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Finished" }, flow.id);
    assert.ok(jobId != null);
    downloadTracker.setFailed(jobId, "No match");
  }
  const socket = new SocketTransport();
  const earlierUser = socket.connect("earlier", { id: 1, role: "user" });
  const laterUser = socket.connect("later", { id: 2, role: "user" });
  start(t, socket);
  vi.advanceTimersByTime(4000);
  assert.equal(
    requireFixture(requireFixture(earlierUser).messages.at(-1)).status.hint.message,
    "Next update in 1 minute",
  );
  assert.equal(
    requireFixture(requireFixture(laterUser).messages.at(-1)).status.hint.message,
    "Next update in 2 minutes",
  );
  vi.advanceTimersByTime(4000);
  assert.equal(
    requireFixture(requireFixture(earlierUser).messages.at(-1)).status.hint.message,
    "Next update in 1 minute",
  );
  assert.equal(
    requireFixture(requireFixture(laterUser).messages.at(-1)).status.hint.message,
    "Next update in 1 minute",
  );
});

test("saved cover changes reach connected clients through playlist status", (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Rotating cover", ownerUserId: 1 });
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "user" });
  start(t, socket);
  const cover = {
    mode: "artist",
    artistKey: "artist",
    template: "a1",
    sourceUrl: null,
    fallbackSignature: null,
  } as const;
  setPlaylistArtworkState(flow.id, cover);
  vi.advanceTimersByTime(4000);
  const firstRevision = client.messages
    .at(-1)
    ?.status.flows.find((entry) => entry.id === flow.id)?.artworkRevision;
  assert.equal(firstRevision, getPlaylistArtworkState(flow.id)?.revision);
  setPlaylistArtworkState(flow.id, { ...cover, template: "a2" });
  vi.advanceTimersByTime(4000);
  const nextRevision = client.messages
    .at(-1)
    ?.status.flows.find((entry) => entry.id === flow.id)?.artworkRevision;
  assert.ok(firstRevision && nextRevision && nextRevision > firstRevision);
});
