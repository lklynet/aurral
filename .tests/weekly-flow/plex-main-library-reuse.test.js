import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { PlexClient } from "../../backend/services/plex.js";

const [isolatedState, { db }, { dbOps }, { downloadTracker }, { WeeklyFlowPlaylistManager }] =
  await setupIsolatedBackend(
    "plex-main-library-reuse",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  );

let lidarrLibraryDir;

test.before(async () => {
  lidarrLibraryDir = path.join(process.env.WEEKLY_FLOW_FOLDER, "..", "lidarr-library");
  await fs.mkdir(lidarrLibraryDir, { recursive: true });
});

test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
});

test.afterEach(() => {
  mock.restoreAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function makeManager({ mainLibrarySectionId = "999" } = {}) {
  dbOps.updateSettings({
    integrations: {
      plex: {
        url: "http://plex.local:32400",
        token: "admin-token",
        clientId: "admin-client",
        mainLibrarySectionId,
      },
    },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  return new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
}

function seedReusedJob(playlistType, finalPath) {
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, playlistType);
  downloadTracker.setDone(jobId, finalPath);
  return jobId;
}

test("_resolveMainLibraryRatingKeys returns empty membership when no main library is configured", async () => {
  const manager = makeManager({ mainLibrarySectionId: "" });
  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), []);
});

test("_resolveMainLibraryRatingKeys resolves a reused track's real ratingKey by matching file path", async () => {
  const manager = makeManager();
  const reusedPath = path.join(lidarrLibraryDir, "Artist", "Track.flac");
  seedReusedJob("flow-1", reusedPath);

  mock.method(PlexClient.prototype, "getTracks", async (sectionId) => {
    assert.equal(sectionId, "999");
    return [{ ratingKey: "12345", title: "Track", files: [reusedPath] }];
  });

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), ["12345"]);
});

test("_resolveMainLibraryRatingKeys ignores tracks downloaded into Aurral's own managed folder - the Aurral-section path already covers those", async () => {
  const manager = makeManager();
  const ownedPath = path.join(manager.playlistLibraryRoot, "flow-1", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(ownedPath), { recursive: true });
  seedReusedJob("flow-1", ownedPath);

  let called = false;
  mock.method(PlexClient.prototype, "getTracks", async () => {
    called = true;
    return [];
  });

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), []);
  assert.equal(called, false, "shouldn't query the main library section at all - nothing needs it");
});

test("_resolveMainLibraryRatingKeys reconciles a path Plex reports differently than Aurral sees it, via the 'plex' path mapping", async () => {
  const manager = makeManager();
  const reusedPath = path.join(lidarrLibraryDir, "Artist", "Track.flac");
  seedReusedJob("flow-1", reusedPath);

  dbOps.updateSettings({
    ...dbOps.getSettings(),
    pathMappings: [{ source: "plex", remote: "/media/Music", local: lidarrLibraryDir }],
  });
  dbOps.getSettings(); // force the module-level path-mappings cache to sync

  mock.method(PlexClient.prototype, "getTracks", async () => [
    { ratingKey: "777", title: "Track", files: ["/media/Music/Artist/Track.flac"] },
  ]);

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), ["777"]);
});

test("_resolveMainLibraryRatingKeys degrades gracefully (empty membership, no throw) when the main library section can't be read", async () => {
  const manager = makeManager();
  seedReusedJob("flow-1", path.join(lidarrLibraryDir, "Artist", "Track.flac"));

  mock.method(PlexClient.prototype, "getTracks", async () => {
    throw new Error("Plex unreachable");
  });

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), []);
});

test("_resolveMainLibraryRatingKeys only attributes a resolved track to the flow that actually reused it", async () => {
  const manager = makeManager();
  const trackA = path.join(lidarrLibraryDir, "Artist", "TrackA.flac");
  const trackB = path.join(lidarrLibraryDir, "Artist", "TrackB.flac");
  seedReusedJob("flow-1", trackA);
  seedReusedJob("flow-2", trackB);

  mock.method(PlexClient.prototype, "getTracks", async () => [
    { ratingKey: "1", title: "TrackA", files: [trackA] },
    { ratingKey: "2", title: "TrackB", files: [trackB] },
  ]);

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1", "flow-2"]);
  assert.deepEqual(membership.get("flow-1"), ["1"]);
  assert.deepEqual(membership.get("flow-2"), ["2"]);
});

test("_resolveMainLibraryRatingKeys ignores a reused job belonging to a flow that's no longer active", async () => {
  const manager = makeManager();
  const reusedPath = path.join(lidarrLibraryDir, "Artist", "Track.flac");
  seedReusedJob("deleted-flow", reusedPath);

  let called = false;
  mock.method(PlexClient.prototype, "getTracks", async () => {
    called = true;
    return [];
  });

  const membership = await manager._resolveMainLibraryRatingKeys(["flow-1"]);
  assert.deepEqual(membership.get("flow-1"), []);
  assert.equal(called, false, "no reused jobs belong to any currently-active playlist id");
});
