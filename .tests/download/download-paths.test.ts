import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "path";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, downloadPaths] = await setupIsolatedBackend(
  "download-paths",
  () => import("../../backend/services/downloadPaths.ts"),
);

const { resolveDownloadRoot } = downloadPaths;

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("resolveDownloadRoot follows env precedence and relative download paths", () => {
  const previousLibrary = process.env.LIBRARY_FOLDER;
  const previousPlaylist = process.env.PLAYLIST_FOLDER;
  const previousWeekly = process.env.WEEKLY_FLOW_FOLDER;
  const previousDownload = process.env.DOWNLOAD_FOLDER;

  process.env.LIBRARY_FOLDER = "/custom/library";
  process.env.PLAYLIST_FOLDER = "/custom/playlist";
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveDownloadRoot(), "/custom/library");

  delete process.env.LIBRARY_FOLDER;
  assert.equal(resolveDownloadRoot(), "/custom/playlist");

  delete process.env.PLAYLIST_FOLDER;
  process.env.WEEKLY_FLOW_FOLDER = "/custom/flow";
  assert.equal(resolveDownloadRoot(), "/custom/flow");

  delete process.env.WEEKLY_FLOW_FOLDER;
  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveDownloadRoot(), "/data/downloads/tmp");

  process.env.DOWNLOAD_FOLDER = "./data/downloads";
  assert.equal(resolveDownloadRoot(), path.resolve(process.cwd(), "./data/downloads"));

  if (previousLibrary === undefined) delete process.env.LIBRARY_FOLDER;
  else process.env.LIBRARY_FOLDER = previousLibrary;
  if (previousPlaylist === undefined) delete process.env.PLAYLIST_FOLDER;
  else process.env.PLAYLIST_FOLDER = previousPlaylist;
  if (previousWeekly === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
  else process.env.WEEKLY_FLOW_FOLDER = previousWeekly;
  if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previousDownload;
});
