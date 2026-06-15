import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("weekly-flow-paths");
applyIsolatedBackendEnv(isolatedState);

const {
  resolveWeeklyFlowRoot,
  remapLegacyWeeklyFlowPath,
  resolveExistingWeeklyFlowTrackPath,
} = await importFromRepo("backend/services/weeklyFlowPaths.js");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("resolveWeeklyFlowRoot prefers PLAYLIST_FOLDER", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;
  process.env.PLAYLIST_FOLDER = "/custom/playlist";
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  try {
    assert.equal(resolveWeeklyFlowRoot(), "/custom/playlist");
  } finally {
    if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
    else process.env.PLAYLIST_FOLDER = previousPlaylist;
    if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
    else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
    if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
    else process.env.DOWNLOAD_FOLDER = previousDownload;
  }
});

test("resolveWeeklyFlowRoot prefers WEEKLY_FLOW_FOLDER when PLAYLIST_FOLDER is unset", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;
  delete process.env.PLAYLIST_FOLDER;
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  try {
    assert.equal(resolveWeeklyFlowRoot(), "/custom/flow");
  } finally {
    if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
    else process.env.PLAYLIST_FOLDER = previousPlaylist;
    if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
    else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
    if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
    else process.env.DOWNLOAD_FOLDER = previousDownload;
  }
});

test("resolveWeeklyFlowRoot uses absolute DOWNLOAD_FOLDER when higher-priority folders are unset", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;
  delete process.env.PLAYLIST_FOLDER;
  delete process.env.WEEKLY_FLOW_FOLDER;
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  try {
    assert.equal(resolveWeeklyFlowRoot(), "/data/downloads/tmp");
  } finally {
    if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
    else process.env.PLAYLIST_FOLDER = previousPlaylist;
    if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
    else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
    if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
    else process.env.DOWNLOAD_FOLDER = previousDownload;
  }
});

test("remapLegacyWeeklyFlowPath rewrites legacy roots and library dir names", () => {
  const legacyPath =
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyWeeklyFlowPath(legacyPath, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );
});

test("remapLegacyWeeklyFlowPath rewrites previous v2 library dir names", () => {
  const previousV2Path =
    "/data/downloads/tmp/aurral-playlists/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyWeeklyFlowPath(previousV2Path, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );
});

test("resolveExistingWeeklyFlowTrackPath prefers a migrated legacy path when the file exists", async () => {
  const fs = await import("fs/promises");
  const root = path.join(process.env.WEEKLY_FLOW_FOLDER, "legacy-path-check");
  const playlistPath = path.join(
    root,
    "aurral-weekly-flow",
    "playlist-id",
    "Artist",
    "Track.flac",
  );
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(playlistPath, "audio");

  const resolved = await resolveExistingWeeklyFlowTrackPath(
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Track.flac",
    root,
  );

  assert.equal(resolved?.path, playlistPath);
  assert.equal(
    resolved?.migratedFrom,
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Track.flac",
  );
});

test("resolveExistingWeeklyFlowTrackPath resolves absolute paths outside playlist root", async () => {
  const fs = await import("fs/promises");
  const root = path.join(process.env.WEEKLY_FLOW_FOLDER, "external-path-check");
  const lidarrPath = path.join(root, "lidarr", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "audio");

  const resolved = await resolveExistingWeeklyFlowTrackPath(lidarrPath, root);
  assert.equal(resolved?.path, lidarrPath);
  assert.equal(resolved?.migratedFrom, null);
});

test("resolveWeeklyFlowRoot resolves relative DOWNLOAD_FOLDER from cwd", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;
  delete process.env.PLAYLIST_FOLDER;
  delete process.env.WEEKLY_FLOW_FOLDER;
  process.env.DOWNLOAD_FOLDER = "./data/downloads";
  try {
    assert.equal(
      resolveWeeklyFlowRoot(),
      path.resolve(process.cwd(), "./data/downloads"),
    );
  } finally {
    if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
    else process.env.PLAYLIST_FOLDER = previousPlaylist;
    if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
    else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
    if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
    else process.env.DOWNLOAD_FOLDER = previousDownload;
  }
});
