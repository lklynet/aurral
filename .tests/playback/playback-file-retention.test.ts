import * as v from "valibot";
import { JellyfinClient } from "../../backend/services/jellyfin.ts";
import type { PlaybackDestination } from "../../backend/services/playback/playbackDestination.ts";
import { audioMetadata } from "../download/fixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { PlaybackDestinationRegistry } from "../../backend/services/playback/playbackDestinationRegistry.ts";
import { localFileKey } from "../../backend/services/playback/playlistUsage.ts";

const [
  state,
  { db },
  { dbOps },
  retention,
  { playlistManager },
  { downloadTracker },
  reuse,
  { flowPlaylistConfig },
] = await setupIsolatedBackend(
  "playback-file-retention",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playback/playbackFileRetention.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/fileReuse.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
);
const {
  createPlaybackDeletionGuard,
  removeUnusedPlaybackFiles,
  isPlaybackRetainedFile,
  retryPlaybackRetainedFiles,
} = retention;
const retainedFilesSchema = v.record(
  v.string(),
  v.looseObject({ excludeEntityIds: v.array(v.string()), playlistRoot: v.string() }),
);
const root = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(root != null);

beforeEach(async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({
    integrations: {},
    flows: [],
    sharedPlaylists: [],
    onboardingComplete: true,
    downloadFolderPath: root,
  });
  await fs.rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  db.close();
  await cleanupIsolatedState(state);
});

afterEach(async () => {
  const { syncPathMappings } = await import("../../backend/services/pathMappings.ts");
  syncPathMappings([]);
});

async function makeFile(relative: string) {
  assert.ok(root);
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  return file;
}

function destination(
  key: string,
  active: boolean,
  read: (options: { excludeEntityIds: string[] }) => Promise<unknown>,
): PlaybackDestination {
  return {
    key,
    name: key,
    updateConfig() {},
    isConfigured: () => active,
    async testConnection() {
      return { ok: true };
    },
    async ensureLibrary() {
      return { ok: true };
    },
    async publishPlaylist() {
      return { ok: true };
    },
    async deletePlaylist() {
      return { ok: true };
    },
    async deleteEntityPlaylists() {
      return { ok: true };
    },
    getPointerEntityIds: () => [],
    async requestScan() {
      return { ok: true };
    },
    getReferencedPaths: read as PlaybackDestination["getReferencedPaths"],
  };
}

test("checks every active destination once per cleanup batch and skips inactive ones", async () => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const unused = await makeFile("_flows/flow/unused.flac");
  const calls: string[] = [];
  const registry = new PlaybackDestinationRegistry([
    destination("jellyfin", true, async ({ excludeEntityIds }) => {
      calls.push("jellyfin");
      assert.deepEqual(excludeEntityIds, ["flow"]);
      return { ok: true, paths: [] };
    }),
    destination("navidrome", true, async () => {
      calls.push("navidrome");
      return { ok: true, paths: [saved] };
    }),
    destination("plex", false, async () => {
      throw new Error("inactive service was contacted");
    }),
  ]);
  await removeUnusedPlaybackFiles(
    path.dirname(saved),
    createPlaybackDeletionGuard({ registry, excludeEntityIds: ["flow"] }),
  );
  assert.equal(await fs.readFile(saved, "utf8"), "audio");
  await assert.rejects(fs.access(unused), { code: "ENOENT" });
  assert.deepEqual(calls.sort(), ["jellyfin", "navidrome"]);
  assert.equal(isPlaybackRetainedFile(saved), true);
});

for (const response of [null, { ok: true }, { ok: false, error: { message: "offline" } }]) {
  test(`unknown playlist usage preserves files (${JSON.stringify(response)})`, async () => {
    const file = await makeFile("_flows/flow/track.flac");
    const registry = new PlaybackDestinationRegistry([
      destination("jellyfin", true, async () => response),
    ]);
    await removeUnusedPlaybackFiles(path.dirname(file), createPlaybackDeletionGuard({ registry }));
    await fs.access(file);
    assert.equal(isPlaybackRetainedFile(file), true);
  });
}

test("no active playback services preserves the existing cleanup behaviour", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  await removeUnusedPlaybackFiles(
    path.dirname(file),
    createPlaybackDeletionGuard({ registry: new PlaybackDestinationRegistry([]) }),
  );
  await assert.rejects(fs.access(path.dirname(file)), { code: "ENOENT" });
});

test("a later cleanup reads fresh references rather than reusing an unused result", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  let paths: string[] = [];
  const registry = new PlaybackDestinationRegistry([
    destination("jellyfin", true, async () => ({ ok: true, paths })),
  ]);
  assert.equal(await createPlaybackDeletionGuard({ registry }).canDelete(file), true);
  paths = [file];
  assert.equal(await createPlaybackDeletionGuard({ registry }).canDelete(file), false);
});

test("configuration changes invalidate deletion permission within a batch", async () => {
  const file = await makeFile("_flows/flow/track.flac");
  const guard = createPlaybackDeletionGuard({ registry: new PlaybackDestinationRegistry([]) });
  assert.equal(await guard.canDelete(file), true);
  dbOps.updateSettings({ integrations: { jellyfin: { url: "http://new-server" } } });
  assert.equal(await guard.canDelete(file), false);
});

test("flow reset retains external files at the same path and clears outgoing jobs", async () => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const unused = await makeFile("_flows/flow/unused.flac");
  const legacy = await makeFile("aurral-weekly-flow/flow/legacy.flac");
  const id = downloadTracker.addJob({ artistName: "Artist", trackName: "Saved" }, "flow");
  assert.ok(id != null);
  downloadTracker.setDone(id, saved);
  let calls = 0;
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(
    async (operation, ...args) => {
      const options = referenceOptions(args[0]);
      assert.equal(operation, "getReferencedPaths");
      assert.deepEqual(options.excludeEntityIds, ["flow"]);
      calls += 1;
      return [
        {
          key: "test",
          operation: "getReferencedPaths" as const,
          destination: "Jellyfin",
          ok: true,
          paths: [saved, legacy],
        },
      ];
    },
  );
  await playlistManager.weeklyReset(["flow"]);
  await fs.access(saved);
  await fs.access(legacy);
  await assert.rejects(fs.access(unused), { code: "ENOENT" });
  assert.equal(downloadTracker.getByPlaylistType("flow").length, 0);
  assert.equal(calls, 1);
});

test("explicit manual reset deletes externally referenced files without contacting services", async () => {
  const saved = await makeFile("_flows/flow/saved.flac");
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => {
    assert.fail("manual deletion queried playback");
  });
  await playlistManager.weeklyReset(["flow"], { protectPlayback: false });
  await assert.rejects(fs.access(saved), { code: "ENOENT" });
});

test("individual automatic cleanup retains a track while explicit deletion bypasses the check", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Flow", size: 5 });
  const file = await makeFile(`_flows/${flow.id}/track.flac`);
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => [
    {
      key: "test",
      operation: "getReferencedPaths" as const,
      destination: "Plex",
      ok: true,
      paths: [file],
    },
  ]);
  assert.deepEqual(await reuse.removePlaylistFileIfUnshared(file, flow.id), { action: "retained" });
  assert.deepEqual(
    await reuse.removePlaylistFileIfUnshared(file, flow.id, { protectPlayback: false }),
    { action: "deleted" },
  );
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("a later scan retries retained files but never removes a file still owned by Aurral", async () => {
  const saved = await makeFile("_flows/flow/saved.flac");
  const owned = await makeFile("_flows/flow/owned.flac");
  let paths = [saved, owned];
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => [
    {
      key: "test",
      operation: "getReferencedPaths" as const,
      destination: "Jellyfin",
      ok: true,
      paths,
    },
  ]);
  const guard = createPlaybackDeletionGuard();
  assert.equal(await guard.canDelete(saved), false);
  assert.equal(await guard.canDelete(owned), false);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Owned" }, "another");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, owned);
  paths = [];
  await retryPlaybackRetainedFiles();
  await assert.rejects(fs.access(saved), { code: "ENOENT" });
  await fs.access(owned);
  assert.equal(isPlaybackRetainedFile(saved), false);
});

for (const service of ["jellyfin", "navidrome"]) {
  test(`${service} maps server paths and excludes only the outgoing entity's pointers`, async () => {
    const module = await import(`../../backend/services/playback/${service}PlaybackDestination.ts`);
    const storeModule = await import(
      `../../backend/services/${service}/${service}PlaylistPointerStore.ts`
    );
    const store = storeModule[`${service}PlaylistPointerStore`];
    const Destination =
      module[
        service === "jellyfin" ? "JellyfinPlaybackDestination" : "NavidromePlaybackDestination"
      ];
    const { syncPathMappings } = await import("../../backend/services/pathMappings.ts");
    syncPathMappings([{ source: service, remote: "/server-music", local: root }]);
    store.setPointer("flow", "owner", { playlistId: "outgoing", serverUrl: "http://server" });
    store.setPointer("other", "owner", { playlistId: "keep", serverUrl: "http://server" });
    const destination = new Destination(root, {
      client: {
        url: "http://server",
        isConfigured: () => true,
        async getPlaylistTrackPaths(excluded: Set<string>) {
          assert.deepEqual([...excluded], ["outgoing"]);
          return ["/server-music/_flows/flow/saved.flac"];
        },
      },
    });
    assert.ok(destination.isConfigured());
    assert.deepEqual(await destination.getReferencedPaths({ excludeEntityIds: ["flow"] }), {
      ok: true,
      paths: [path.join(root, "_flows/flow/saved.flac")],
    });
  });
}

test("Plex checks global and linked accounts and maps its downloads path", async () => {
  const { userOps } = await import("../../backend/db/helpers/index.ts");
  const { PlexClient } = await import("../../backend/services/plex.ts");
  const { PlexPlaybackDestination } =
    await import("../../backend/services/playback/plexPlaybackDestination.ts");
  const { plexConnectionStore } =
    await import("../../backend/services/plex/plexConnectionStore.ts");
  const { plexPlaylistPointerStore } =
    await import("../../backend/services/plex/plexPlaylistPointerStore.ts");
  const user = userOps.createUser("listener", "hash", "user");
  assert.ok(user != null);
  plexConnectionStore.saveConnection(user.id, {
    linkType: "self",
    token: "listener-token",
    clientId: "listener",
    plexAccountId: 1,
  });
  plexPlaylistPointerStore.setPointer("flow", "global", {
    location: "global",
    ratingKey: "outgoing",
    title: "Flow",
  });
  const destination = new PlexPlaybackDestination(root);
  destination.updateConfig({
    url: "http://plex",
    token: "admin-token",
    downloadsPath: "/server-music",
  });
  const seen: (string | null)[] = [];
  vi.spyOn(PlexClient.prototype, "getPlaylistTrackPaths").mockImplementation(async function (
    this: import("../../backend/services/plex.ts").PlexClient,
    excluded = new Set<string>(),
  ) {
    seen.push(this.token);
    assert.deepEqual([...excluded], ["outgoing"]);
    return this.token === "listener-token" ? ["/server-music/_flows/flow/saved.flac"] : [];
  });
  assert.ok(destination.isConfigured());
  assert.deepEqual(await destination.getReferencedPaths({ excludeEntityIds: ["flow"] }), {
    ok: true,
    paths: [path.join(root, "_flows/flow/saved.flac")],
  });
  assert.deepEqual(seen.sort(), ["admin-token", "listener-token"]);
});

test("Plex does not add retained files back to a refreshed flow", async () => {
  const { PlexPlaybackDestination } =
    await import("../../backend/services/playback/plexPlaybackDestination.ts");
  const { PlexClient } = await import("../../backend/services/plex.ts");
  const file = await makeFile("_flows/flow/saved.flac");
  const registry = new PlaybackDestinationRegistry([
    destination("plex", true, async () => ({ ok: true, paths: [file] })),
  ]);
  await createPlaybackDeletionGuard({ registry }).canDelete(file);
  const playback = new PlexPlaybackDestination(root);
  playback.updateConfig({ url: "http://plex", token: "admin-token" });
  vi.spyOn(PlexClient.prototype, "ensureAurralLibrary").mockImplementation(async () => ({
    key: "7",
    type: "artist",
    title: "Aurral",
  }));
  vi.spyOn(PlexClient.prototype, "getTracks").mockImplementation(async () => [
    {
      ratingKey: "saved",
      files: [file],
      title: "Saved",
      artist: "Artist",
      addedAt: Math.floor(Date.now() / 1000),
    },
  ]);
  const published: ((string | number)[] | null | undefined)[] = [];
  vi.spyOn(PlexClient.prototype, "syncPlaylist").mockImplementation(async ({ ratingKeys }) => {
    published.push(ratingKeys);
    return { ratingKey: "playlist" };
  });
  const flow = (tracks: { path: string; title: string; artist: string }[]) => ({
    entityId: "flow",
    displayName: "Flow",
    tracks,
  });

  assert.deepEqual(await playback.publishPlaylist(flow([])), { ok: true });
  assert.deepEqual([...published], []);
  assert.deepEqual(
    await playback.publishPlaylist(flow([{ path: file, title: "Saved", artist: "Artist" }])),
    { ok: true },
  );
  assert.deepEqual(published, [["saved"]]);
});

test("automatic cleanup keeps a shared file in place; explicit deletion preserves other Aurral jobs by moving it", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Shared source", size: 5 });
  const other = flowPlaylistConfig.createFlow({ name: "Other", size: 5 });
  const file = await makeFile(`_flows/${flow.id}/saved.flac`);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Saved" }, other.id);
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, file);
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => [
    {
      key: "test",
      operation: "getReferencedPaths" as const,
      destination: "Jellyfin",
      ok: true,
      paths: [file],
    },
  ]);
  await playlistManager.weeklyReset([flow.id]);
  assert.equal(downloadTracker.getAll().find((job) => job.id === jobId)!.finalPath, file);
  await fs.access(file);
  await playlistManager.weeklyReset([flow.id], { protectPlayback: false });
  const moved = downloadTracker.getAll().find((job) => job.id === jobId)!.finalPath;
  assert.ok(moved != null);
  assert.notEqual(moved, file);
  await fs.access(moved);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("quality upgrades preserve the old file when another playback playlist uses it", async () => {
  const { finalizeQualityUpgradeSuccess } =
    await import("../../backend/services/qualityProfileService.ts");
  const oldFile = await makeFile("_flows/upgrade/old.mp3");
  const newFile = await makeFile("_flows/upgrade/new.flac");
  const originalId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Upgrade" },
    "upgrade",
  );
  assert.ok(originalId != null);
  downloadTracker.setDone(originalId, oldFile);
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => [
    {
      key: "test",
      operation: "getReferencedPaths" as const,
      destination: "Navidrome",
      ok: true,
      paths: [oldFile],
    },
  ]);
  await finalizeQualityUpgradeSuccess(
    { ...downloadTracker.getJob(originalId)!, id: "upgrade-job", upgradeForJobId: originalId },
    newFile,
    {
      tier: "lossless",
      format: null,
      bitrateKbps: null,
      sampleRate: null,
      bitDepth: null,
    },
  );
  assert.equal(downloadTracker.getJob(originalId)!.finalPath, newFile);
  await fs.access(oldFile);
  assert.equal(isPlaybackRetainedFile(oldFile), true);
});

test("startup migration leaves an externally referenced orphan at its original path", async () => {
  const { migrateAurralDownloadFolder } =
    await import("../../backend/services/aurralDownloadFolderMigration.ts");
  const flow = flowPlaylistConfig.createFlow({ name: "Migration source", enabled: true });
  const file = await makeFile(`aurral-weekly-flow/${flow.id}/Artist/Album/Saved.flac`);
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => [
    {
      key: "test",
      operation: "getReferencedPaths" as const,
      destination: "Jellyfin",
      ok: true,
      paths: [file],
    },
  ]);
  const options = {
    root,
    indexDestination: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  const result = await migrateAurralDownloadFolder(options);
  assert.equal(result.removed, 0);
  assert.equal(isPlaybackRetainedFile(file), true);
  await fs.access(file);
  await migrateAurralDownloadFolder(options);
  await fs.access(file);
});

for (const mode of [
  "completed-flow",
  "shared-direct",
  "shared-batch",
  "shared-batch-without-job",
]) {
  for (const usage of ["referenced", "unavailable", "unused"]) {
    test(`indexed migration checks ${mode} sources when playback usage is ${usage}`, async () => {
      const { migrateAurralDownloadFolder } =
        await import("../../backend/services/aurralDownloadFolderMigration.ts");
      const isFlow = mode === "completed-flow";
      const playlist = isFlow
        ? flowPlaylistConfig.createFlow({ name: `${mode}-${usage}`, enabled: true })
        : flowPlaylistConfig.createStaticPlaylist({ name: `${mode}-${usage}` });
      const source = await makeFile(`aurral-weekly-flow/${playlist.id}/Artist/Album/Saved.flac`);
      const destinationPath = isFlow
        ? path.join(root, "_flows", playlist.id, "Artist/Album/Saved.flac")
        : path.join(root, "Artist/Album/Saved.flac");
      let jobId: string | null = null;
      if (mode !== "shared-batch-without-job") {
        jobId = downloadTracker.addJob(
          { artistName: "Artist", albumName: "Album", trackName: "Saved" },
          playlist.id,
        );
        assert.ok(jobId);
        downloadTracker.setDone(jobId, source);
      }
      let currentUsage = usage;
      const checks = vi
        .spyOn(playlistManager.destinationRegistry, "run")
        .mockImplementation(async (_operation, ...args) => {
          const { excludeEntityIds } = referenceOptions(args[0]);
          assert.deepEqual(excludeEntityIds, [playlist.id]);
          return currentUsage === "unavailable"
            ? [
                {
                  destination: "Test",
                  key: "test",
                  operation: "getReferencedPaths" as const,
                  ok: false,
                },
              ]
            : [
                {
                  destination: "Test",
                  key: "test",
                  operation: "getReferencedPaths" as const,
                  ok: true,
                  paths: currentUsage === "referenced" ? [source] : [],
                },
              ];
        });
      const options = {
        root,
        logger: { warn() {}, info() {}, error() {} },
        metadataReader: async () =>
          audioMetadata({
            common: { albumartist: "Artist", album: "Album", title: "Saved" },
          }),
        ...(mode === "shared-direct" ? { indexDestination: async () => {} } : {}),
      };
      const first = await migrateAurralDownloadFolder(options);
      assert.equal(first.failed, 0);
      assert.equal(checks.mock.calls.length, 1);
      assert.equal(await fs.readFile(destinationPath, "utf8"), "audio");
      if (jobId) assert.equal(downloadTracker.getJob(jobId)!.finalPath, destinationPath);
      if (usage === "unused") {
        assert.equal(first.migrated, 1);
        await assert.rejects(fs.access(source), { code: "ENOENT" });
        return;
      }
      assert.equal(first.retained, 1);
      assert.equal(first.migrated, 0);
      assert.equal(isPlaybackRetainedFile(source), true);
      assert.equal(await fs.readFile(source, "utf8"), "audio");
      await migrateAurralDownloadFolder(options);
      await fs.access(source);
      currentUsage = "unused";
      await retryPlaybackRetainedFiles();
      await assert.rejects(fs.access(source), { code: "ENOENT" });
      assert.equal(isPlaybackRetainedFile(source), false);
      await fs.access(destinationPath);
      const final = await migrateAurralDownloadFolder(options);
      assert.equal(final.status, "complete");
    });
  }
}

test("Jellyfin excludes legacy outgoing pointers but keeps pointers from other servers separate", async () => {
  const { JellyfinPlaybackDestination } =
    await import("../../backend/services/playback/jellyfinPlaybackDestination.ts");
  const { jellyfinPlaylistPointerStore: pointers } =
    await import("../../backend/services/jellyfin/jellyfinPlaylistPointerStore.ts");
  pointers.setPointer("flow", "legacy", { playlistId: "legacy", title: "Flow", serverUrl: null });
  pointers.setPointer("flow", "current", {
    playlistId: "current",
    title: "Flow",
    serverUrl: "http://current",
  });
  pointers.setPointer("flow", "other-server", {
    playlistId: "other",
    title: "Flow",
    serverUrl: "http://other",
  });
  pointers.setPointer("another-flow", "legacy", {
    playlistId: "keep",
    title: "Flow",
    serverUrl: null,
  });
  const playback = new JellyfinPlaybackDestination(root, {
    client: Object.assign(new JellyfinClient("http://current", "key", "user"), {
      url: "http://current",
      async getPlaylistTrackPaths(excluded = new Set<string>()) {
        assert.deepEqual([...excluded].sort(), ["current", "legacy"]);
        return [];
      },
    }),
  });
  await playback.getReferencedPaths({ excludeEntityIds: ["flow"] });
});

test("retained retries preserve exclusions and share a snapshot only within matching groups", async () => {
  const first = await makeFile("_flows/a/first.flac");
  const second = await makeFile("_flows/a/second.flac");
  const third = await makeFile("_flows/b/third.flac");
  const external = await makeFile("_flows/a/external.flac");
  const registry = new PlaybackDestinationRegistry([
    destination("jellyfin", true, async () => ({
      ok: true,
      paths: [first, second, third, external],
    })),
  ]);
  for (const [file, excludeEntityIds] of [
    [first, ["a", "old-a"]],
    [second, ["old-a", "a", "a"]],
    [third, ["b"]],
    [external, ["a", "old-a"]],
  ] as [string, string[]][]) {
    await createPlaybackDeletionGuard({ registry, excludeEntityIds }).canDelete(file);
  }
  const calls: string[][] = [];
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(
    async (_operation, ...args) => {
      const { excludeEntityIds } = referenceOptions(args[0]);
      calls.push(excludeEntityIds);
      return [
        {
          destination: "Test",
          key: "test",
          operation: "getReferencedPaths" as const,
          ok: true,
          paths: excludeEntityIds.includes("a") ? [third, external] : [first, second, external],
        },
      ];
    },
  );
  await retryPlaybackRetainedFiles();
  for (const file of [first, second, third])
    await assert.rejects(fs.access(file), { code: "ENOENT" });
  await fs.access(external);
  assert.deepEqual(calls, [["a", "old-a"], ["b"]]);
  assert.deepEqual(
    dbOps.getJSONSetting("playbackRetainedFiles", retainedFilesSchema)![localFileKey(external)]
      .excludeEntityIds,
    ["a", "old-a"],
  );
});

for (const changeBeforeReset of [false, true]) {
  test(`retained files use their recorded root when settings change ${changeBeforeReset ? "before" : "after"} cleanup`, async () => {
    const file = await makeFile("_flows/old-root/saved.flac");
    const newRoot = path.join(state.baseDir, "new-downloads");
    await fs.mkdir(newRoot, { recursive: true });
    const unrelated = path.join(newRoot, "unrelated.flac");
    await fs.writeFile(unrelated, "unrelated");
    let unavailable = true;
    vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () =>
      unavailable
        ? [
            {
              destination: "Test",
              key: "test",
              operation: "getReferencedPaths" as const,
              ok: false,
            },
          ]
        : [
            {
              destination: "Test",
              key: "test",
              operation: "getReferencedPaths" as const,
              ok: true,
              paths: [],
            },
          ],
    );
    if (changeBeforeReset) dbOps.updateSettings({ downloadFolderPath: newRoot });
    await playlistManager.weeklyReset(["old-root"]);
    if (!changeBeforeReset) dbOps.updateSettings({ downloadFolderPath: newRoot });
    await retryPlaybackRetainedFiles();
    await fs.access(file);
    assert.equal(
      dbOps.getJSONSetting("playbackRetainedFiles", retainedFilesSchema)![localFileKey(file)]
        .playlistRoot,
      path.resolve(root),
    );
    unavailable = false;
    await retryPlaybackRetainedFiles();
    await assert.rejects(fs.access(file), { code: "ENOENT" });
    assert.equal(isPlaybackRetainedFile(file), false);
    assert.equal(await fs.readFile(unrelated, "utf8"), "unrelated");
  });
}

test("retry accepts legacy records only inside the current root and rejects mismatched recorded roots", async () => {
  const legacy = await makeFile("_flows/legacy/saved.flac");
  const mismatch = await makeFile("_flows/mismatch/saved.flac");
  dbOps.setJSONSetting("playbackRetainedFiles", {
    [localFileKey(legacy)]: { excludeEntityIds: ["legacy"] },
    [localFileKey(mismatch)]: { playlistRoot: path.join(state.baseDir, "different-root") },
  });
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(
    async (_operation, ...args) => {
      const { excludeEntityIds } = referenceOptions(args[0]);
      assert.deepEqual(excludeEntityIds, ["legacy"]);
      return [
        {
          destination: "Test",
          key: "test",
          operation: "getReferencedPaths" as const,
          ok: true,
          paths: [],
        },
      ];
    },
  );
  await retryPlaybackRetainedFiles();
  await assert.rejects(fs.access(legacy), { code: "ENOENT" });
  await fs.access(mismatch);
});

test("explicit reset removes symbolic links without touching their targets; automatic cleanup leaves links alone", async () => {
  const target = path.join(state.baseDir, "linked-library");
  await fs.mkdir(target, { recursive: true });
  const targetFile = path.join(target, "saved.flac");
  await fs.writeFile(targetFile, "external audio");
  const links = ["_flows/linked/link", "aurral-weekly-flow/linked/link", "_fallback/link"];
  for (const relative of links) {
    const link = path.join(root, relative);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  }
  vi.spyOn(playlistManager.destinationRegistry, "run").mockImplementation(async () => {
    assert.fail("symbolic link cleanup queried playback");
  });
  await playlistManager.weeklyReset(["linked"]);
  for (const relative of links)
    assert.equal((await fs.lstat(path.join(root, relative))).isSymbolicLink(), true);
  await playlistManager.weeklyReset(["linked"], { protectPlayback: false });
  for (const relative of links)
    await assert.rejects(fs.lstat(path.dirname(path.join(root, relative))), { code: "ENOENT" });
  assert.equal(await fs.readFile(targetFile, "utf8"), "external audio");
});

function referenceOptions(value: unknown) {
  assert.ok(value && typeof value === "object" && "excludeEntityIds" in value);
  const ids = value.excludeEntityIds;
  assert.ok(Array.isArray(ids) && ids.every((id: unknown) => typeof id === "string"));
  return { excludeEntityIds: ids.map(String) };
}
