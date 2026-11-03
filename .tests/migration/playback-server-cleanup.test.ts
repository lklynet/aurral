import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";

const [
  state,
  { db },
  { dbOps, userOps, userIdentityOps },
  { encryptWithKey },
  { getSettingsEncryptionKey },
  cleanup,
  { downloadTracker },
  { resolveDownloadRoot },
  { getPlaylistFileSettings },
  { normalizePathMappings },
] = await setupIsolatedBackend(
  "playback-server-cleanup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/encryption.ts"),
  () => import("../../backend/db/helpers/settings.ts"),
  () => import("../../backend/services/playbackServerCleanup.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/playlists/playlistFiles.ts"),
  () => import("../../backend/services/pathMappings.ts"),
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function writeFile(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  return file;
}

test("removes old server playlists and retained files, retrying a server that is down", async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  const secret = (value: string) => encryptWithKey(value, getSettingsEncryptionKey());
  dbOps.updateSettings({
    integrations: {
      navidrome: {
        url: "http://navidrome.test",
        username: "admin",
        password: secret("password"),
        prefixOwnerUsername: false,
      },
      jellyfin: { url: "http://jellyfin.test", apiKey: secret("key"), userId: "admin" },
    },
  });
  dbOps.setJSONSetting("navidromePlaylistPointers", {
    flow: { global: { playlistId: "nd-1" } },
    gone: { global: { playlistId: "nd-already-gone" } },
  });
  dbOps.setJSONSetting("jellyfinPlaylistPointers", {
    flow: { global: { playlistId: "jf-1", serverUrl: "http://jellyfin.test/" } },
    moved: { global: { playlistId: "jf-old", serverUrl: "http://old-jellyfin.test" } },
  });
  const root = resolveDownloadRoot();
  const unowned = await writeFile(path.join(root, "Old", "Unowned.flac"));
  const owned = await writeFile(path.join(root, "Old", "Owned.flac"));
  const outside = await writeFile(path.join(state.baseDir, "elsewhere", "Outside.flac"));
  const jobId = downloadTracker.addJob({ artistName: "A", trackName: "Owned" }, "flow");
  downloadTracker.setDone(jobId!, owned, "Album");
  dbOps.setJSONSetting(
    "playbackRetainedFiles",
    Object.fromEntries([unowned, owned, outside].map((file) => [file, { reason: "playback" }])),
  );
  const user = userOps.createUser("plex-user", "hash")!;
  userIdentityOps.link(user.id, { providerType: "plex", providerKey: "plex", subject: "p-1" });

  const navidrome = createFakeNavidrome({ playlists: ["nd-1"] });
  const jellyfinDeletes: string[] = [];
  let jellyfinUp = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "navidrome.test") return navidrome.fetch(input, init);
    if (!jellyfinUp) throw new TypeError("fetch failed");
    jellyfinDeletes.push(url.pathname);
    return new Response(null, { status: 204 });
  };

  assert.equal(cleanup.hasLegacyPlaybackServerData(), true);
  assert.deepEqual((await cleanup.cleanUpPlaybackServers()).pending, ["jellyfin"]);
  assert.deepEqual(navidrome.playlists, []);
  assert.equal(await exists(unowned), true);
  assert.equal(cleanup.hasLegacyPlaybackServerData(), true);

  jellyfinUp = true;
  const result = await cleanup.cleanUpPlaybackServers();

  assert.deepEqual(result, { pending: [], removedFiles: [unowned] });
  assert.deepEqual(jellyfinDeletes, ["/Items/jf-1"]);
  assert.deepEqual(
    [await exists(unowned), await exists(owned), await exists(outside)],
    [false, true, true],
  );
  assert.equal(cleanup.hasLegacyPlaybackServerData(), false);
  assert.equal(userIdentityOps.countForUser(user.id), 0);
  assert.deepEqual(getPlaylistFileSettings(), { prefixOwnerUsername: false });
});

test("path mappings for retired media servers are dropped instead of applying everywhere", () => {
  assert.deepEqual(
    normalizePathMappings([
      { source: "plex", remote: "/plex/music", local: "/music" },
      { source: "lidarr", remote: "/data/music", local: "/music" },
      { remote: "/downloads", local: "/data/downloads" },
    ]),
    [
      { source: "lidarr", remote: "/data/music", local: "/music" },
      { source: "all", remote: "/downloads", local: "/data/downloads" },
    ],
  );
});
