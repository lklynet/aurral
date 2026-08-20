import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, playlistPaths] = await setupIsolatedBackend(
  "weekly-flow-paths",
  "backend/services/playlistPaths.js",
);

const {
  resolvePlaylistRoot: resolveWeeklyFlowRoot,
  remapLegacyPath: remapLegacyWeeklyFlowPath,
  resolveExistingTrackPath: resolveExistingWeeklyFlowTrackPath,
  migrateLegacyPaths,
  AURRAL_FLOWS_DIR,
  LEGACY_AURRAL_FLOWS_DIR,
} = playlistPaths;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("resolveWeeklyFlowRoot follows env precedence and relative download paths", () => {
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;

  process.env.PLAYLIST_FOLDER = "/custom/playlist";
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveWeeklyFlowRoot(), "/custom/playlist");

  delete process.env.PLAYLIST_FOLDER;
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  assert.equal(resolveWeeklyFlowRoot(), "/custom/flow");

  delete process.env.WEEKLY_FLOW_FOLDER;
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveWeeklyFlowRoot(), "/data/downloads/tmp");

  process.env.DOWNLOAD_FOLDER = "./data/downloads";
  assert.equal(
    resolveWeeklyFlowRoot(),
    path.resolve(process.cwd(), "./data/downloads"),
  );

  if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
  else process.env.PLAYLIST_FOLDER = previousPlaylist;
  if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
  else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
  if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previousDownload;
});

test("remapLegacyWeeklyFlowPath rewrites legacy roots and library dir names", () => {
  const legacyPath =
    "/app/downloads/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyWeeklyFlowPath(legacyPath, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );

  const previousV2Path =
    "/data/downloads/tmp/aurral-playlists/playlist-id/Artist/Album/Track.flac";
  assert.equal(
    remapLegacyWeeklyFlowPath(previousV2Path, "/data/downloads/tmp"),
    "/data/downloads/tmp/aurral-weekly-flow/playlist-id/Artist/Album/Track.flac",
  );
  assert.equal(AURRAL_FLOWS_DIR, "_flows");
  assert.equal(LEGACY_AURRAL_FLOWS_DIR, ".flows");
  assert.equal(
    remapLegacyWeeklyFlowPath(
      "/data/downloads/tmp/.flows/flow-id/Artist/Album/Track.flac",
      "/data/downloads/tmp",
    ),
    "/data/downloads/tmp/_flows/flow-id/Artist/Album/Track.flac",
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

test("migrateLegacyPaths moves reviewed tracks from the bare playlist-id folder", async () => {
  const fs = await import("fs/promises");
  const root = path.join(process.env.WEEKLY_FLOW_FOLDER, "reviewed-import-migration");
  const playlistId = "40ae99ad-92b0-48c6-93e7-7b39e76703ea";
  const misplacedPath = path.join(root, playlistId, "Artist", "Album", "Track.flac");
  const expectedPath = path.join(
    root,
    "aurral-weekly-flow",
    playlistId,
    "Artist",
    "Album",
    "Track.flac",
  );
  await fs.mkdir(path.dirname(misplacedPath), { recursive: true });
  await fs.writeFile(misplacedPath, "reviewed audio");
  const jobs = [
    {
      id: "reviewed-job",
      status: "done",
      playlistType: playlistId,
      finalPath: misplacedPath,
      albumName: "Album",
      externalPath: null,
    },
  ];
  const updates = [];
  const tracker = {
    getAll: () => jobs,
    setDone: (...args) => updates.push(args),
  };

  const result = await migrateLegacyPaths(root, tracker);

  assert.equal(result.migrated, 1);
  assert.equal(updates[0]?.[1], expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "reviewed audio");
  await assert.rejects(fs.access(misplacedPath));
});
