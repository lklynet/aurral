import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig, invalidateFlowPlaylistConfigCache }, { downloadTracker }, { startPlaylistStatusBroadcasts }] =
  await setupIsolatedBackend(
    "status-broadcaster", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
    "backend/services/playlists/flowPlaylistConfig.js", "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/playlists/playlistStatusBroadcaster.js",
  );

class SocketTransport extends EventEmitter {
  clients = new Set();
  inspections = 0;

  connect(id, user, channels = ["playlists"]) {
    const client = { id, user, subscriptions: new Set(channels), messages: [] };
    this.clients.add(client);
    this.emit("subscriptions-changed");
    return client;
  }

  disconnect(client) {
    this.clients.delete(client);
    this.emit("subscriptions-changed");
  }

  getStats() {
    const channels = {};
    for (const client of this.clients) {
      for (const channel of client.subscriptions) channels[channel] = (channels[channel] || 0) + 1;
    }
    return { channels };
  }

  broadcastPerClient(channel, buildData) {
    this.inspections++;
    for (const client of this.clients) {
      if (!client.subscriptions.has(channel) && !client.subscriptions.has("*")) continue;
      const data = buildData(client);
      if (data) client.messages.push({ channel, ...data });
    }
  }
}

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  invalidateFlowPlaylistConfigCache();
});
test.after(() => cleanupIsolatedState(state));

function start(t, websocket) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const stop = startPlaylistStatusBroadcasts({ websocket });
  t.after(stop);
  return stop;
}

test("unchanged playlist subscribers avoid rebuilding their status", (t) => {
  flowPlaylistConfig.createStaticPlaylist({ name: "Large mix", tracks: Array.from({ length: 1000 }, (_, i) => ({ artistName: "Artist", trackName: `Track ${i}` })) });
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "admin" });
  start(t, socket);
  assert.equal(client.messages.length, 1);
  t.mock.timers.tick(4000);
  const inspections = socket.inspections;
  t.mock.timers.tick(60000);
  assert.equal(socket.inspections, inspections, "an unchanged status must not traverse or rebuild client payloads");
  assert.equal(client.messages.length, 1);
});

test("new and wildcard subscribers receive current status immediately with ownership intact", (t) => {
  const own = flowPlaylistConfig.createStaticPlaylist({ name: "Mine", ownerUserId: 1 });
  flowPlaylistConfig.createStaticPlaylist({ name: "Someone else's", ownerUserId: 2 });
  const socket = new SocketTransport();
  start(t, socket);
  const user = socket.connect("user", { id: 1, role: "user" });
  assert.deepEqual(user.messages[0]?.status.sharedPlaylists.map((playlist) => playlist.id), [own.id]);
  const admin = socket.connect("admin", { id: 3, role: "admin" }, ["*"]);
  assert.equal(admin.messages[0]?.status.sharedPlaylists.length, 2);
  assert.equal(user.messages.length, 1);
});

test("local and external commits refresh status and reconnects receive an unchanged snapshot", (t) => {
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  t.after(() => { process.env.NODE_ENV = previousMode; });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Original", ownerUserId: 1 });
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "user" });
  start(t, socket);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Waiting" }, playlist.id);
  t.mock.timers.tick(4000);
  assert.equal(client.messages.at(-1).status.sharedPlaylistStats[playlist.id].pending, 1);
  const external = new Database(state.dbPath);
  try {
    external.prepare("UPDATE playlist_download_jobs SET status = 'failed' WHERE id = ?").run(jobId);
    t.mock.timers.tick(4000);
    assert.equal(client.messages.at(-1).status.sharedPlaylistStats[playlist.id].failed, 1);
  } finally {
    external.close();
  }
  socket.disconnect(client);
  const inspections = socket.inspections;
  t.mock.timers.tick(60000);
  assert.equal(socket.inspections, inspections);
  const reconnected = socket.connect("second", { id: 1, role: "user" });
  assert.equal(reconnected.messages[0]?.status.sharedPlaylistStats[playlist.id].failed, 1);
});

test("completed flow countdowns advance without a database write", (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Scheduled mix" });
  dbOps.updateSettings({ flows: [{ ...flow, enabled: true, nextRunAt: Date.now() + 120000 }] });
  invalidateFlowPlaylistConfigCache();
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Finished" }, flow.id);
  downloadTracker.setFailed(jobId, "No match");
  const socket = new SocketTransport();
  const client = socket.connect("first", { id: 1, role: "admin" });
  start(t, socket);
  assert.equal(client.messages.at(-1).status.hint.message, "Next update in 2 minutes");
  t.mock.timers.tick(60000);
  assert.equal(client.messages.at(-1).status.hint.message, "Next update in 1 minute");
  t.mock.timers.tick(60000);
  assert.equal(client.messages.at(-1).status.hint.message, "Next update soon");
});

test("download owner heartbeats and retirement refresh transient status without database writes", () => {
  const probe = fileURLToPath(new URL("../fixtures/playlist-status-owner-probe.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
