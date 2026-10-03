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

const { resolveDownloadRoot, resolveExistingTrackPath } = downloadPaths;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("resolveDownloadRoot reads absolute and relative DOWNLOAD_FOLDER paths", () => {
  const previousDownload = process.env.DOWNLOAD_FOLDER;

  process.env.DOWNLOAD_FOLDER = "/data/downloads/tmp";
  assert.equal(resolveDownloadRoot(), "/data/downloads/tmp");

  process.env.DOWNLOAD_FOLDER = "./data/downloads";
  assert.equal(
    resolveDownloadRoot(),
    path.resolve(process.cwd(), "./data/downloads"),
  );

  if (previousDownload === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previousDownload;
});


test("resolveExistingTrackPath returns a stored path only while the file exists", async () => {
  const fs = await import("fs/promises");
  const root = path.join(process.env.DOWNLOAD_FOLDER, "external-path-check");
  const lidarrPath = path.join(root, "lidarr", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "audio");

  assert.equal(await resolveExistingTrackPath(lidarrPath), lidarrPath);
  assert.equal(await resolveExistingTrackPath(path.join(root, "missing.flac")), null);
  assert.equal(await resolveExistingTrackPath(path.dirname(lidarrPath)), null);
});

