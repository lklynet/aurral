import * as v from "valibot";
import { requireFixture } from "../playlists/fixtures.ts";
import type * as Rows from "../../backend/db/rows.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { callFromProcessesWhileHonkerLocked } from "../helpers/playlistManagerCallers.ts";

vi.mock("../../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});
vi.mock("../../backend/services/metadataProviderBudget.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend/services/metadataProviderBudget.ts")>()),
  reserveMetadataProviderRequest: () => 0,
}));

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
process.env.AURRAL_HONKER_WATCHER_POLL_MS = "1";
const [
  state,
  { db },
  { dbOps },
  honker,
  scans,
  { playlistManager },
  { processSystemTask, systemTaskSchema },
  { NavidromeClient },
  { PlexClient },
  { JellyfinClient },
  { getLibrary },
  { logger },
  { createPlaybackDeletionGuard },
  { downloadTracker },
  { flowPlaylistConfig },
  { processPlaylistOperation },
  { downloadWorker, DownloadWorker },
  { lidarrClient },
  libraryFileOperations,
  { libraryManager },
  { createLibraryFileWatcher },
  { createIsolatedLibraryWatcher },
  { default: axios },
] = await setupIsolatedBackend(
  "library-scan-playback",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/libraryScanWorker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/navidrome.ts"),
  () => import("../../backend/services/plex.ts"),
  () => import("../../backend/services/jellyfin.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/logger.ts"),
  () => import("../../backend/services/playback/playbackFileRetention.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/libraryFiles/operations.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/libraryFileWatcher.ts"),
  () => import("../../backend/services/libraryWatchProcess.ts"),
  () => import("../../lib/axiosFetch.ts"),
);

const downloadRoot = playlistManager.downloadRoot;
const lidarrRoot = path.join(state.baseDir, "lidarr-music");
const mediaServers = {
  navidrome: { url: "http://navidrome.test", username: "test", password: "password" },
  plex: { url: "http://plex.test", token: "test-token", downloadsPath: "/plex/aurral" },
  jellyfin: { url: "http://jellyfin.test", apiKey: "test-key", userId: "test-user" },
};
const lidarr = {
  enabled: true,
  url: "http://127.0.0.1:9",
  apiKey: "test-key",
  rootFolderPath: lidarrRoot,
};

beforeEach(async () => {
  await rm(downloadRoot, { recursive: true, force: true });
  await rm(lidarrRoot, { recursive: true, force: true });
  resetDatabase(db);
  downloadTracker.clearAll();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  dbOps.updateSettings({
    integrations: mediaServers,
    pathMappings: [
      { source: "jellyfin", remote: "/jellyfin/aurral", local: downloadRoot },
      { source: "jellyfin", remote: "/jellyfin/lidarr", local: lidarrRoot },
      { source: "navidrome", remote: "/navidrome/aurral", local: downloadRoot },
      { source: "navidrome", remote: "/navidrome/lidarr", local: lidarrRoot },
    ],
  });
});

afterAll(async () => {
  await scans.stopLibraryScanWorker();
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

type MediaServerRequest = {
  service: string;
  endpoint: string;
  method?: string;
  data?: unknown;
  params?: unknown;
};

function stubMediaServers(
  t: import("vite-plus/test").TestContext,
  {
    failed = null,
    navidromeLibraries = [
      { id: 1, path: "/navidrome/aurral" },
      { id: 2, path: "/navidrome/lidarr" },
    ],
    jellyfinLocations = ["/jellyfin/aurral", "/jellyfin/lidarr"],
    navidromeScanning = () => false,
  }: {
    failed?: string | null;
    navidromeLibraries?: { id: number; path: string }[];
    jellyfinLocations?: string[];
    navidromeScanning?: () => boolean;
  } = {},
) {
  const requests: MediaServerRequest[] = [];
  const record = (service: string, request: Omit<MediaServerRequest, "service">) => {
    requests.push({ service, ...request });
    if (failed === service) throw new Error(`${service} unavailable`);
    return {};
  };
  vi.spyOn(PlexClient.prototype, "request").mockImplementation(async (endpoint, { params } = {}) =>
    record("Plex", { endpoint, params }),
  );
  vi.spyOn(JellyfinClient.prototype, "request").mockImplementation(
    async (method, endpoint, { data } = {}) =>
      endpoint === "/Library/VirtualFolders"
        ? jellyfinLocations.map((location) => ({ Locations: [location] }))
        : record("Jellyfin", { method, endpoint, data }),
  );
  vi.spyOn(NavidromeClient.prototype, "request").mockImplementation(
    async (endpoint, params = {}) =>
      endpoint === "getScanStatus"
        ? { scanStatus: { scanning: navidromeScanning() } }
        : record("Navidrome", { endpoint, params }),
  );
  vi.spyOn(NavidromeClient.prototype, "getLibraries").mockImplementation(async () =>
    navidromeLibraries.map((library) => ({ ...library, name: library.path })),
  );
  vi.spyOn(PlexClient.prototype, "ensureAurralLibrary").mockImplementation(async () => ({
    key: "7",
    type: "artist",
    title: "Aurral",
  }));
  vi.spyOn(PlexClient.prototype, "getTracks").mockImplementation(async () => []);
  return requests;
}

const jellyfinUpdate = (...paths: string[]) => ({
  service: "Jellyfin",
  method: "POST",
  endpoint: "/Library/Media/Updated",
  data: { Updates: paths.map((Path) => ({ Path, UpdateType: "Modified" })) },
});
const plexRefresh = (folder: string) => ({
  service: "Plex",
  endpoint: "/library/sections/7/refresh",
  params: { path: folder },
});
const plexSectionRefresh = {
  service: "Plex",
  endpoint: "/library/sections/7/refresh",
  params: undefined,
};
const navidromeScan = (...target: string[]) => ({
  service: "Navidrome",
  endpoint: "startScan",
  params: { target },
});
const navidromeScanAll = { service: "Navidrome", endpoint: "startScan", params: {} };
const byService = (requests: MediaServerRequest[]) =>
  [...requests].sort((left, right) => left.service.localeCompare(right.service));

function pendingScans() {
  return honker.listHonkerJobs("playback").map(({ id, run_at: runAt, payload }) => ({
    id,
    runAt,
    folders: requireValue(payload).folders,
  }));
}

function setRunAt(jobId: number, runAt: number) {
  const tx = honker.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_live SET run_at = ? WHERE id = ?", [runAt, jobId]);
  tx.commit();
}

function riffChunk(id: string, body: Buffer<ArrayBuffer>) {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}

async function makeTrack(filePath: string, title: string = "Song", artist: string = "Scan Artist") {
  const stereo16BitPcm = Buffer.alloc(16);
  stereo16BitPcm.writeUInt16LE(1, 0);
  stereo16BitPcm.writeUInt16LE(2, 2);
  stereo16BitPcm.writeUInt32LE(44100, 4);
  stereo16BitPcm.writeUInt32LE(44100 * 4, 8);
  stereo16BitPcm.writeUInt16LE(4, 12);
  stereo16BitPcm.writeUInt16LE(16, 14);
  const tags = [
    ["IART", artist],
    ["INAM", title],
    ["IPRD", "Album"],
  ].map(([id, text]) => riffChunk(id, Buffer.from(`${text}\0`, "utf8")));
  const silence = Buffer.alloc(2205 * 4);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    riffChunk(
      "RIFF",
      Buffer.concat([
        Buffer.from("WAVE", "latin1"),
        riffChunk("fmt ", stereo16BitPcm),
        riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "latin1"), ...tags])),
        riffChunk("data", silence),
      ]),
    ),
  );
}

const axiosResponse = <T>(data: T) => ({ status: 200, statusText: "OK", headers: {}, data });

async function libraryScanRunner(t: import("vite-plus/test").TestContext) {
  vi.spyOn(axios, "get").mockResolvedValue(axiosResponse([]));
  const events = honker.getHonkerDb().updateEvents();
  t.onTestFinished(async () => {
    events.close();
    await scans.stopLibraryScanWorker();
  });
  const finish = async (id: number | null) => {
    void scans.startLibraryScanWorker();
    while (scans.getLibraryScanStatus(requireValue(id))?.status !== "completed") {
      assert.notEqual(scans.getLibraryScanStatus(requireValue(id))?.status, "failed");
      await events.next();
    }
  };
  const runScan = (options: Parameters<typeof scans.scheduleLibraryScan>[0]) =>
    finish(scans.scheduleLibraryScan({ includeLidarr: false, ...options }));
  runScan.scheduled = () => finish(scans.getScheduledLibraryScanJobId());
  return runScan;
}

function playlistReferences(t: import("vite-plus/test").TestContext, paths: string[]) {
  const { destinationRegistry } = playlistManager;
  const run = destinationRegistry.run.bind(destinationRegistry);
  vi.spyOn(destinationRegistry, "run").mockImplementation(async (method, request) =>
    method === "getReferencedPaths"
      ? paths.map((file) => ({
          destination: "Plex",
          key: "plex",
          operation: method,
          ok: true,
          paths: [file],
        }))
      : run(method, request),
  );
  return paths;
}

async function waitUntil(ready: () => boolean) {
  const events = honker.getHonkerDb().updateEvents();
  try {
    while (!ready()) await events.next();
  } finally {
    events.close();
  }
}

const availablePaths = () =>
  db
    .prepare<unknown[], { path: Rows.LibraryMediaFilesRow["path"] }>(
      "SELECT path FROM library_media_files WHERE available = 1 ORDER BY path",
    )
    .all()
    .map((row) => row.path);

const cancelPendingScans = () => {
  for (const { id } of pendingScans()) honker.getPlaybackTaskQueue().cancel(id);
};

async function runPendingScan() {
  const [job] = honker.listHonkerJobs("playback");
  honker.getPlaybackTaskQueue().cancel(job.id);
  await processSystemTask(v.parse(systemTaskSchema, job.payload));
}

test("media scan requests batch changed folders into one durable job that keeps its first run time", async () => {
  const artist = path.join(downloadRoot, "Artist");
  const album = path.join(artist, "Album");
  const single = path.join(artist, "Single");
  await mkdir(album, { recursive: true });
  await mkdir(single, { recursive: true });

  const first = playlistManager.schedulePlaybackScan([path.join(album, "01.flac")]);
  const [queued] = pendingScans();
  assert.deepEqual(queued, { id: first, runAt: queued.runAt, folders: [album] });
  const firstRunAt = queued.runAt - 10;
  setRunAt(first, firstRunAt);
  honker.closeHonkerDb();
  playlistManager.schedulePlaybackScan([path.join(single, "01.flac"), path.join(album, "02.flac")]);
  assert.deepEqual(
    pendingScans().map(({ runAt, folders }) => ({ runAt, folders })),
    [{ runAt: firstRunAt, folders: [album, single] }],
  );
  playlistManager.schedulePlaybackScan([path.join(artist, "Removed", "01.flac")]);
  assert.deepEqual(
    pendingScans().map(({ runAt, folders }) => ({ runAt, folders })),
    [{ runAt: firstRunAt, folders: [artist] }],
  );

  const [batched] = pendingScans();
  setRunAt(batched.id, 0);
  const active = honker.getPlaybackTaskQueue().claimOne(honker.getWorkerId());
  assert.ok(active != null);
  assert.equal(active.id, batched.id);
  playlistManager.schedulePlaybackScan([path.join(album, "03.flac")]);
  playlistManager.schedulePlaybackScan([path.join(single, "02.flac")]);
  active.ack();
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[album, single]],
  );
  const missingMount = path.join(state.baseDir, "missing-mount");
  dbOps.updateSettings({
    integrations: { ...mediaServers, lidarr: { ...lidarr, rootFolderPath: missingMount } },
  });
  playlistManager.schedulePlaybackScan([
    path.join(missingMount, "Artist", "Album", "01.flac"),
    path.join(state.baseDir, "outside-the-library", "01.flac"),
  ]);
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[missingMount, album, single]],
  );
  const [retried] = pendingScans();
  setRunAt(retried.id, 0);
  requireValue(
    requireValue(
      requireFixture(honker)
        .getPlaybackTaskQueue()!
        .claimOne(honker.getWorkerId())!
        .retry(60, "Plex unavailable"),
    ),
  );
  playlistManager.schedulePlaybackScan([path.join(album, "04.flac")]);
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[missingMount, album, single], [album]],
  );
  dbOps.updateSettings({ integrations: {} });
  assert.equal(playlistManager.schedulePlaybackScan([album]), null);
});

test(
  "media scan requests from two processes at once both land in the pending job",
  { timeout: 20000 },
  async (t) => {
    const [first, second, third] = ["First", "Second", "Third"].map((name) =>
      path.join(downloadRoot, name, "Album"),
    );
    await Promise.all([first, second, third].map((album) => mkdir(album, { recursive: true })));
    const pendingId = playlistManager.schedulePlaybackScan([first]);
    const jobIds = await callFromProcessesWhileHonkerLocked(t, honker, "schedulePlaybackScan", [
      [[path.join(second, "01.flac")]],
      [[path.join(third, "01.flac")]],
    ]);

    assert.deepEqual(jobIds, [pendingId, pendingId]);
    assert.deepEqual(
      pendingScans().map(({ id, folders }) => ({ id, folders })),
      [{ id: pendingId, folders: [first, second, third] }],
    );
  },
);

test("a batch of more than 20 folders under one root becomes that root and leaves other roots alone", async () => {
  dbOps.updateSettings({ integrations: { ...mediaServers, lidarr } });
  const albums = Array.from({ length: 410 }, (_, index) =>
    path.join(downloadRoot, `Artist ${index}`, "Album"),
  );
  const lidarrAlbum = path.join(lidarrRoot, "Artist", "Album");
  await Promise.all([...albums, lidarrAlbum].map((album) => mkdir(album, { recursive: true })));
  const tracks = (folders: string[]) =>
    folders.flatMap((album) =>
      Array.from({ length: 10 }, (_, index) => path.join(album, `${index}.flac`)),
    );
  const artist1 = path.join(downloadRoot, "Artist 1");

  playlistManager.schedulePlaybackScan([
    ...tracks(albums.slice(0, 20)),
    artist1,
    path.join(lidarrAlbum, "01.flac"),
  ]);
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[artist1, ...albums.slice(0, 20).filter((_, index) => index !== 1), lidarrAlbum].sort()],
  );

  playlistManager.schedulePlaybackScan(tracks(albums.slice(20, 21)));
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[downloadRoot, lidarrAlbum].sort()],
  );

  playlistManager.schedulePlaybackScan(tracks(albums.slice(21)));
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[downloadRoot, lidarrAlbum].sort()],
  );
});

test("a queued media scan without folders reports unavailable services and scans Aurral's roots", async (t) => {
  dbOps.updateSettings({ integrations: { ...mediaServers, lidarr } });
  for (const service of ["Navidrome", "Plex", "Jellyfin"]) {
    const failed = stubMediaServers(t, { failed: service });
    await assert.rejects(
      processSystemTask({ kind: "playback-library-scan" }),
      new RegExp(`${service} unavailable`),
    );
    assert.deepEqual(failed.map((request) => request.service).sort(), [
      "Jellyfin",
      "Navidrome",
      "Plex",
    ]);
    vi.restoreAllMocks();
  }
  const recovered = stubMediaServers(t);
  await processSystemTask({ kind: "playback-library-scan" });
  assert.deepEqual(byService(recovered), [
    jellyfinUpdate("/jellyfin/aurral", "/jellyfin/lidarr"),
    navidromeScan("1:", "2:"),
    plexSectionRefresh,
  ]);
  dbOps.updateSettings({ integrations: {} });
  await processSystemTask({ kind: "playback-library-scan" });
  assert.equal(recovered.length, 3);
});

test("a Downloads Folder inside a Lidarr root is still scanned on every server", async (t) => {
  const musicRoot = state.baseDir;
  dbOps.updateSettings({
    integrations: { ...mediaServers, lidarr: { ...lidarr, rootFolderPath: musicRoot } },
    pathMappings: [
      { source: "jellyfin", remote: "/jellyfin/aurral", local: downloadRoot },
      { source: "jellyfin", remote: "/jellyfin/music", local: musicRoot },
      { source: "navidrome", remote: "/navidrome/aurral", local: downloadRoot },
      { source: "navidrome", remote: "/navidrome/music", local: musicRoot },
    ],
  });
  const requests = stubMediaServers(t, {
    navidromeLibraries: [
      { id: 1, path: "/navidrome/aurral" },
      { id: 2, path: "/navidrome/music" },
    ],
    jellyfinLocations: ["/jellyfin/aurral", "/jellyfin/music"],
  });

  await processSystemTask({ kind: "playback-library-scan" });
  assert.deepEqual(byService(requests), [
    jellyfinUpdate("/jellyfin/aurral", "/jellyfin/music"),
    navidromeScan("1:", "2:"),
    plexSectionRefresh,
  ]);

  requests.length = 0;
  const album = path.join(downloadRoot, "Artist", "Album");
  await mkdir(album, { recursive: true });
  playlistManager.schedulePlaybackScan([path.join(album, "01.flac")]);
  playlistManager.schedulePlaybackScan([musicRoot]);
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[musicRoot, album]],
  );
  await runPendingScan();
  assert.deepEqual(byService(requests), [
    jellyfinUpdate("/jellyfin/music", "/jellyfin/aurral/Artist/Album"),
    navidromeScan("2:", "1:Artist/Album"),
    plexRefresh("/plex/aurral/Artist/Album"),
  ]);
});

test("a folder a server cannot place in its libraries gets a broad scan instead of none", async (t) => {
  const musicRoot = state.baseDir;
  const downloads = path.relative(musicRoot, downloadRoot).split(path.sep).join("/");
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  dbOps.updateSettings({
    integrations: { ...mediaServers, lidarr: { ...lidarr, rootFolderPath: musicRoot } },
    pathMappings: [
      { source: "jellyfin", remote: `/media/${downloads}`, local: downloadRoot },
      { source: "navidrome", remote: `/media/${downloads}`, local: downloadRoot },
    ],
  });
  const requests = stubMediaServers(t, {
    navidromeLibraries: [{ id: 1, path: "/media" }],
    jellyfinLocations: ["/media"],
  });
  const album = path.join(downloadRoot, "Artist", "Album");
  await mkdir(album, { recursive: true });

  playlistManager.schedulePlaybackScan([path.join(album, "01.flac")]);
  playlistManager.schedulePlaybackScan([musicRoot]);
  await runPendingScan();

  const lidarrAlbum = path.join(musicRoot, "Lidarr Artist", "Album");
  await mkdir(lidarrAlbum, { recursive: true });
  playlistManager.schedulePlaybackScan([path.join(lidarrAlbum, "01.flac")]);
  await runPendingScan();

  assert.deepEqual(byService(requests), [
    jellyfinUpdate("/media"),
    jellyfinUpdate("/media"),
    navidromeScanAll,
    navidromeScanAll,
    plexRefresh("/plex/aurral/Artist/Album"),
  ]);
  assert.deepEqual(
    warn.mock.calls
      .map(([category, , data]) => [category, (requireValue(data) as { folder: string }).folder])
      .sort(),
    [
      ["jellyfin", musicRoot],
      ["navidrome", musicRoot],
    ],
  );
});

test("folders that arrive while Navidrome is scanning reach Navidrome once it is free and the other servers once", async (t) => {
  let navidromeBusy = false;
  const requests = stubMediaServers(t, { navidromeScanning: () => navidromeBusy });
  const [first, second, third] = ["First", "Second", "Third"].map((name) =>
    path.join(downloadRoot, name, "Album"),
  );
  await Promise.all([first, second, third].map((album) => mkdir(album, { recursive: true })));
  const pendingPayloads = () => honker.listHonkerJobs("playback").map(({ payload }) => payload);
  const navidromeOnly = (...folders: string[]) => ({
    kind: "playback-library-scan",
    folders,
    destinations: ["navidrome"],
  });

  playlistManager.schedulePlaybackScan([first]);
  await runPendingScan();
  navidromeBusy = true;
  playlistManager.schedulePlaybackScan([second]);
  await runPendingScan();
  assert.deepEqual(pendingPayloads(), [navidromeOnly(second)]);

  playlistManager.schedulePlaybackScan([third]);
  await runPendingScan();
  await runPendingScan();
  assert.deepEqual(pendingPayloads(), [navidromeOnly(second, third)]);

  navidromeBusy = false;
  await runPendingScan();
  assert.deepEqual(pendingPayloads(), []);
  assert.deepEqual(byService(requests), [
    jellyfinUpdate("/jellyfin/aurral/First/Album"),
    jellyfinUpdate("/jellyfin/aurral/Second/Album"),
    jellyfinUpdate("/jellyfin/aurral/Third/Album"),
    navidromeScan("1:First/Album"),
    navidromeScan("1:Second/Album", "1:Third/Album"),
    plexRefresh("/plex/aurral/First/Album"),
    plexRefresh("/plex/aurral/Second/Album"),
    plexRefresh("/plex/aurral/Third/Album"),
  ]);
});

test(
  "an untargeted library scan tells servers only the folders whose files it changed",
  { timeout: 10000 },
  async (t) => {
    const requests = stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const settled = async (folders: string[][]) => {
      assert.deepEqual(
        pendingScans().map((scan) => scan.folders),
        folders,
      );
      for (const { id } of pendingScans()) honker.getPlaybackTaskQueue().cancel(id);
    };
    await makeTrack(path.join(downloadRoot, "Other Artist", "Album", "Other.wav"), "Other");
    await runScan({});
    await settled([[path.join(downloadRoot, "Other Artist", "Album")]]);

    const album = path.join(downloadRoot, "Scan Artist", "Album");
    await makeTrack(path.join(album, "Song.wav"));
    await runScan({});
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[album]],
    );
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate("/jellyfin/aurral/Scan Artist/Album"),
      navidromeScan("1:Scan Artist/Album"),
      plexRefresh("/plex/aurral/Scan Artist/Album"),
    ]);
    await rm(path.join(album, "Song.wav"));
    await runScan({});
    await settled([[album]]);
    await runScan({});
    await settled([]);

    const shown = flowPlaylistConfig.createFlow({ name: "Shown Flow", size: 10 });
    flowPlaylistConfig.updateFlow(shown.id, { showInLibrary: true });
    const flowFile = path.join(
      downloadRoot,
      "_flows",
      shown.id,
      "Scan Artist",
      "Album",
      "Flow.wav",
    );
    await makeTrack(flowFile, "Flow Song");
    downloadTracker.setDone(
      requireValue(
        downloadTracker.addJob({ artistName: "Scan Artist", trackName: "Flow Song" }, shown.id),
      ),
      flowFile,
      "Album",
    );
    await runScan({});
    await settled([[path.dirname(flowFile)]]);
    downloadTracker.clearByPlaylistId(shown.id);
    await runScan({});
    await settled([[path.dirname(flowFile)]]);

    const hiddenFlowFile = path.join(downloadRoot, "_flows", "hidden-flow", "Song.wav");
    await makeTrack(hiddenFlowFile);
    await runScan({ changedPaths: [hiddenFlowFile] });
    await settled([[path.dirname(hiddenFlowFile)]]);

    requests.length = 0;
    dbOps.updateSettings({ integrations: { ...mediaServers, lidarr } });
    const lidarrAlbum = path.join(lidarrRoot, "Lidarr Artist", "Album");
    await makeTrack(path.join(lidarrAlbum, "Song.wav"), "Lidarr Song");
    await runScan({ includeLidarr: true });
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[lidarrAlbum]],
    );
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate("/jellyfin/lidarr/Lidarr Artist/Album"),
      navidromeScan("2:Lidarr Artist/Album"),
    ]);

    const retiredRoot = path.join(state.baseDir, "retired-lidarr-music");
    const retiredAlbum = path.join(retiredRoot, "Retired Artist", "Album");
    await makeTrack(path.join(retiredAlbum, "Song.wav"), "Retired Song");
    dbOps.updateSettings({
      integrations: { ...mediaServers, lidarr: { ...lidarr, rootFolderPaths: [retiredRoot] } },
    });
    await runScan({ includeLidarr: true });
    await settled([[retiredAlbum]]);
    dbOps.updateSettings({ integrations: { ...mediaServers, lidarr } });
    await runScan({ includeLidarr: true });
    assert.equal(
      getLibrary({ availableOnly: true }).tracks.some((track) => track.title === "Retired Song"),
      false,
    );
    await settled([]);
  },
);

test(
  "a library scan that removes a retained flow file reports its folder to the servers",
  { timeout: 10000 },
  async (t) => {
    const requests = stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const flowAlbum = path.join(downloadRoot, "_flows", "old-flow", "Artist", "Album");
    const retained = path.join(flowAlbum, "Song.flac");
    await mkdir(flowAlbum, { recursive: true });
    await writeFile(retained, "audio");
    const referenced = playlistReferences(t, [retained]);
    assert.equal(await createPlaybackDeletionGuard().canDelete(retained), false);
    referenced.length = 0;
    const track = path.join(downloadRoot, "Scan Artist", "Album", "Song.wav");
    await makeTrack(track);

    await runScan({ changedPaths: [track] });

    await assert.rejects(access(retained), { code: "ENOENT" });
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate(
        "/jellyfin/aurral/Scan Artist/Album",
        "/jellyfin/aurral/_flows/old-flow/Artist/Album",
      ),
      navidromeScan("1:Scan Artist/Album", "1:_flows/old-flow/Artist/Album"),
      plexRefresh("/plex/aurral/Scan Artist/Album"),
      plexRefresh("/plex/aurral/_flows/old-flow/Artist/Album"),
    ]);
  },
);

test(
  "a retained Library file deleted by a scan leaves the Library and reaches the servers, even when that scan fails",
  { timeout: 20000 },
  async (t: import("vite-plus/test").TestContext) => {
    const requests = stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const referenced = playlistReferences(t, []);
    const retain = async (filePath: string, title: string) => {
      await makeTrack(filePath, title);
      await runScan({ changedPaths: [filePath] });
      for (const { id } of pendingScans()) honker.getPlaybackTaskQueue().cancel(id);
      referenced.push(filePath);
      assert.equal(await createPlaybackDeletionGuard().canDelete(filePath), false);
      referenced.length = 0;
    };
    const availableTitles = () =>
      getLibrary({ availableOnly: true })
        .tracks.map((track) => track.title)
        .sort();
    const oldAlbum = path.join(downloadRoot, "Old Artist", "Album");
    await retain(path.join(oldAlbum, "Old.wav"), "Old Song");
    const album = path.join(downloadRoot, "Scan Artist", "Album");
    await makeTrack(path.join(album, "Song.wav"));

    await runScan({ changedPaths: [path.join(album, "Song.wav")] });

    await assert.rejects(access(path.join(oldAlbum, "Old.wav")), { code: "ENOENT" });
    assert.deepEqual(availableTitles(), ["Song"]);
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate("/jellyfin/aurral/Old Artist/Album", "/jellyfin/aurral/Scan Artist/Album"),
      navidromeScan("1:Old Artist/Album", "1:Scan Artist/Album"),
      plexRefresh("/plex/aurral/Old Artist/Album"),
      plexRefresh("/plex/aurral/Scan Artist/Album"),
    ]);

    requests.length = 0;
    const goneAlbum = path.join(downloadRoot, "Gone Artist", "Album");
    await retain(path.join(goneAlbum, "Gone.wav"), "Gone Song");
    await scans.stopLibraryScanWorker();
    const events = honker.getHonkerDb().updateEvents();
    t.onTestFinished(() => events.close());
    const jobId = scans.scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: [path.join(album, "Song.wav")],
    });
    while (pendingScans().length === 0) await events.next();
    const failed = vi.spyOn(lidarrClient, "isConfigured").mockImplementationOnce(() => {
      throw new Error("Lidarr check failed");
    });
    void scans.startLibraryScanWorker();
    const job = () => scans.getLibraryScanStatus(jobId);
    while (!(failed.mock.calls.length > 0 && requireValue(job()).status === "queued"))
      await events.next();
    await assert.rejects(access(path.join(goneAlbum, "Gone.wav")), { code: "ENOENT" });
    assert.deepEqual(availableTitles(), ["Gone Song", "Song"]);
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[goneAlbum, album]],
    );
    setRunAt(jobId, 0);
    while (requireValue(job()).status !== "completed") await events.next();

    assert.deepEqual(availableTitles(), ["Song"]);
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[goneAlbum, album]],
    );
  },
);

test(
  "deleting a flow indexes a shared file moved into the Downloads Folder and tells servers both folders",
  { timeout: 10000 },
  async (t) => {
    const requests = stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    playlistReferences(t, []);
    assert.ok(downloadWorker instanceof DownloadWorker);
    vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
    vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
    vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation(() => true);
    vi.spyOn(downloadWorker, "setRetryCyclePaused").mockImplementation(() => true);
    vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
    const flow = flowPlaylistConfig.createFlow({ name: "Hidden Flow", size: 10 });
    const original = path.join(downloadRoot, "_flows", flow.id, "Scan Artist", "Album", "Song.wav");
    await makeTrack(original);
    const jobIds = [flow.id, "library"].map((playlistType) => {
      const jobId = downloadTracker.addJob(
        { artistName: "Scan Artist", trackName: "Song" },
        playlistType,
      );
      assert.ok(jobId != null);
      downloadTracker.setDone(jobId, original, "Album");
      return jobId;
    });

    await processPlaylistOperation({ kind: "delete-flow", flowId: flow.id });
    await runScan.scheduled();

    const moved = path.join(downloadRoot, "Scan Artist", "Album", "Song.wav");
    assert.equal(requireValue(downloadTracker.getJob(jobIds[1])).finalPath, moved);
    assert.deepEqual(
      db
        .prepare<unknown[], { path: Rows.LibraryMediaFilesRow["path"] }>(
          "SELECT path FROM library_media_files WHERE available = 1",
        )
        .all()
        .map((row) => row.path),
      [moved],
    );
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate("/jellyfin/aurral/Scan Artist/Album", "/jellyfin/aurral/_flows"),
      navidromeScan("1:Scan Artist/Album", "1:_flows"),
      plexRefresh("/plex/aurral/Scan Artist/Album"),
      plexRefresh("/plex/aurral/_flows"),
    ]);
  },
);

test(
  "a Library scan stopped after indexing has already queued its server notice",
  { timeout: 10000 },
  async (t) => {
    stubMediaServers(t);
    await libraryScanRunner(t);
    const album = path.join(downloadRoot, "Held Artist", "Album");
    await makeTrack(path.join(album, "Song.wav"), "Song", "Held Artist");
    let release!: (value: ReturnType<typeof axiosResponse<never[]>>) => void;
    const held = new Promise<void>((resolve) => {
      vi.mocked(axios.get).mockImplementationOnce(() => {
        resolve();
        return new Promise<ReturnType<typeof axiosResponse<never[]>>>((resume) => {
          release = resume;
        });
      });
    });

    const jobId = scans.scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: [path.join(album, "Song.wav")],
    });
    void scans.startLibraryScanWorker();
    await held;

    const [requested] = pendingScans();
    try {
      assert.deepEqual(availablePaths(), [path.join(album, "Song.wav")]);
      assert.deepEqual(pendingScans(), [{ ...requested, folders: [album] }]);
    } finally {
      release(axiosResponse([]));
    }
    await waitUntil(() => requireValue(scans.getLibraryScanStatus(jobId)).status === "completed");
    assert.deepEqual(pendingScans(), [requested]);
  },
);

test(
  "Clean up tells servers the folders it moved files out of and into",
  { timeout: 10000 },
  async (t) => {
    stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const loose = path.join(downloadRoot, "Scan Artist", "loose");
    const oldPath = path.join(loose, "track.wav");
    await makeTrack(oldPath);
    await writeFile(path.join(loose, "notes.txt"), "kept");
    await runScan({ changedPaths: [oldPath] });
    cancelPendingScans();

    const operation = await libraryFileOperations.startCleanup();
    assert.ok(operation != null);
    while (!(await libraryFileOperations.runLibraryFileOperation(operation.id)).done);
    await runScan.scheduled();

    const [newPath] = availablePaths();
    assert.notEqual(path.dirname(newPath), loose);
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[path.dirname(newPath), loose].sort()],
    );
  },
);

test(
  "deleting a Library track tells servers its album folder",
  { timeout: 15000 },
  async (t: import("vite-plus/test").TestContext) => {
    stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const album = path.join(downloadRoot, "Scan Artist", "Album");
    await makeTrack(path.join(album, "Kept.wav"), "Kept");
    await makeTrack(path.join(album, "Removed.wav"), "Removed");
    await runScan({
      changedPaths: [path.join(album, "Kept.wav"), path.join(album, "Removed.wav")],
    });
    cancelPendingScans();
    let ready;
    const watcher = createLibraryFileWatcher({
      roots: [downloadRoot],
      debounceMs: 0,
      watchImpl: (...args) => {
        const child = createIsolatedLibraryWatcher(...args);
        ready = once(child, "ready");
        return child;
      },
    });
    t.onTestFinished(() => watcher.close());
    await ready;

    const removed = getLibrary({ availableOnly: true }).tracks.find(
      (track) => track.title === "Removed",
    );
    assert.ok(removed != null);
    assert.deepEqual(await libraryManager.deleteTrack(String(removed.id)), { success: true });
    await waitUntil(() => scans.getScheduledLibraryScanJobId() != null);
    await runScan.scheduled();

    assert.deepEqual(
      getLibrary({ availableOnly: true }).tracks.map((track) => track.title),
      ["Kept"],
    );
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[album]],
    );
  },
);

test(
  "a hidden flow download that joins a pending full Library scan still reaches the servers",
  { timeout: 10000 },
  async (t) => {
    stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const flow = flowPlaylistConfig.createFlow({ name: "Hidden Flow", size: 10 });
    const flowFile = path.join(downloadRoot, "_flows", flow.id, "Scan Artist", "Album", "Song.wav");
    await makeTrack(flowFile);

    scans.scheduleLibraryScan({ includeLidarr: false });
    scans.scheduleLibraryScan({ includeLidarr: false, changedPaths: [flowFile] });
    await runScan.scheduled();

    assert.deepEqual(availablePaths(), []);
    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[path.dirname(flowFile)]],
    );
  },
);

test("a file the Library skips still reaches the servers", { timeout: 10000 }, async (t) => {
  stubMediaServers(t);
  const runScan = await libraryScanRunner(t);
  const skipped = path.join(downloadRoot, "Wma Artist", "Album", "Song.wma");
  await mkdir(path.dirname(skipped), { recursive: true });
  await writeFile(skipped, "audio");

  await runScan({ changedPaths: [skipped] });

  assert.deepEqual(availablePaths(), []);
  assert.deepEqual(
    pendingScans().map(({ folders }) => folders),
    [[path.dirname(skipped)]],
  );
});

test(
  "a forced full scan of many albums queues their root and sends one section-wide scan",
  { timeout: 30000 },
  async (t) => {
    const requests = stubMediaServers(t);
    const runScan = await libraryScanRunner(t);
    const albums = Array.from({ length: 21 }, (_, index) =>
      path.join(downloadRoot, `Artist ${index}`, "Album"),
    );
    for (const [index, album] of albums.entries()) {
      await makeTrack(path.join(album, "01.wav"), `Song ${index}`, `Artist ${index}`);
      await copyFile(path.join(album, "01.wav"), path.join(album, "02.wav"));
    }
    await runScan({});
    cancelPendingScans();

    await runScan({ force: true });

    assert.deepEqual(
      pendingScans().map(({ folders }) => folders),
      [[downloadRoot]],
    );
    await runPendingScan();
    assert.deepEqual(byService(requests), [
      jellyfinUpdate("/jellyfin/aurral"),
      navidromeScan("1:"),
      plexSectionRefresh,
    ]);
  },
);

function requireValue<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}
