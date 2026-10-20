import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.js";
import { callFromProcessesWhileHonkerLocked } from "../helpers/playlistManagerCallers.js";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
const [state, { db }, { dbOps }, honker, { playlistManager, PlaylistManager }, { processSystemTask },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache }, { downloadTracker }, { registerFlows }, { JellyfinClient },
  { processPlaylistOperation }, { PlexClient }, { navidromePlaylistPointerStore }] = await setupIsolatedBackend(
  "playlist-sync-job", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/honkerDb.js", "backend/services/playlists/playlistManager.js",
  "backend/services/systemTaskWorker.js", "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadTracker.js", "backend/routes/playlists/handlers/flows.js",
  "backend/services/jellyfin.js", "backend/services/playlists/playlistOperations.js",
  "backend/services/plex.js", "backend/services/navidrome/navidromePlaylistPointerStore.js",
);

const downloadRoot = playlistManager.downloadRoot;
const navidromeSettings = { url: "http://navidrome.test", username: "test", password: "password" };
const user = { id: 1, role: "admin" };
const originalFetch = globalThis.fetch;

const flowHandlers = new Map();
registerFlows({
  get() {},
  post() {},
  put(route, ...handlers) { flowHandlers.set(route, handlers.at(-1)); },
  delete() {},
});

test.beforeEach(() => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  dbOps.updateSettings({
    integrations: { navidrome: navidromeSettings, lastfm: { apiKey: "test" } },
    onboardingComplete: true,
    playlistArtwork: { style: "aurral" },
    flows: [],
    sharedPlaylists: [],
  });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

function useNavidrome(songs = []) {
  const navidrome = createFakeNavidrome({
    libraries: [{ id: 1, name: "Aurral Playlists", path: downloadRoot }],
    songs,
  });
  navidrome.requests = [];
  globalThis.fetch = (input, init) => {
    navidrome.requests.push(new URL(input).pathname);
    return navidrome.fetch(input, init);
  };
  return navidrome;
}

function useJellyfin(t, url) {
  dbOps.updateSettings({ integrations: {
    navidrome: navidromeSettings,
    jellyfin: { url, apiKey: "key", userId: "admin" },
  } });
  const jellyfin = { items: [], playlists: new Map(), available: true, failDeletes: 0, failureStatus: 503, reads: 0 };
  const unavailable = () => Object.assign(new Error("Jellyfin unavailable"), { response: { status: jellyfin.failureStatus } });
  t.mock.method(JellyfinClient.prototype, "getAudioItems", async () => {
    jellyfin.reads += 1;
    if (!jellyfin.available) throw unavailable();
    return jellyfin.items;
  });
  t.mock.method(JellyfinClient.prototype, "createPlaylist", async ({ name, itemIds }) => {
    const id = `jellyfin-${jellyfin.playlists.size + 1}`;
    jellyfin.playlists.set(id, { name, itemIds: [...itemIds] });
    return { Id: id };
  });
  t.mock.method(JellyfinClient.prototype, "updatePlaylist", async (id, { name, itemIds }) => {
    if (!jellyfin.playlists.has(id)) throw Object.assign(new Error("Not found"), { response: { status: 404 } });
    jellyfin.playlists.set(id, { name, itemIds: [...itemIds] });
    return { Id: id, managedItemIds: itemIds };
  });
  t.mock.method(JellyfinClient.prototype, "deletePlaylist", async (id) => {
    if (!jellyfin.available) throw unavailable();
    if (jellyfin.failDeletes > 0) {
      jellyfin.failDeletes -= 1;
      throw unavailable();
    }
    jellyfin.playlists.delete(id);
  });
  return jellyfin;
}

function usePlex(t) {
  dbOps.updateSettings({ integrations: {
    ...dbOps.getSettings().integrations,
    plex: { url: "http://plex.test", token: "plex-token" },
  } });
  const plex = { tracks: [], playlists: new Map(), deleteStatus: null, readStatus: null, reads: 0 };
  t.mock.method(PlexClient.prototype, "ensureAurralLibrary", async (libraryPath) => ({ key: "9", Location: [{ path: libraryPath }] }));
  t.mock.method(PlexClient.prototype, "getTracks", async () => {
    plex.reads += 1;
    if (plex.readStatus) throw Object.assign(new Error("Plex unavailable"), { response: { status: plex.readStatus } });
    return plex.tracks;
  });
  t.mock.method(PlexClient.prototype, "syncPlaylist", async ({ ratingKey, title, ratingKeys }) => {
    const key = ratingKey ?? `plex-${plex.playlists.size + 1}`;
    plex.playlists.set(key, { title, ratingKeys: [...ratingKeys] });
    return { ratingKey: key };
  });
  t.mock.method(PlexClient.prototype, "deletePlaylist", async (key) => {
    if (plex.deleteStatus) throw Object.assign(new Error("Plex rejected the delete"), { response: { status: plex.deleteStatus } });
    plex.playlists.delete(key);
  });
  return plex;
}

const plexTitles = (plex) => [...plex.playlists.values()].map(({ title }) => title).sort();

const jellyfinNames = (jellyfin) => [...jellyfin.playlists.values()].map(({ name }) => name).sort();

const jellyfinItemsByName = (jellyfin) => Object.fromEntries([...jellyfin.playlists.values()]
  .map(({ name, itemIds }) => [name, [...itemIds].sort()]));

const indexedSong = (title) => ({ id: title, libraryPath: downloadRoot, path: `Artist/Album/${title}.flac`, title, artist: "Artist" });

async function addDownloadedTrack(playlistId, title) {
  const file = path.join(downloadRoot, "Artist", "Album", `${title}.flac`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, title);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: title, albumName: "Album" }, playlistId);
  downloadTracker.setDone(jobId, file, "Album");
  return file;
}

function pendingSyncs() {
  const now = Math.floor(Date.now() / 1000);
  return honker.listHonkerJobs("playback")
    .filter(({ payload }) => payload.kind === "playback-playlist-sync")
    .map(({ id, run_at: runAt, payload }) => ({ id, delaySeconds: runAt - now, payload }));
}

async function runNextSync(manager = playlistManager) {
  const [job] = pendingSyncs();
  honker.getPlaybackTaskQueue().cancel(job.id);
  manager.updateConfig();
  await manager.syncPlaylists(job.payload);
  return job;
}

const followUp = (entityIds, destination, chain, attempt) => ({
  kind: "playback-playlist-sync", entityIds, attempt, destinations: [destination], chain,
});

const songIdsByName = (navidrome) => Object.fromEntries(navidrome.playlists.map(({ name, songIds }) => [name, [...songIds].sort()]));

test("a burst of twenty completed downloads queues one sync and publishes each playlist once", async () => {
  const navidrome = useNavidrome();
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Burst Playlist" });
  const flow = flowPlaylistConfig.createFlow({ name: "Burst Flow", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  for (let index = 0; index < 20; index += 1) {
    const target = index % 2 ? flow.id : playlist.id;
    await addDownloadedTrack(target, `Song ${index}`);
    navidrome.songs.push(indexedSong(`Song ${index}`));
    playlistManager.requestPlaylistSync([target]);
  }

  assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [
    { kind: "playback-playlist-sync", entityIds: [playlist.id, flow.id], attempt: 0 },
  ]);
  const [{ payload }] = pendingSyncs();
  honker.getPlaybackTaskQueue().cancel(pendingSyncs()[0].id);
  await processSystemTask(payload);

  assert.equal(navidrome.requests.filter((request) => request === "/rest/createPlaylist").length, 2);
  assert.deepEqual(songIdsByName(navidrome), {
    "Burst Playlist": [0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((index) => `Song ${index}`).sort(),
    "Burst Flow": [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((index) => `Song ${index}`).sort(),
  });
  assert.deepEqual(pendingSyncs(), []);
});

test("a full sync request absorbs pending targeted ones and keeps the first run time", async () => {
  playlistManager.requestPlaylistSync(["first"], { delaySeconds: 2 });
  const [{ delaySeconds }] = pendingSyncs();
  playlistManager.requestPlaylistSync(null, { delaySeconds: 60 });
  playlistManager.requestPlaylistSync(["second"]);

  assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [
    { kind: "playback-playlist-sync", entityIds: null, attempt: 0 },
  ]);
  assert.equal(pendingSyncs()[0].delaySeconds, delaySeconds);
});

test("sync requests from two processes at once both land in the pending job", { timeout: 20000 }, async (t) => {
  const pendingId = playlistManager.requestPlaylistSync(["first"]);
  const jobIds = await callFromProcessesWhileHonkerLocked(t, honker, "requestPlaylistSync", [[["second"]], [["third"]]]);

  assert.deepEqual(jobIds, [pendingId, pendingId]);
  assert.deepEqual(pendingSyncs().map(({ id, payload }) => ({ id, entityIds: [...payload.entityIds].sort() })), [
    { id: pendingId, entityIds: ["first", "second", "third"] },
  ]);
});

for (const outage of ["slow", "failing"]) {
  test(`renaming a flow responds while the media server is ${outage}`, async () => {
    globalThis.fetch = outage === "slow"
      ? () => new Promise(() => {})
      : async () => { throw new Error("Navidrome unavailable"); };
    const flow = flowPlaylistConfig.createFlow({ name: `Before ${outage}`, ownerUserId: user.id, mix: { discover: 100 } });
    flowPlaylistConfig.updateFlow(flow.id, { scheduleDays: [1] });
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await flowHandlers.get("/flows/:flowId")({ params: { flowId: flow.id }, body: { name: `After ${outage}` }, user }, response);

    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(flowPlaylistConfig.getFlow(flow.id).name, `After ${outage}`);
    assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [
      { kind: "playback-playlist-sync", entityIds: [flow.id], attempt: 0 },
    ]);
    if (outage === "failing") {
      const [job] = pendingSyncs();
      honker.getPlaybackTaskQueue().cancel(job.id);
      await processSystemTask(job.payload);
      assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [followUp([flow.id], "navidrome", "outage", 1)]);
    }
  });
}

test("a track the server has not indexed is retried for its playlist only, across a restart, until the last attempt", async () => {
  const navidrome = useNavidrome([indexedSong("Ready"), indexedSong("Other")]);
  const waiting = flowPlaylistConfig.createStaticPlaylist({ name: "Waiting" });
  const other = flowPlaylistConfig.createStaticPlaylist({ name: "Other" });
  await addDownloadedTrack(waiting.id, "Ready");
  await addDownloadedTrack(waiting.id, "Scanned Later");
  await addDownloadedTrack(waiting.id, "Never Indexed");
  await addDownloadedTrack(other.id, "Other");
  playlistManager.requestPlaylistSync([waiting.id, other.id]);

  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { Waiting: ["Ready"], Other: ["Other"] });
  const [retry] = pendingSyncs();
  assert.deepEqual(retry.payload, followUp([waiting.id], "navidrome", "indexing", 1));
  assert.ok(Math.abs(retry.delaySeconds - 30) <= 2, `first retry runs in ${retry.delaySeconds}s`);
  playlistManager.requestPlaylistSync([other.id]);
  const [, fresh] = pendingSyncs();
  assert.deepEqual(fresh.payload, { kind: "playback-playlist-sync", entityIds: [other.id], attempt: 0 });
  honker.getPlaybackTaskQueue().cancel(fresh.id);

  const restarted = new PlaylistManager(downloadRoot);
  assert.deepEqual(pendingSyncs().map(({ id, payload }) => ({ id, payload })), [{ id: retry.id, payload: retry.payload }]);
  navidrome.songs.push(indexedSong("Scanned Later"));
  await runNextSync(restarted);
  assert.deepEqual(songIdsByName(navidrome), { Waiting: ["Ready", "Scanned Later"], Other: ["Other"] });

  for (const [attempt, delaySeconds] of [[2, 90], [3, 180], [4, 600]]) {
    const [next] = pendingSyncs();
    assert.deepEqual(next.payload, followUp([waiting.id], "navidrome", "indexing", attempt));
    assert.ok(Math.abs(next.delaySeconds - delaySeconds) <= 2, `attempt ${attempt} runs in ${next.delaySeconds}s`);
    await runNextSync(restarted);
  }
  assert.deepEqual(pendingSyncs(), []);
});

test("disabling a flow removes its playlist from the media server through the sync job", async (t) => {
  const navidrome = useNavidrome([indexedSong("Flow Song")]);
  const flow = flowPlaylistConfig.createFlow({ name: "Leaving Soon", ownerUserId: user.id, mix: { discover: 100 } });
  flowPlaylistConfig.setEnabled(flow.id, true);
  await addDownloadedTrack(flow.id, "Flow Song");
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });

  const { playlistOperationQueue } = await import("../../backend/services/playlists/playlistOperationQueue.js");
  t.mock.method(playlistOperationQueue, "enqueuePayload", async () => ({ operationId: "disable" }));
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  await flowHandlers.get("/flows/:flowId/enabled")({ params: { flowId: flow.id }, body: { enabled: false }, user }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });

  const fakeFetch = globalThis.fetch;
  let failDelete = true;
  globalThis.fetch = async (input, init) => {
    if (new URL(input).pathname === "/rest/deletePlaylist" && failDelete) {
      failDelete = false;
      return new Response(JSON.stringify({
        "subsonic-response": { status: "failed", version: "1.16.1", error: { code: 0, message: "Navidrome busy" } },
      }), { headers: { "content-type": "application/json" } });
    }
    return fakeFetch(input, init);
  };
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });
  assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [followUp([flow.id], "navidrome", "outage", 1)]);

  await runNextSync();
  assert.deepEqual(navidrome.playlists, []);
  assert.deepEqual(pendingSyncs(), []);
});

test("Jellyfin syncs reread the library after a track was missing and after a Library scan", async (t) => {
  dbOps.updateSettings({ integrations: { jellyfin: { url: "http://jellyfin.test", apiKey: "key", userId: "admin" } } });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Reindexed" });
  const first = await addDownloadedTrack(playlist.id, "First");
  let items = [{ Id: "first-old", Path: first }];
  const saved = [];
  t.mock.method(JellyfinClient.prototype, "getAudioItems", async () => items);
  t.mock.method(JellyfinClient.prototype, "createPlaylist", async ({ itemIds }) => {
    saved.push([...itemIds].sort());
    return { Id: "jellyfin-playlist" };
  });
  t.mock.method(JellyfinClient.prototype, "updatePlaylist", async (_id, { itemIds }) => {
    saved.push([...itemIds].sort());
    return { Id: "jellyfin-playlist", managedItemIds: itemIds };
  });
  t.mock.method(JellyfinClient.prototype, "getMusicLibraryLocations", async () => [downloadRoot]);
  t.mock.method(JellyfinClient.prototype, "reportUpdatedFolders", async () => {});
  const second = await addDownloadedTrack(playlist.id, "Second");
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(pendingSyncs().map(({ payload }) => payload.attempt), [1]);
  items = [...items, { Id: "second-old", Path: second }];
  await runNextSync();
  assert.deepEqual(pendingSyncs(), []);

  const third = await addDownloadedTrack(playlist.id, "Third");
  items = [{ Id: "first-new", Path: first }, { Id: "second-new", Path: second }, { Id: "third-new", Path: third }];
  await processSystemTask({ kind: "playback-library-scan", folders: [path.dirname(third)] });
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();

  assert.deepEqual(saved, [["first-old"], ["first-old", "second-old"], ["first-new", "second-new", "third-new"]]);
  assert.deepEqual(pendingSyncs(), []);
});

test("a media server that cannot be reached does not hold back the others and keeps getting retried until it recovers", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-outage.test");
  const navidrome = useNavidrome([indexedSong("Outage Song")]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Outage" });
  const file = await addDownloadedTrack(playlist.id, "Outage Song");
  jellyfin.items = [{ Id: "outage-song", Path: file }];
  jellyfin.available = false;
  playlistManager.requestPlaylistSync([playlist.id]);

  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { Outage: ["Outage Song"] });
  assert.deepEqual(jellyfinNames(jellyfin), []);
  for (const [attempt, delaySeconds] of [[1, 30], [2, 90], [3, 180], [4, 600], [5, 600], [6, 600]]) {
    const [next, ...rest] = pendingSyncs();
    assert.deepEqual(rest, []);
    assert.deepEqual(next.payload, followUp([playlist.id], "jellyfin", "outage", attempt));
    assert.ok(Math.abs(next.delaySeconds - delaySeconds) <= 2, `attempt ${attempt} runs in ${next.delaySeconds}s`);
    if (attempt === 6) jellyfin.available = true;
    await runNextSync();
  }

  assert.deepEqual([...jellyfin.playlists.values()], [{ name: "Outage", itemIds: ["outage-song"] }]);
  assert.deepEqual(songIdsByName(navidrome), { Outage: ["Outage Song"] });
  assert.equal(navidrome.requests.filter((request) => request === "/rest/createPlaylist").length, 1);
  assert.deepEqual(pendingSyncs(), []);
});

test("a change made while a sync job waits on its own retry gets a job of its own", async () => {
  playlistManager.requestPlaylistSync(["tried"]);
  const [tried] = pendingSyncs();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_live SET run_at = 0 WHERE id = ?", [tried.id]);
  tx.commit();
  const claimed = honker.getPlaybackTaskQueue().claimOne(honker.getWorkerId());
  assert.equal(claimed.id, tried.id);
  claimed.retry(120, "database is locked");

  playlistManager.requestPlaylistSync(["later"]);
  playlistManager.requestPlaylistSync(["latest"]);

  assert.deepEqual(pendingSyncs().map(({ id, payload }) => [id === tried.id, payload.entityIds]), [
    [true, ["tried"]],
    [false, ["later", "latest"]],
  ]);
});

test("deleting a playlist while a full sync is publishing leaves nothing behind on the servers", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-delete-race.test");
  const navidrome = useNavidrome([indexedSong("Kept Song"), indexedSong("Doomed Song")]);
  const kept = flowPlaylistConfig.createStaticPlaylist({ name: "Kept" });
  const doomed = flowPlaylistConfig.createStaticPlaylist({ name: "Doomed" });
  const keptFile = await addDownloadedTrack(kept.id, "Kept Song");
  const doomedFile = await addDownloadedTrack(doomed.id, "Doomed Song");
  jellyfin.items = [{ Id: "kept-song", Path: keptFile }, { Id: "doomed-song", Path: doomedFile }];
  playlistManager.requestPlaylistSync([doomed.id]);
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { Doomed: ["Doomed Song"] });
  assert.deepEqual(jellyfinNames(jellyfin), ["Doomed"]);

  let reachedKept;
  let releaseKept;
  const keptReached = new Promise((resolve) => { reachedKept = resolve; });
  const keptReleased = new Promise((resolve) => { releaseKept = resolve; });
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/rest/createPlaylist" && url.searchParams.get("name") === "Kept") {
      reachedKept();
      await keptReleased;
    }
    return fakeFetch(input, init);
  };
  playlistManager.requestPlaylistSync();
  const [full] = pendingSyncs();
  honker.getPlaybackTaskQueue().cancel(full.id);
  const running = processSystemTask(full.payload);
  await keptReached;
  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: doomed.id });
  releaseKept();
  await running;
  while (pendingSyncs().length) await runNextSync();

  assert.equal(flowPlaylistConfig.getStaticPlaylist(doomed.id), null);
  assert.deepEqual(songIdsByName(navidrome), { Kept: ["Kept Song"] });
  assert.deepEqual(jellyfinNames(jellyfin), ["Kept"]);
});

test("a playlist removed from Aurral is deleted from every server by its stored pointers, retrying a failed delete", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-orphan.test");
  const navidrome = useNavidrome([indexedSong("Orphan Song")]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Orphan" });
  const file = await addDownloadedTrack(playlist.id, "Orphan Song");
  jellyfin.items = [{ Id: "orphan-song", Path: file }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { Orphan: ["Orphan Song"] });
  assert.deepEqual(jellyfinNames(jellyfin), ["Orphan"]);

  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  jellyfin.failDeletes = 1;
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(navidrome.playlists, []);
  assert.deepEqual(jellyfinNames(jellyfin), ["Orphan"]);
  const [retry] = pendingSyncs();
  assert.deepEqual(retry.payload, followUp([playlist.id], "jellyfin", "outage", 1));

  await runNextSync();
  assert.deepEqual(jellyfinNames(jellyfin), []);
  assert.deepEqual(pendingSyncs(), []);
});

async function publishToEveryServer(t, name) {
  const jellyfin = useJellyfin(t, `http://jellyfin-${name}.test`);
  const plex = usePlex(t);
  const navidrome = useNavidrome([indexedSong("Doomed Song"), indexedSong("Kept Song")]);
  const doomed = flowPlaylistConfig.createStaticPlaylist({ name: "Doomed" });
  const kept = flowPlaylistConfig.createStaticPlaylist({ name: "Kept" });
  const doomedFile = await addDownloadedTrack(doomed.id, "Doomed Song");
  const keptFile = await addDownloadedTrack(kept.id, "Kept Song");
  jellyfin.items = [{ Id: "doomed-song", Path: doomedFile }, { Id: "kept-song", Path: keptFile }];
  plex.tracks = [{ ratingKey: "doomed-song", files: [doomedFile] }, { ratingKey: "kept-song", files: [keptFile] }];
  playlistManager.requestPlaylistSync([doomed.id, kept.id]);
  await runNextSync();
  const servers = { jellyfin, plex, navidrome };
  assert.deepEqual(serverPlaylists(servers), { navidrome: ["Doomed", "Kept"], plex: ["Doomed", "Kept"], jellyfin: ["Doomed", "Kept"] });
  assert.deepEqual(pendingSyncs(), []);
  return { ...servers, doomed, kept };
}

const serverPlaylists = ({ navidrome, plex, jellyfin }) => ({
  navidrome: navidrome.playlists.map(({ name }) => name).sort(),
  plex: plexTitles(plex),
  jellyfin: jellyfinNames(jellyfin),
});

async function drainSyncs(manager = playlistManager) {
  for (let runs = 0; pendingSyncs().length; runs += 1) {
    assert.ok(runs < 20, `syncs still pending: ${JSON.stringify(pendingSyncs())}`);
    await runNextSync(manager);
  }
}

test("a playlist deleted while a full sync waits is removed from every server", async (t) => {
  const { doomed, ...servers } = await publishToEveryServer(t, "pending-full");
  playlistManager.requestPlaylistSync();
  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: doomed.id });
  assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [
    { kind: "playback-playlist-sync", entityIds: null, attempt: 0 },
  ]);

  await drainSyncs();

  assert.deepEqual(serverPlaylists(servers), { navidrome: ["Kept"], plex: ["Kept"], jellyfin: ["Kept"] });
});

test("a playlist deleted during a long outage is removed from the server once it is back", async (t) => {
  const { doomed, ...servers } = await publishToEveryServer(t, "long-outage");
  servers.jellyfin.available = false;
  const restarted = new PlaylistManager(downloadRoot);
  playlistManager.requestPlaylistSync();
  await runNextSync(restarted);
  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: doomed.id });
  for (let runs = 0; ; runs += 1) {
    const jobs = pendingSyncs();
    if (jobs.length === 1 && jobs[0].payload.entityIds === null && jobs[0].payload.attempt >= 5) break;
    assert.ok(runs < 20, `follow-ups never merged: ${JSON.stringify(jobs)}`);
    await runNextSync(restarted);
  }
  assert.deepEqual(serverPlaylists(servers), { navidrome: ["Kept"], plex: ["Kept"], jellyfin: ["Doomed", "Kept"] });

  servers.jellyfin.available = true;
  await drainSyncs(restarted);

  assert.deepEqual(serverPlaylists(servers), { navidrome: ["Kept"], plex: ["Kept"], jellyfin: ["Kept"] });
});

test("a full sync removes playlists that servers still hold but Aurral no longer has", async (t) => {
  const { doomed, ...servers } = await publishToEveryServer(t, "orphan-cleanup");
  flowPlaylistConfig.deleteStaticPlaylist(doomed.id);

  playlistManager.requestPlaylistSync();
  await drainSyncs();

  assert.deepEqual(serverPlaylists(servers), { navidrome: ["Kept"], plex: ["Kept"], jellyfin: ["Kept"] });
});

test("deleting a playlist Navidrome imported from its m3u removes the imported playlist and the file", async () => {
  const navidrome = useNavidrome([]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Unindexed" });
  await addDownloadedTrack(playlist.id, "Late Song");
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  const playlistFiles = async () => (await fs.readdir(playlistManager.navidromeDestination.libraryRoot))
    .filter((file) => file.endsWith(".m3u"));
  assert.deepEqual(await playlistFiles(), ["Unindexed.m3u"]);
  assert.deepEqual(navidrome.playlists, []);
  navidrome.playlists.push({ id: "imported-unindexed", name: "Unindexed", songIds: [], comment: "Auto-imported from 'Unindexed.m3u'" });

  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: playlist.id });
  await drainSyncs();

  assert.deepEqual(navidrome.playlists, []);
  assert.deepEqual(await playlistFiles(), []);
  assert.deepEqual(navidromePlaylistPointerStore.getPointersForEntity(playlist.id), []);
});

test("a sync of another playlist removes the m3u of a deleted playlist even after Navidrome imported it", async () => {
  const navidrome = useNavidrome([indexedSong("Other Song")]);
  const deleted = flowPlaylistConfig.createStaticPlaylist({ name: "Gone" });
  const other = flowPlaylistConfig.createStaticPlaylist({ name: "Other" });
  await addDownloadedTrack(deleted.id, "Late Song");
  await addDownloadedTrack(other.id, "Other Song");
  playlistManager.requestPlaylistSync([deleted.id]);
  await runNextSync();
  navidrome.playlists.push({ id: "imported-gone", name: "Gone", songIds: [], comment: "Auto-imported from 'Gone.m3u'" });
  flowPlaylistConfig.deleteStaticPlaylist(deleted.id);
  const playlistFiles = async () => (await fs.readdir(playlistManager.navidromeDestination.libraryRoot))
    .filter((file) => file.endsWith(".m3u"));
  assert.deepEqual(await playlistFiles(), ["Gone.m3u"]);

  playlistManager.requestPlaylistSync([other.id]);
  const [job] = pendingSyncs().filter(({ payload }) => payload.entityIds.includes(other.id));
  honker.getPlaybackTaskQueue().cancel(job.id);
  await playlistManager.syncPlaylists(job.payload);

  assert.deepEqual(await playlistFiles(), []);
  assert.deepEqual(songIdsByName(navidrome), { Gone: [], Other: ["Other Song"] });
});

for (const status of [401, 503]) {
  const retried = status === 503;
  test(`a Jellyfin library read that fails with ${status} ${retried ? "is" : "is not"} followed up`, async (t) => {
    const jellyfin = useJellyfin(t, `http://jellyfin-read-${status}.test`);
    const navidrome = useNavidrome([indexedSong("Status Song")]);
    const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Status" });
    await addDownloadedTrack(playlist.id, "Status Song");
    jellyfin.available = false;
    jellyfin.failureStatus = status;

    playlistManager.requestPlaylistSync([playlist.id]);
    await runNextSync();

    assert.deepEqual(songIdsByName(navidrome), { Status: ["Status Song"] });
    assert.deepEqual(pendingSyncs().map(({ payload }) => payload), retried
      ? [followUp([playlist.id], "jellyfin", "outage", 1)]
      : []);
  });

  test(`a Plex playlist delete that fails with ${status} ${retried ? "is" : "is not"} followed up`, async (t) => {
    const { doomed, ...servers } = await publishToEveryServer(t, `plex-delete-${status}`);
    servers.plex.deleteStatus = status;
    flowPlaylistConfig.deleteStaticPlaylist(doomed.id);

    playlistManager.requestPlaylistSync([doomed.id]);
    await runNextSync();

    assert.deepEqual(serverPlaylists(servers), { navidrome: ["Kept"], plex: ["Doomed", "Kept"], jellyfin: ["Kept"] });
    assert.deepEqual(pendingSyncs().map(({ payload }) => payload), retried
      ? [followUp([doomed.id], "plex", "outage", 1)]
      : []);
  });
}

test("one sync reads the Jellyfin library once however many playlists are missing tracks", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-reads.test");
  const navidrome = useNavidrome();
  const playlists = [];
  const missing = [];
  for (let index = 0; index < 5; index += 1) {
    const playlist = flowPlaylistConfig.createStaticPlaylist({ name: `Partial ${index}` });
    const ready = await addDownloadedTrack(playlist.id, `Ready ${index}`);
    const late = await addDownloadedTrack(playlist.id, `Late ${index}`);
    navidrome.songs.push(indexedSong(`Ready ${index}`), indexedSong(`Late ${index}`));
    jellyfin.items.push({ Id: `ready-${index}`, Path: ready });
    missing.push({ Id: `late-${index}`, Path: late });
    playlists.push(playlist.id);
  }
  playlistManager.requestPlaylistSync(playlists);

  await runNextSync();
  assert.equal(jellyfin.reads, 1);
  assert.deepEqual(pendingSyncs().map(({ payload }) => payload), [followUp(playlists, "jellyfin", "indexing", 1)]);

  jellyfin.items.push(...missing);
  await runNextSync();
  assert.equal(jellyfin.reads, 2);
  assert.deepEqual([...jellyfin.playlists.values()].map(({ itemIds }) => itemIds.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(pendingSyncs(), []);
});

test("a finished Library download sends nothing to the media servers", async (t) => {
  const navidrome = useNavidrome([indexedSong("Library Song")]);
  const plex = usePlex(t);
  const { refreshCompletedPipelinePlaylist } = await import("../../backend/services/pipelineHelpers.js");
  await addDownloadedTrack("library", "Library Song");

  await refreshCompletedPipelinePlaylist(downloadTracker.getByPlaylistId("library")[0]);
  assert.deepEqual(pendingSyncs(), []);
  await processSystemTask({ kind: "playback-playlist-sync", entityIds: ["library"], attempt: 0 });

  assert.deepEqual(navidrome.requests, []);
  assert.equal(plex.reads, 0);
  assert.deepEqual(pendingSyncs(), []);
});

test("a server that comes back after a long outage still gets the tracks it indexes later", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-comeback.test");
  useNavidrome([indexedSong("Ready"), indexedSong("Late")]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Comeback" });
  const ready = await addDownloadedTrack(playlist.id, "Ready");
  const late = await addDownloadedTrack(playlist.id, "Late");
  jellyfin.items = [{ Id: "ready", Path: ready }];
  jellyfin.available = false;
  playlistManager.requestPlaylistSync([playlist.id]);

  for (let run = 0; run < 6; run += 1) await runNextSync();
  assert.deepEqual(jellyfinNames(jellyfin), []);
  jellyfin.available = true;
  await runNextSync();
  assert.deepEqual(jellyfinItemsByName(jellyfin), { Comeback: ["ready"] });

  jellyfin.items.push({ Id: "late", Path: late });
  await drainSyncs();

  assert.deepEqual(jellyfinItemsByName(jellyfin), { Comeback: ["late", "ready"] });
});

test("a server that rejects Aurral is not called again while another server is retried", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-rejects.test");
  const plex = usePlex(t);
  const navidrome = useNavidrome([indexedSong("Shared Song")]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Split" });
  const file = await addDownloadedTrack(playlist.id, "Shared Song");
  jellyfin.items = [{ Id: "shared-song", Path: file }];
  plex.tracks = [{ ratingKey: "shared-song", files: [file] }];
  jellyfin.available = false;
  jellyfin.failureStatus = 401;
  plex.readStatus = 503;
  playlistManager.requestPlaylistSync([playlist.id]);

  for (let run = 0; run < 4; run += 1) await runNextSync();
  assert.equal(plex.reads, 4);
  plex.readStatus = null;
  await drainSyncs();

  assert.equal(jellyfin.reads, 1);
  assert.deepEqual(serverPlaylists({ navidrome, plex, jellyfin }), { navidrome: ["Split"], plex: ["Split"], jellyfin: [] });
  assert.equal(navidrome.requests.filter((request) => request === "/rest/createPlaylist").length, 1);
});
