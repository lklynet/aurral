import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";
import { callFromProcessesWhileHonkerLocked } from "../helpers/playlistManagerCallers.ts";
import type { TestContext } from "vite-plus/test";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
const [
  state,
  { db },
  { dbOps },
  honker,
  { playlistManager, PlaylistManager },
  { processSystemTask },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { downloadTracker },
  { api },
  { JellyfinClient },
  { processPlaylistOperation },
  { PlexClient },
  { navidromePlaylistPointerStore },
] = await setupIsolatedBackend(
  "playlist-sync-job",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/jellyfin.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/plex.ts"),
  () => import("../../backend/services/navidrome/navidromePlaylistPointerStore.ts"),
);

const downloadRoot = playlistManager.downloadRoot;
const lidarrRoot = path.join(path.dirname(downloadRoot), "lidarr");
const navidromeSettings = { url: "http://navidrome.test", username: "test", password: "password" };
const user = testUser(1, { role: "admin" });
const originalFetch = globalThis.fetch;

const putFlow = (path: string, body: object) =>
  signedInAs(user)
    .route("/", api)
    .request(`/playlists/flows/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string" || input instanceof URL ? input : input.url;

beforeEach(() => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  dbOps.updateSettings({
    integrations: { navidrome: navidromeSettings, lastfm: { apiKey: "test" } },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

type FakeNavidromeSongs = NonNullable<
  NonNullable<Parameters<typeof createFakeNavidrome>[0]>["songs"]
>;

function useNavidrome(songs: FakeNavidromeSongs = []) {
  const navidrome = Object.assign(
    createFakeNavidrome({
      libraries: [{ id: 1, name: "Aurral Playlists", path: downloadRoot }],
      songs,
    }),
    { requests: [] as string[] },
  );
  globalThis.fetch = (input, init) => {
    navidrome.requests.push(new URL(requestUrl(input)).pathname);
    return navidrome.fetch(input, init);
  };
  return navidrome;
}

type JellyfinItem = { Id: string; Path: string; ProviderIds?: { MusicBrainzTrack: string } };

function useJellyfin(t: TestContext, url: string) {
  dbOps.updateSettings({
    integrations: {
      navidrome: navidromeSettings,
      jellyfin: { url, apiKey: "key", userId: "admin" },
    },
  });
  const jellyfin = {
    items: [] as JellyfinItem[],
    locations: [downloadRoot, lidarrRoot],
    playlists: new Map<string, { name: string; itemIds: string[] }>(),
    available: true,
    failDeletes: 0,
    failureStatus: 503,
    reads: 0,
  };
  const unavailable = () =>
    Object.assign(new Error("Jellyfin unavailable"), {
      response: { status: jellyfin.failureStatus },
    });
  vi.spyOn(JellyfinClient.prototype, "request").mockImplementation(
    async (method, endpoint, { params } = {}) => {
      if (`${method} ${endpoint}` === "GET /Library/VirtualFolders") {
        if (!jellyfin.available) throw unavailable();
        return [{ CollectionType: "music", Locations: jellyfin.locations }];
      }
      if (`${method} ${endpoint}` === "POST /Library/Media/Updated") return null;
      assert.equal(`${method} ${endpoint} ${params?.includeItemTypes}`, "GET /Items Audio");
      jellyfin.reads += 1;
      if (!jellyfin.available) throw unavailable();
      const startIndex = Number(params?.startIndex);
      return {
        Items: jellyfin.items.slice(startIndex, startIndex + Number(params?.limit)),
        TotalRecordCount: jellyfin.items.length,
      };
    },
  );
  vi.spyOn(JellyfinClient.prototype, "createPlaylist").mockImplementation(
    async ({ name, itemIds }) => {
      const id = `jellyfin-${jellyfin.playlists.size + 1}`;
      jellyfin.playlists.set(id, { name, itemIds: [...itemIds] });
      return { Id: id };
    },
  );
  vi.spyOn(JellyfinClient.prototype, "updatePlaylist").mockImplementation(
    async (id, { name, itemIds }) => {
      if (!jellyfin.playlists.has(id))
        throw Object.assign(new Error("Not found"), { response: { status: 404 } });
      jellyfin.playlists.set(id, { name, itemIds: [...itemIds] });
      return { Id: id, managedItemIds: itemIds };
    },
  );
  vi.spyOn(JellyfinClient.prototype, "deletePlaylist").mockImplementation(async (id) => {
    if (!jellyfin.available) throw unavailable();
    if (jellyfin.failDeletes > 0) {
      jellyfin.failDeletes -= 1;
      throw unavailable();
    }
    jellyfin.playlists.delete(id);
  });
  return jellyfin;
}

let plexServers = 0;
const plexEpoch = Math.floor(Date.now() / 1000);

type SyncPayload = NonNullable<
  Parameters<InstanceType<typeof PlaylistManager>["syncPlaylists"]>[0]
>;
type PlexTrack = { ratingKey: string; addedAt: number; file: string };

function usePlex(
  t: TestContext,
  { mainLibrarySectionId = "" }: { mainLibrarySectionId?: string } = {},
) {
  plexServers += 1;
  dbOps.updateSettings({
    integrations: {
      ...dbOps.getSettings().integrations,
      plex: { url: `http://plex-${plexServers}.test`, token: "plex-token", mainLibrarySectionId },
    },
  });
  const plex = {
    sections: { 9: [], 5: [] } as Record<string, PlexTrack[]>,
    mainRoots: [lidarrRoot],
    reads: [] as string[],
    failReads: null as ((sectionId: string, addedSince: number | null) => boolean) | null,
    playlists: new Map<string | number, { title: string; ratingKeys: (string | number)[] }>(),
    deleteStatus: null as number | null,
  };
  vi.spyOn(PlexClient.prototype, "ensureAurralLibrary").mockImplementation(async (libraryPath) => ({
    key: "9",
    type: "artist",
    title: "Aurral",
    Location: [{ path: libraryPath }],
  }));
  vi.spyOn(PlexClient.prototype, "request").mockImplementation(
    async (endpoint, { params } = {}) => {
      if (endpoint === "/library/sections") {
        return {
          MediaContainer: {
            size: 1,
            Directory: [
              {
                key: "5",
                type: "artist",
                title: "Music",
                Location: plex.mainRoots.map((root) => ({ path: root })),
              },
            ],
          },
        };
      }
      const sectionId = endpoint.match(/^\/library\/sections\/(\w+)\/all$/)?.[1];
      assert.ok(sectionId, `unexpected Plex request ${endpoint}`);
      const addedAfter = params?.["addedAt>"];
      const addedSince = addedAfter == null ? null : Number(addedAfter) - plexEpoch;
      plex.reads.push(
        addedSince == null ? `all of ${sectionId}` : `${sectionId} added since ${addedSince}`,
      );
      if (plex.failReads?.(sectionId, addedSince)) {
        throw Object.assign(new Error("Plex unavailable"), { response: { status: 503 } });
      }
      const tracks = plex.sections[sectionId].filter(
        ({ addedAt }) => addedSince == null || addedAt >= addedSince,
      );
      const start = Number(params?.["X-Plex-Container-Start"]);
      const page = tracks.slice(start, start + Number(params?.["X-Plex-Container-Size"]));
      return {
        MediaContainer: {
          size: page.length,
          totalSize: tracks.length,
          Metadata: page.map(({ ratingKey, addedAt, file }) => ({
            ratingKey,
            addedAt: plexEpoch + addedAt,
            Media: [{ Part: [{ file }] }],
          })),
        },
      };
    },
  );
  vi.spyOn(PlexClient.prototype, "scanLibrary").mockImplementation(async () => null);
  vi.spyOn(PlexClient.prototype, "syncPlaylist").mockImplementation(
    async ({ ratingKey, title, ratingKeys }) => {
      const key = ratingKey ?? `plex-${plex.playlists.size + 1}`;
      plex.playlists.set(key, { title, ratingKeys: [...(ratingKeys ?? [])] });
      return { ratingKey: key };
    },
  );
  vi.spyOn(PlexClient.prototype, "deletePlaylist").mockImplementation(async (key) => {
    if (plex.deleteStatus)
      throw Object.assign(new Error("Plex rejected the delete"), {
        response: { status: plex.deleteStatus },
      });
    plex.playlists.delete(key);
  });
  return plex;
}

type FakePlex = ReturnType<typeof usePlex>;
type FakeJellyfin = ReturnType<typeof useJellyfin>;

const plexTitles = (plex: FakePlex) =>
  [...plex.playlists.values()].map(({ title }) => title).sort();

const plexRatingKeys = (plex: FakePlex) =>
  Object.fromEntries(
    [...plex.playlists.values()].map(({ title, ratingKeys }) => [title, [...ratingKeys].sort()]),
  );

const useOnly = (key: string) =>
  dbOps.updateSettings({ integrations: { [key]: dbOps.getSettings().integrations[key] } });

function useClock() {
  const realNow = Date.now;
  let offsetMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + offsetMs);
  return {
    advance: (ms: number) => {
      offsetMs += ms;
    },
  };
}

const jellyfinNames = (jellyfin: FakeJellyfin) =>
  [...jellyfin.playlists.values()].map(({ name }) => name).sort();

const jellyfinItemsByName = (jellyfin: FakeJellyfin) =>
  Object.fromEntries(
    [...jellyfin.playlists.values()].map(({ name, itemIds }) => [name, [...itemIds].sort()]),
  );

const indexedSong = (title: string) => ({
  id: title,
  libraryPath: downloadRoot,
  path: `Artist/Album/${title}.flac`,
  title,
  artist: "Artist",
});

async function addDownloadedTrack(playlistId: string, title: string, root: string = downloadRoot) {
  const file = path.join(root, "Artist", "Album", `${title}.flac`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, title);
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: title, albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, file, "Album");
  return file;
}

function pendingSyncs() {
  const now = Math.floor(Date.now() / 1000);
  return honker
    .listHonkerJobs("playback")
    .flatMap(({ id, run_at: runAt, payload }) =>
      payload?.kind === "playback-playlist-sync"
        ? [{ id, delaySeconds: runAt - now, payload: payload as SyncPayload }]
        : [],
    );
}

async function runNextSync(manager: InstanceType<typeof PlaylistManager> = playlistManager) {
  const [job] = pendingSyncs();
  honker.getPlaybackTaskQueue().cancel(job.id);
  manager.updateConfig();
  await manager.syncPlaylists(job.payload);
  return job;
}

async function runPendingScans() {
  for (const { id, payload } of honker.listHonkerJobs("playback")) {
    if (payload?.kind !== "playback-library-scan") continue;
    honker.getPlaybackTaskQueue().cancel(id);
    await processSystemTask(payload);
  }
}

const followUp = (entityIds: string[], destination: string, chain: string, attempt: number) => ({
  kind: "playback-playlist-sync",
  entityIds,
  attempt,
  destinations: [destination],
  chain,
});

const songIdsByName = (navidrome: ReturnType<typeof useNavidrome>) =>
  Object.fromEntries(navidrome.playlists.map(({ name, songIds }) => [name, [...songIds].sort()]));

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

  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [{ kind: "playback-playlist-sync", entityIds: [playlist.id, flow.id], attempt: 0 }],
  );
  const [{ payload }] = pendingSyncs();
  honker.getPlaybackTaskQueue().cancel(pendingSyncs()[0].id);
  await processSystemTask(payload);

  assert.equal(
    navidrome.requests.filter((request) => request === "/rest/createPlaylist").length,
    2,
  );
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

  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [{ kind: "playback-playlist-sync", entityIds: null, attempt: 0 }],
  );
  assert.equal(pendingSyncs()[0].delaySeconds, delaySeconds);
});

test(
  "sync requests from two processes at once both land in the pending job",
  { timeout: 20000 },
  async (t) => {
    const pendingId = playlistManager.requestPlaylistSync(["first"]);
    const jobIds = await callFromProcessesWhileHonkerLocked(t, honker, "requestPlaylistSync", [
      [["second"]],
      [["third"]],
    ]);

    assert.deepEqual(jobIds, [pendingId, pendingId]);
    assert.deepEqual(
      pendingSyncs().map(({ id, payload }) => ({
        id,
        entityIds: [...(payload.entityIds ?? [])].sort(),
      })),
      [{ id: pendingId, entityIds: ["first", "second", "third"] }],
    );
  },
);

for (const outage of ["slow", "failing"]) {
  test(`renaming a flow responds while the media server is ${outage}`, async () => {
    globalThis.fetch =
      outage === "slow"
        ? () => new Promise(() => {})
        : async () => {
            throw new Error("Navidrome unavailable");
          };
    const flow = flowPlaylistConfig.createFlow({
      name: `Before ${outage}`,
      ownerUserId: user.id,
      mix: { discover: 100 },
    });
    flowPlaylistConfig.updateFlow(flow.id, { scheduleDays: [1] });
    const response = await putFlow(flow.id, { name: `After ${outage}` });

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(flowPlaylistConfig.getFlow(flow.id)!.name, `After ${outage}`);
    assert.deepEqual(
      pendingSyncs().map(({ payload }) => payload),
      [{ kind: "playback-playlist-sync", entityIds: [flow.id], attempt: 0 }],
    );
    if (outage === "failing") {
      const [job] = pendingSyncs();
      honker.getPlaybackTaskQueue().cancel(job.id);
      await processSystemTask(job.payload);
      assert.deepEqual(
        pendingSyncs().map(({ payload }) => payload),
        [followUp([flow.id], "navidrome", "outage", 1)],
      );
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
  assert.deepEqual(fresh.payload, {
    kind: "playback-playlist-sync",
    entityIds: [other.id],
    attempt: 0,
  });
  honker.getPlaybackTaskQueue().cancel(fresh.id);

  const restarted = new PlaylistManager(downloadRoot);
  assert.deepEqual(
    pendingSyncs().map(({ id, payload }) => ({ id, payload })),
    [{ id: retry.id, payload: retry.payload }],
  );
  navidrome.songs.push(indexedSong("Scanned Later"));
  await runNextSync(restarted);
  assert.deepEqual(songIdsByName(navidrome), {
    Waiting: ["Ready", "Scanned Later"],
    Other: ["Other"],
  });

  for (const [attempt, delaySeconds] of [
    [2, 90],
    [3, 180],
    [4, 600],
  ]) {
    const [next] = pendingSyncs();
    assert.deepEqual(next.payload, followUp([waiting.id], "navidrome", "indexing", attempt));
    assert.ok(
      Math.abs(next.delaySeconds - delaySeconds) <= 2,
      `attempt ${attempt} runs in ${next.delaySeconds}s`,
    );
    await runNextSync(restarted);
  }
  assert.deepEqual(pendingSyncs(), []);
});

test("disabling a flow removes its playlist from the media server through the sync job", async () => {
  const navidrome = useNavidrome([indexedSong("Flow Song")]);
  const flow = flowPlaylistConfig.createFlow({
    name: "Leaving Soon",
    ownerUserId: user.id,
    mix: { discover: 100 },
  });
  flowPlaylistConfig.setEnabled(flow.id, true);
  await addDownloadedTrack(flow.id, "Flow Song");
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });

  const { playlistOperationQueue } =
    await import("../../backend/services/playlists/playlistOperationQueue.ts");
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async () => ({
    queued: true,
    operationId: 1,
  }));
  const response = await putFlow(`${flow.id}/enabled`, { enabled: false });
  assert.equal(response.status, 200);
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });

  const fakeFetch = globalThis.fetch;
  let failDelete = true;
  globalThis.fetch = async (input, init) => {
    if (new URL(requestUrl(input)).pathname === "/rest/deletePlaylist" && failDelete) {
      failDelete = false;
      return new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "failed",
            version: "1.16.1",
            error: { code: 0, message: "Navidrome busy" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return fakeFetch(input, init);
  };
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { "Leaving Soon": ["Flow Song"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([flow.id], "navidrome", "outage", 1)],
  );

  await runNextSync();
  assert.deepEqual([...navidrome.playlists], []);
  assert.deepEqual(pendingSyncs(), []);
});

test("Jellyfin keeps its library index across syncs and scans and rereads it for a missing track at most every 30 seconds", async (t) => {
  const clock = useClock();
  const jellyfin = useJellyfin(t, "http://jellyfin-index.test");
  useOnly("jellyfin");
  vi.spyOn(JellyfinClient.prototype, "getMusicLibraryLocations").mockImplementation(async () => [
    downloadRoot,
  ]);
  vi.spyOn(JellyfinClient.prototype, "reportUpdatedFolders").mockImplementation(async () => {});
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Indexed" });
  const first = await addDownloadedTrack(playlist.id, "First");
  jellyfin.items = [{ Id: "first", Path: first }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.equal(jellyfin.reads, 1);

  const second = await addDownloadedTrack(playlist.id, "Second");
  await processSystemTask({ kind: "playback-library-scan", folders: [path.dirname(second)] });
  jellyfin.items.push({ Id: "second", Path: second });
  clock.advance(10_000);
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.equal(jellyfin.reads, 1);
  assert.deepEqual([...jellyfin.playlists.values()], [{ name: "Indexed", itemIds: ["first"] }]);
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload.attempt),
    [1],
  );

  clock.advance(30_000);
  await runNextSync();
  assert.equal(jellyfin.reads, 1);
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload.attempt),
    [2],
  );

  clock.advance(90_000);
  await runNextSync();
  assert.equal(jellyfin.reads, 2);
  assert.deepEqual(
    [...jellyfin.playlists.values()],
    [{ name: "Indexed", itemIds: ["first", "second"] }],
  );

  await processSystemTask({ kind: "playback-library-scan", folders: [path.dirname(second)] });
  clock.advance(60_000);
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.equal(jellyfin.reads, 2);
  assert.deepEqual(pendingSyncs(), []);
});

test("a later Plex sync reads only what each section added since the last read", async (t) => {
  const plex = usePlex(t, { mainLibrarySectionId: "5" });
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Indexed" });
  const first = await addDownloadedTrack(playlist.id, "First");
  const reused = await addDownloadedTrack(playlist.id, "Reused", lidarrRoot);
  plex.sections[9] = [{ ratingKey: "first", addedAt: 1_000_000, file: first }];
  plex.sections[5] = [{ ratingKey: "reused", addedAt: 2_000_000, file: reused }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plex.reads, ["all of 9", "all of 5"]);
  assert.deepEqual(plexRatingKeys(plex), { Indexed: ["first", "reused"] });

  plex.reads.length = 0;
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999700", "5 added since 1999700"]);

  plex.reads.length = 0;
  const second = await addDownloadedTrack(playlist.id, "Second");
  plex.sections[9].push({ ratingKey: "second", addedAt: 1_000_100, file: second });
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999700", "5 added since 1999700"]);
  assert.deepEqual(plexRatingKeys(plex), { Indexed: ["first", "reused", "second"] });
  assert.deepEqual(pendingSyncs(), []);
});

test("a file downloaded again at the same path is published with the rating key Plex gave it", async (t) => {
  const plex = usePlex(t);
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Replaced" });
  const file = await addDownloadedTrack(playlist.id, "Track");
  plex.sections[9] = [{ ratingKey: "182", addedAt: 1_000_000, file }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Replaced: ["182"] });

  plex.reads.length = 0;
  plex.sections[9].push({ ratingKey: "2446", addedAt: 1_000_050, file });
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Replaced: ["2446"] });
  assert.deepEqual(plex.reads, ["9 added since 999700"]);
});

test("a track the incremental Plex read misses is found by one full read, at most every 30 seconds", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Backfilled" });
  const first = await addDownloadedTrack(playlist.id, "First");
  plex.sections[9] = [{ ratingKey: "first", addedAt: 1_000_000, file: first }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();

  plex.reads.length = 0;
  const late = await addDownloadedTrack(playlist.id, "Late");
  plex.sections[9].push({ ratingKey: "late", addedAt: 500_000, file: late });
  clock.advance(31_000);
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999700", "all of 9"]);
  assert.deepEqual(plexRatingKeys(plex), { Backfilled: ["first", "late"] });

  plex.reads.length = 0;
  const missing = await addDownloadedTrack(playlist.id, "Missing");
  clock.advance(10_000);
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999700"]);
  assert.deepEqual(plexRatingKeys(plex), { Backfilled: ["first", "late"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload.attempt),
    [1],
  );

  plex.reads.length = 0;
  plex.sections[9].push({ ratingKey: "missing", addedAt: 400_000, file: missing });
  clock.advance(30_000);
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999700", "all of 9"]);
  assert.deepEqual(plexRatingKeys(plex), { Backfilled: ["first", "late", "missing"] });
  assert.deepEqual(pendingSyncs(), []);
});

test("a Plex read that fails while publishing leaves the playlist as it was and retries it", async (t) => {
  const clock = useClock();
  const plex = usePlex(t, { mainLibrarySectionId: "5" });
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Steady" });
  const first = await addDownloadedTrack(playlist.id, "First");
  const reused = await addDownloadedTrack(playlist.id, "Reused", lidarrRoot);
  plex.sections[9] = [{ ratingKey: "first", addedAt: 1_000_000, file: first }];
  plex.sections[5] = [{ ratingKey: "reused", addedAt: 1_000_000, file: reused }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Steady: ["first", "reused"] });

  const second = await addDownloadedTrack(playlist.id, "Second");
  plex.sections[9].push({ ratingKey: "second", addedAt: 1_000_100, file: second });
  plex.failReads = (sectionId) => sectionId === "5";
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Steady: ["first", "reused"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([playlist.id], "plex", "outage", 1)],
  );

  const late = await addDownloadedTrack(playlist.id, "Late");
  plex.sections[9].push({ ratingKey: "late", addedAt: 500_000, file: late });
  plex.failReads = (sectionId, addedSince) => sectionId === "9" && addedSince == null;
  clock.advance(31_000);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999800", "5 added since 999700", "all of 9"]);
  assert.deepEqual(plexRatingKeys(plex), { Steady: ["first", "reused"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([playlist.id], "plex", "outage", 2)],
  );

  plex.failReads = null;
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since 999800", "5 added since 999700"]);
  assert.deepEqual(plexRatingKeys(plex), { Steady: ["first", "reused"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([playlist.id], "plex", "outage", 3)],
  );

  clock.advance(90_000);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Steady: ["first", "late", "reused", "second"] });
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
  for (const [attempt, delaySeconds] of [
    [1, 30],
    [2, 90],
    [3, 180],
    [4, 600],
    [5, 600],
    [6, 600],
  ]) {
    const [next, ...rest] = pendingSyncs();
    assert.deepEqual([...rest], []);
    assert.deepEqual(next.payload, followUp([playlist.id], "jellyfin", "outage", attempt));
    assert.ok(
      Math.abs(next.delaySeconds - delaySeconds) <= 2,
      `attempt ${attempt} runs in ${next.delaySeconds}s`,
    );
    if (attempt === 6) jellyfin.available = true;
    await runNextSync();
  }

  assert.deepEqual(
    [...jellyfin.playlists.values()],
    [{ name: "Outage", itemIds: ["outage-song"] }],
  );
  assert.deepEqual(songIdsByName(navidrome), { Outage: ["Outage Song"] });
  assert.equal(
    navidrome.requests.filter((request) => request === "/rest/createPlaylist").length,
    1,
  );
  assert.deepEqual(pendingSyncs(), []);
});

test("a change made while a sync job waits on its own retry gets a job of its own", async () => {
  playlistManager.requestPlaylistSync(["tried"]);
  const [tried] = pendingSyncs();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_live SET run_at = 0 WHERE id = ?", [tried.id]);
  tx.commit();
  const claimed = honker.getPlaybackTaskQueue().claimOne(honker.getWorkerId());
  assert.ok(claimed != null);
  assert.equal(claimed.id, tried.id);
  claimed.retry(120, "database is locked");

  playlistManager.requestPlaylistSync(["later"]);
  playlistManager.requestPlaylistSync(["latest"]);

  assert.deepEqual(
    pendingSyncs().map(({ id, payload }) => [id === tried.id, payload.entityIds]),
    [
      [true, ["tried"]],
      [false, ["later", "latest"]],
    ],
  );
});

test("deleting a playlist while a full sync is publishing leaves nothing behind on the servers", async (t) => {
  const jellyfin = useJellyfin(t, "http://jellyfin-delete-race.test");
  const navidrome = useNavidrome([indexedSong("Kept Song"), indexedSong("Doomed Song")]);
  const kept = flowPlaylistConfig.createStaticPlaylist({ name: "Kept" });
  const doomed = flowPlaylistConfig.createStaticPlaylist({ name: "Doomed" });
  const keptFile = await addDownloadedTrack(kept.id, "Kept Song");
  const doomedFile = await addDownloadedTrack(doomed.id, "Doomed Song");
  jellyfin.items = [
    { Id: "kept-song", Path: keptFile },
    { Id: "doomed-song", Path: doomedFile },
  ];
  playlistManager.requestPlaylistSync([doomed.id]);
  await runNextSync();
  assert.deepEqual(songIdsByName(navidrome), { Doomed: ["Doomed Song"] });
  assert.deepEqual(jellyfinNames(jellyfin), ["Doomed"]);

  let reachedKept!: () => void;
  let releaseKept!: () => void;
  const keptReached = new Promise<void>((resolve) => {
    reachedKept = resolve;
  });
  const keptReleased = new Promise<void>((resolve) => {
    releaseKept = resolve;
  });
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
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
  assert.deepEqual([...navidrome.playlists], []);
  assert.deepEqual(jellyfinNames(jellyfin), ["Orphan"]);
  const [retry] = pendingSyncs();
  assert.deepEqual(retry.payload, followUp([playlist.id], "jellyfin", "outage", 1));

  await runNextSync();
  assert.deepEqual(jellyfinNames(jellyfin), []);
  assert.deepEqual(pendingSyncs(), []);
});

async function publishToEveryServer(t: TestContext, name: string) {
  const jellyfin = useJellyfin(t, `http://jellyfin-${name}.test`);
  const plex = usePlex(t);
  const navidrome = useNavidrome([indexedSong("Doomed Song"), indexedSong("Kept Song")]);
  const doomed = flowPlaylistConfig.createStaticPlaylist({ name: "Doomed" });
  const kept = flowPlaylistConfig.createStaticPlaylist({ name: "Kept" });
  const doomedFile = await addDownloadedTrack(doomed.id, "Doomed Song");
  const keptFile = await addDownloadedTrack(kept.id, "Kept Song");
  jellyfin.items = [
    { Id: "doomed-song", Path: doomedFile },
    { Id: "kept-song", Path: keptFile },
  ];
  plex.sections[9] = [
    { ratingKey: "doomed-song", addedAt: 1_000_000, file: doomedFile },
    { ratingKey: "kept-song", addedAt: 1_000_000, file: keptFile },
  ];
  playlistManager.requestPlaylistSync([doomed.id, kept.id]);
  await runNextSync();
  const servers = { jellyfin, plex, navidrome };
  assert.deepEqual(serverPlaylists(servers), {
    navidrome: ["Doomed", "Kept"],
    plex: ["Doomed", "Kept"],
    jellyfin: ["Doomed", "Kept"],
  });
  assert.deepEqual(pendingSyncs(), []);
  return { ...servers, doomed, kept };
}

const serverPlaylists = ({
  navidrome,
  plex,
  jellyfin,
}: {
  navidrome: ReturnType<typeof useNavidrome>;
  plex: FakePlex;
  jellyfin: FakeJellyfin;
}) => ({
  navidrome: navidrome.playlists.map(({ name }) => name).sort(),
  plex: plexTitles(plex),
  jellyfin: jellyfinNames(jellyfin),
});

async function drainSyncs(manager: InstanceType<typeof PlaylistManager> = playlistManager) {
  for (let runs = 0; pendingSyncs().length; runs += 1) {
    assert.ok(runs < 20, `syncs still pending: ${JSON.stringify(pendingSyncs())}`);
    await runNextSync(manager);
  }
}

test("a playlist deleted while a full sync waits is removed from every server", async (t) => {
  const { doomed, ...servers } = await publishToEveryServer(t, "pending-full");
  playlistManager.requestPlaylistSync();
  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: doomed.id });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [{ kind: "playback-playlist-sync", entityIds: null, attempt: 0 }],
  );

  await drainSyncs();

  assert.deepEqual(serverPlaylists(servers), {
    navidrome: ["Kept"],
    plex: ["Kept"],
    jellyfin: ["Kept"],
  });
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
    if (
      jobs.length === 1 &&
      jobs[0].payload.entityIds === null &&
      (jobs[0].payload.attempt ?? 0) >= 5
    )
      break;
    assert.ok(runs < 20, `follow-ups never merged: ${JSON.stringify(jobs)}`);
    await runNextSync(restarted);
  }
  assert.deepEqual(serverPlaylists(servers), {
    navidrome: ["Kept"],
    plex: ["Kept"],
    jellyfin: ["Doomed", "Kept"],
  });

  servers.jellyfin.available = true;
  await drainSyncs(restarted);

  assert.deepEqual(serverPlaylists(servers), {
    navidrome: ["Kept"],
    plex: ["Kept"],
    jellyfin: ["Kept"],
  });
});

test("deleting a playlist Navidrome imported from its m3u removes the imported playlist and the file", async () => {
  const navidrome = useNavidrome([]);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Unindexed" });
  await addDownloadedTrack(playlist.id, "Late Song");
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  const playlistFiles = async () =>
    (await fs.readdir(playlistManager.navidromeDestination.libraryRoot)).filter((file: string) =>
      file.endsWith(".m3u"),
    );
  assert.deepEqual(await playlistFiles(), ["Unindexed.m3u"]);
  assert.deepEqual([...navidrome.playlists], []);
  navidrome.playlists.push({
    id: "imported-unindexed",
    name: "Unindexed",
    songIds: [],
    comment: "Auto-imported from 'Unindexed.m3u'",
  });

  await processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: playlist.id });
  await drainSyncs();

  assert.deepEqual([...navidrome.playlists], []);
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
  navidrome.playlists.push({
    id: "imported-gone",
    name: "Gone",
    songIds: [],
    comment: "Auto-imported from 'Gone.m3u'",
  });
  flowPlaylistConfig.deleteStaticPlaylist(deleted.id);
  const playlistFiles = async () =>
    (await fs.readdir(playlistManager.navidromeDestination.libraryRoot)).filter((file: string) =>
      file.endsWith(".m3u"),
    );
  assert.deepEqual(await playlistFiles(), ["Gone.m3u"]);

  playlistManager.requestPlaylistSync([other.id]);
  const [job] = pendingSyncs().filter(({ payload }) => payload.entityIds?.includes(other.id));
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
    assert.deepEqual(
      pendingSyncs().map(({ payload }) => payload),
      retried ? [followUp([playlist.id], "jellyfin", "outage", 1)] : [],
    );
  });

  test(`a Plex playlist delete that fails with ${status} ${retried ? "is" : "is not"} followed up`, async (t) => {
    const { doomed, ...servers } = await publishToEveryServer(t, `plex-delete-${status}`);
    servers.plex.deleteStatus = status;
    flowPlaylistConfig.deleteStaticPlaylist(doomed.id);

    playlistManager.requestPlaylistSync([doomed.id]);
    await runNextSync();

    assert.deepEqual(serverPlaylists(servers), {
      navidrome: ["Kept"],
      plex: ["Doomed", "Kept"],
      jellyfin: ["Kept"],
    });
    assert.deepEqual(
      pendingSyncs().map(({ payload }) => payload),
      retried ? [followUp([doomed.id], "plex", "outage", 1)] : [],
    );
  });
}

test("one sync reads the Jellyfin library once however many playlists are missing tracks", async (t) => {
  const clock = useClock();
  const jellyfin = useJellyfin(t, "http://jellyfin-reads.test");
  const navidrome = useNavidrome();
  const playlists: string[] = [];
  const missing: { Id: string; Path: string }[] = [];
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
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp(playlists, "jellyfin", "indexing", 1)],
  );

  jellyfin.items.push(...missing);
  clock.advance(30_000);
  await runNextSync();
  assert.equal(jellyfin.reads, 2);
  assert.deepEqual(
    [...jellyfin.playlists.values()].map(({ itemIds }) => itemIds.length),
    [2, 2, 2, 2, 2],
  );
  assert.deepEqual(pendingSyncs(), []);
});

test("a finished Library download sends nothing to the media servers", async (t) => {
  const navidrome = useNavidrome([indexedSong("Library Song")]);
  const plex = usePlex(t);
  const { refreshCompletedPipelinePlaylist } =
    await import("../../backend/services/pipelineHelpers.ts");
  await addDownloadedTrack("library", "Library Song");

  await refreshCompletedPipelinePlaylist(downloadTracker.getByPlaylistId("library")[0]);
  assert.deepEqual(pendingSyncs(), []);
  await processSystemTask({ kind: "playback-playlist-sync", entityIds: ["library"], attempt: 0 });

  assert.deepEqual([...navidrome.requests], []);
  assert.deepEqual([...plex.reads], []);
  assert.deepEqual(pendingSyncs(), []);
});

test("a server that comes back after a long outage still gets the tracks it indexes later", async (t) => {
  const clock = useClock();
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
  clock.advance(30_000);
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
  plex.sections[9] = [{ ratingKey: "shared-song", addedAt: 1_000_000, file }];
  jellyfin.available = false;
  jellyfin.failureStatus = 401;
  plex.failReads = () => true;
  playlistManager.requestPlaylistSync([playlist.id]);

  for (let run = 0; run < 4; run += 1) await runNextSync();
  assert.equal(plex.reads.length, 4);
  plex.failReads = null;
  await drainSyncs();

  assert.equal(jellyfin.reads, 1);
  assert.deepEqual(serverPlaylists({ navidrome, plex, jellyfin }), {
    navidrome: ["Split"],
    plex: ["Split"],
    jellyfin: [],
  });
  assert.equal(
    navidrome.requests.filter((request) => request === "/rest/createPlaylist").length,
    1,
  );
});

test("a file downloaded again before Plex scans it stays off the playlist until Plex indexes the new file", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Upgraded" });
  const now = Math.floor(Date.now() / 1000) - plexEpoch;
  const track = await addDownloadedTrack(playlist.id, "Track");
  await fs.utimes(track, new Date(), new Date((plexEpoch + now - 200) * 1000));
  plex.sections[9] = [{ ratingKey: "182", addedAt: now - 100, file: track }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Upgraded: ["182"] });

  await fs.writeFile(track, "upgraded");
  await fs.utimes(track, new Date(), new Date((plexEpoch + now - 50) * 1000));
  const fresh = await addDownloadedTrack(
    playlist.id,
    "Fresh",
    path.join(downloadRoot, "Elsewhere"),
  );
  await fs.utimes(fresh, new Date(), new Date((plexEpoch + now - 200) * 1000));
  plex.sections[9].push({ ratingKey: "fresh", addedAt: now - 90, file: fresh });
  playlistManager.schedulePlaybackScan([track]);
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Upgraded: ["fresh"] });

  await runPendingScans();
  clock.advance(30_000);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, [`9 added since ${now - 390}`]);
  assert.deepEqual(plexRatingKeys(plex), { Upgraded: ["fresh"] });

  plex.sections[9] = [
    ...plex.sections[9].filter(({ ratingKey }) => ratingKey !== "182"),
    { ratingKey: "2446", addedAt: now - 40, file: track },
  ];
  clock.advance(90_000);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, [`9 added since ${now - 390}`]);
  assert.deepEqual(plexRatingKeys(plex), { Upgraded: ["2446", "fresh"] });
  assert.deepEqual(pendingSyncs(), []);
});

for (const recoveredId of ["before", "after"]) {
  test(`a moved Jellyfin track returns after scanning with item ID ${recoveredId}`, async (t: import("vite-plus/test").TestContext) => {
    const clock = useClock();
    const jellyfin = useJellyfin(t, `http://jellyfin-moved-${recoveredId}.test`);
    useOnly("jellyfin");
    const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Moved" });
    const before = path.join(downloadRoot, "Artist", "Album", "Song.flac");
    const after = path.join(downloadRoot, "Artist", "Album (Deluxe)", "Song.flac");
    t.onTestFinished(() => fs.rm(after, { force: true }));
    await fs.mkdir(path.dirname(before), { recursive: true });
    await fs.writeFile(before, "song");
    const jobId = downloadTracker.addJob(
      { artistName: "Artist", trackName: "Song", albumName: "Album", trackMbid: "recording-1" },
      playlist.id,
    );
    assert.ok(jobId != null);
    downloadTracker.setDone(jobId, before, "Album");
    const recording = { MusicBrainzTrack: "recording-1" };
    jellyfin.items = [{ Id: "before", Path: before, ProviderIds: recording }];
    playlistManager.requestPlaylistSync([playlist.id]);
    await runNextSync();
    assert.deepEqual(jellyfinItemsByName(jellyfin), { Moved: ["before"] });

    await fs.mkdir(path.dirname(after), { recursive: true });
    await fs.rename(before, after);
    downloadTracker.setDone(jobId, after, "Album (Deluxe)");
    playlistManager.schedulePlaybackScan([before, after]);
    playlistManager.requestPlaylistSync([playlist.id]);
    await runNextSync();
    assert.deepEqual(jellyfinItemsByName(jellyfin), { Moved: [] });

    await runPendingScans();
    clock.advance(30_000);
    await runNextSync();
    assert.equal(jellyfin.reads, 1);
    assert.deepEqual(jellyfinItemsByName(jellyfin), { Moved: [] });

    jellyfin.items = [{ Id: recoveredId, Path: after, ProviderIds: recording }];
    clock.advance(90_000);
    await runNextSync();
    assert.equal(jellyfin.reads, 2);
    assert.deepEqual(jellyfinItemsByName(jellyfin), { Moved: [recoveredId] });
    assert.deepEqual(pendingSyncs(), []);
  });
}

test("new flow tracks waiting on a pending scan do not make Plex read the whole section", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const flow = flowPlaylistConfig.createFlow({ name: "Batch Flow", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const flowRoot = path.join(downloadRoot, "_flows", flow.id);
  const first = await addDownloadedTrack(flow.id, "First", flowRoot);
  plex.sections[9] = [{ ratingKey: "first", addedAt: 1_000_000, file: first }];
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();

  clock.advance(31_000);
  plex.reads.length = 0;
  for (const title of ["Second", "Third", "Fourth"]) {
    const file = await addDownloadedTrack(flow.id, title, path.join(flowRoot, title));
    playlistManager.schedulePlaybackScan([file]);
    playlistManager.requestPlaylistSync([flow.id]);
  }
  await runNextSync();

  assert.deepEqual(plex.reads, ["9 added since 999700"]);
  assert.deepEqual(plexRatingKeys(plex), { "Batch Flow": ["first"] });
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([flow.id], "plex", "indexing", 1)],
  );
});

test("a flow track added to an album Plex already has keeps the album's other tracks on the playlist without a full read", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const flow = flowPlaylistConfig.createFlow({ name: "Album Flow", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const flowRoot = path.join(downloadRoot, "_flows", flow.id);
  const albumRoot = path.join(flowRoot, "Album Artist");
  const first = await addDownloadedTrack(flow.id, "First", albumRoot);
  const second = await addDownloadedTrack(flow.id, "Second", albumRoot);
  const other = await addDownloadedTrack(flow.id, "Other", path.join(flowRoot, "Other Artist"));
  plex.sections[9] = [
    { ratingKey: "first", addedAt: 1_000_000, file: first },
    { ratingKey: "second", addedAt: 1_000_000, file: second },
    { ratingKey: "other", addedAt: 1_000_000, file: other },
  ];
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  const everyTrack = { "Album Flow": ["first", "other", "second"] };
  assert.deepEqual(plexRatingKeys(plex), everyTrack);

  clock.advance(31_000);
  plex.reads.length = 0;
  const third = await addDownloadedTrack(flow.id, "Third", albumRoot);
  playlistManager.schedulePlaybackScan([third]);
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), everyTrack);

  await runPendingScans();
  clock.advance(31_000);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), everyTrack);

  plex.sections[9].push({ ratingKey: "third", addedAt: 1_000_060, file: third });
  clock.advance(60_000);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { "Album Flow": ["first", "other", "second", "third"] });
  assert.deepEqual(plex.reads, [
    "9 added since 999700",
    "9 added since 999700",
    "9 added since 999700",
  ]);
  assert.deepEqual(pendingSyncs(), []);
});

test("a file retagged in place keeps its Plex rating key once a read after the scan confirms it", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Retagged" });
  const track = await addDownloadedTrack(playlist.id, "Track");
  const steady = await addDownloadedTrack(
    playlist.id,
    "Steady",
    path.join(downloadRoot, "Elsewhere"),
  );
  for (const file of [track, steady])
    await fs.utimes(file, new Date(), new Date((plexEpoch - 2_000) * 1000));
  plex.sections[9] = [
    { ratingKey: "2637", addedAt: -1_000, file: track },
    { ratingKey: "steady", addedAt: 0, file: steady },
  ];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Retagged: ["2637", "steady"] });

  await fs.writeFile(track, "retagged");
  await fs.utimes(track, new Date(), new Date(Date.now()));
  playlistManager.schedulePlaybackScan([track]);
  playlistManager.requestPlaylistSync([playlist.id]);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since -300"]);
  assert.deepEqual(plexRatingKeys(plex), { Retagged: ["steady"] });

  await runPendingScans();
  clock.advance(91_000);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since -300", "all of 9"]);
  assert.deepEqual(plexRatingKeys(plex), { Retagged: ["2637", "steady"] });
  assert.deepEqual(pendingSyncs(), []);

  for (const advanceMs of [31_000, 600_000]) {
    clock.advance(advanceMs);
    playlistManager.requestPlaylistSync([playlist.id]);
    plex.reads.length = 0;
    await runNextSync();
    assert.deepEqual(plex.reads, ["9 added since -300"]);
    assert.deepEqual(plexRatingKeys(plex), { Retagged: ["2637", "steady"] });
  }

  await fs.utimes(track, new Date(), new Date(Date.now()));
  playlistManager.requestPlaylistSync([playlist.id]);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since -300"]);
  assert.deepEqual(plexRatingKeys(plex), { Retagged: ["steady"] });

  clock.advance(91_000);
  plex.reads.length = 0;
  await runNextSync();
  assert.deepEqual(plex.reads, ["9 added since -300", "all of 9"]);
  assert.deepEqual(plexRatingKeys(plex), { Retagged: ["2637", "steady"] });
  assert.deepEqual(pendingSyncs(), []);
});

test("a track outside every media server library does not make Plex or Jellyfin read everything", async (t) => {
  const clock = useClock();
  const jellyfin = useJellyfin(t, "http://jellyfin-outside.test");
  const plex = usePlex(t);
  const { integrations } = dbOps.getSettings();
  dbOps.updateSettings({
    integrations: { plex: integrations.plex, jellyfin: integrations.jellyfin },
  });
  jellyfin.locations = [downloadRoot];
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Outside" });
  const inside = await addDownloadedTrack(playlist.id, "Inside");
  await addDownloadedTrack(playlist.id, "Outside", lidarrRoot);
  plex.sections[9] = [{ ratingKey: "inside", addedAt: 1_000_000, file: inside }];
  jellyfin.items = [{ Id: "inside", Path: inside }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();

  clock.advance(31_000);
  plex.reads.length = 0;
  await runNextSync();

  assert.deepEqual(plex.reads, ["9 added since 999700"]);
  assert.equal(jellyfin.reads, 1);
  assert.deepEqual(plexRatingKeys(plex), { Outside: ["inside"] });
  assert.deepEqual(jellyfinItemsByName(jellyfin), { Outside: ["inside"] });
});

for (const server of ["plex", "jellyfin"]) {
  test(`five ${server} playlists missing a track make one full read per sync when that read fails`, async (t) => {
    const clock = useClock();
    const plex = server === "plex" ? usePlex(t) : null;
    const jellyfin =
      server === "jellyfin" ? useJellyfin(t, "http://jellyfin-failing-read.test") : null;
    useOnly(server);
    const ids: string[] = [];
    const missingPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const playlist = flowPlaylistConfig.createStaticPlaylist({ name: `Failing ${index}` });
      ids.push(playlist.id);
      const ready = await addDownloadedTrack(playlist.id, `Ready ${index}`);
      missingPaths.push(await addDownloadedTrack(playlist.id, `Missing ${index}`));
      plex?.sections[9].push({ ratingKey: `ready-${index}`, addedAt: 1_000_000, file: ready });
      jellyfin?.items.push({ Id: `ready-${index}`, Path: ready });
    }
    playlistManager.requestPlaylistSync(ids);
    await runNextSync();
    assert.deepEqual(
      pendingSyncs().map(({ payload }) => payload),
      [followUp(ids, server, "indexing", 1)],
    );

    clock.advance(31_000);
    if (plex) {
      plex.reads.length = 0;
      plex.failReads = (_sectionId, addedSince) => addedSince == null;
    } else {
      assert.ok(jellyfin);
      jellyfin.available = false;
    }
    await runNextSync();

    if (plex) assert.deepEqual(plex.reads, ["9 added since 999700", "all of 9"]);
    else assert.equal(jellyfin?.reads, 2);
    assert.deepEqual(
      pendingSyncs().map(({ payload }) => payload),
      [followUp(ids, server, "outage", 1)],
    );
    if (plex) {
      plex.failReads = null;
      plex.sections[9].push(
        ...missingPaths.map((file, index) => ({
          ratingKey: `missing-${index}`,
          addedAt: 1_000_001,
          file,
        })),
      );
      clock.advance(31_000);
      await runNextSync();
      assert.deepEqual(pendingSyncs(), []);
      assert.deepEqual(
        Object.values(plexRatingKeys(plex)),
        ids.map((_, index) => [`missing-${index}`, `ready-${index}`]),
      );
    }
  });
}

test("changing the Plex path mapping reads afresh and publishes the item the new mapping points at", async (t) => {
  const plex = usePlex(t, { mainLibrarySectionId: "5" });
  useOnly("plex");
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Mapped" });
  const local = await addDownloadedTrack(playlist.id, "Local");
  await addDownloadedTrack(playlist.id, "Song", lidarrRoot);
  plex.mainRoots = ["/music", "/archive"];
  plex.sections[9] = [{ ratingKey: "local", addedAt: 1_000_000, file: local }];
  plex.sections[5] = [
    { ratingKey: "music-copy", addedAt: 1_000_000, file: "/music/Artist/Album/Song.flac" },
    { ratingKey: "archive-copy", addedAt: 1_000_000, file: "/archive/Artist/Album/Song.flac" },
    { ratingKey: "newer", addedAt: 2_000_000, file: "/music/Other/Album/Newer.flac" },
  ];
  const mapPlexTo = (remote: string) =>
    dbOps.updateSettings({
      ...dbOps.getSettings(),
      pathMappings: [{ source: "plex", remote, local: lidarrRoot }],
    });
  mapPlexTo("/music");
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { Mapped: ["local", "music-copy"] });

  mapPlexTo("/archive");
  plex.reads.length = 0;
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();

  assert.deepEqual(plexRatingKeys(plex), { Mapped: ["archive-copy", "local"] });
  assert.deepEqual(plex.reads, ["all of 9", "all of 5"]);
});

test("a Plex main library that cannot be read still publishes a track linked into the Aurral library", async (t) => {
  const plex = usePlex(t, { mainLibrarySectionId: "5" });
  useOnly("plex");
  plex.failReads = (sectionId) => sectionId === "5";
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Linked" });
  const song = await addDownloadedTrack(playlist.id, "Song", lidarrRoot);
  const link = path.join(downloadRoot, "_flows", playlist.id, "Artist", "Album", "Song.flac");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(song, link);
  plex.sections[9] = [{ ratingKey: "linked", addedAt: 1_000_000, file: link }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();

  assert.deepEqual(plexRatingKeys(plex), { Linked: ["linked"] });
  assert.deepEqual(pendingSyncs(), []);
});

test("a retagged Plex flow file outside the download jobs is retried and restored", async (t) => {
  const clock = useClock();
  const plex = usePlex(t);
  useOnly("plex");
  const flow = flowPlaylistConfig.createFlow({ name: "Extra flow track", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const root = path.join(downloadRoot, "_flows", flow.id);
  const steady = await addDownloadedTrack(flow.id, "Steady", root);
  const extra = path.join(root, "Extra.flac");
  await fs.writeFile(extra, "extra");
  for (const file of [steady, extra])
    await fs.utimes(file, new Date(), new Date((plexEpoch - 2_000) * 1000));
  plex.sections[9] = [
    { ratingKey: "steady", addedAt: 0, file: steady },
    { ratingKey: "extra", addedAt: -1_000, file: extra },
  ];
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { "Extra flow track": ["extra", "steady"] });

  await fs.writeFile(extra, "retagged");
  await fs.utimes(extra, new Date(), new Date(Date.now()));
  playlistManager.schedulePlaybackScan([extra]);
  playlistManager.requestPlaylistSync([flow.id]);
  await runNextSync();
  assert.deepEqual(
    pendingSyncs().map(({ payload }) => payload),
    [followUp([flow.id], "plex", "indexing", 1)],
  );
  await runPendingScans();
  clock.advance(91_000);
  await runNextSync();
  assert.deepEqual(plexRatingKeys(plex), { "Extra flow track": ["extra", "steady"] });
  assert.deepEqual(pendingSyncs(), []);
});

test("Jellyfin retries a recording match outside its library paths when that recording arrives later", async (t) => {
  const clock = useClock();
  const jellyfin = useJellyfin(t, "http://jellyfin-recording-later.test");
  useOnly("jellyfin");
  jellyfin.locations = [downloadRoot];
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Recording match" });
  const ready = await addDownloadedTrack(playlist.id, "Ready");
  const outside = await addDownloadedTrack("library", "Recording", lidarrRoot);
  const job = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Recording", trackMbid: "recording-later" },
    playlist.id,
  );
  assert.ok(job != null);
  downloadTracker.setDone(job, outside, "Album");
  jellyfin.items = [{ Id: "ready", Path: ready }];
  playlistManager.requestPlaylistSync([playlist.id]);
  await runNextSync();
  assert.deepEqual(jellyfinItemsByName(jellyfin), { "Recording match": ["ready"] });

  jellyfin.items.push({
    Id: "recording",
    Path: path.join(downloadRoot, "Other copy.flac"),
    ProviderIds: { MusicBrainzTrack: "recording-later" },
  });
  clock.advance(31_000);
  await runNextSync();
  assert.deepEqual(jellyfinItemsByName(jellyfin), { "Recording match": ["ready", "recording"] });
  assert.deepEqual(pendingSyncs(), []);
});
