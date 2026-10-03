import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, downloadPaths] = await setupIsolatedBackend(
  "download-paths",
  "backend/services/downloadPaths.js",
);

const {
  resolveDownloadRoot: resolveDownloadRoot,
  remapLegacyPath: remapLegacyPath,
  resolveExistingTrackPath: resolveExistingTrackPath,
} = downloadPaths;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("resolveDownloadRoot follows env precedence and relative download paths", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;

  process.env.PLAYLIST_FOLDER = "/custom/playlist";
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveDownloadRoot(), "/custom/playlist");

  delete process.env.PLAYLIST_FOLDER;
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  assert.equal(resolveDownloadRoot(), "/custom/flow");

  delete process.env.WEEKLY_FLOW_FOLDER;
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveDownloadRoot(), "/data/downloads/tmp");

  process.env.DOWNLOAD_FOLDER = "./data/downloads";
  assert.equal(
    resolveDownloadRoot(),
    path.resolve(process.cwd(), "./data/downloads"),
  );

  if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
  else process.env.PLAYLIST_FOLDER = previousPlaylist;
  if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
  else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
  if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previousDownload;
});

test("remapLegacyPath rewrites legacy roots and library dir names", () => {
  const legacyPath =
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyPath(legacyPath, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );

  const previousV2Path =
    "/data/downloads/tmp/aurral-playlists/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyPath(previousV2Path, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );
});

test("resolveExistingTrackPath prefers a migrated legacy path when the file exists", async () => {
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

  const resolved = await resolveExistingTrackPath(
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Track.flac",
    root,
  );

  assert.equal(resolved?.path, playlistPath);
  assert.equal(
    resolved?.migratedFrom,
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Track.flac",
  );
});

test("resolveExistingTrackPath resolves absolute paths outside playlist root", async () => {
  const fs = await import("fs/promises");
  const root = path.join(process.env.WEEKLY_FLOW_FOLDER, "external-path-check");
  const lidarrPath = path.join(root, "lidarr", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "audio");

  const resolved = await resolveExistingTrackPath(lidarrPath, root);
  assert.equal(resolved?.path, lidarrPath);
  assert.equal(resolved?.migratedFrom, null);
});
