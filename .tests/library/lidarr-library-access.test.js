import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { runLidarrLibraryAccessTest } from "../../backend/services/lidarrLibraryAccessTest.js";

function createMockLidarrClient(overrides = {}) {
  return {
    testConnection: async () => ({ connected: true, instanceName: "Lidarr", version: "2.0" }),
    getRootFolders: async () => [{ path: overrides.rootPath }],
    request: overrides.request || (async () => []),
    getTracksByAlbumId: overrides.getTracksByAlbumId || (async () => []),
    getTrackFilesByAlbumId: overrides.getTrackFilesByAlbumId || (async () => []),
    ...overrides,
  };
}

test("runLidarrLibraryAccessTest fails when root folder is not readable", async () => {
  const result = await runLidarrLibraryAccessTest(
    createMockLidarrClient({
      rootPath: "/definitely-missing-aurral-library-path",
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.steps.some((step) => step.id === "mount" && step.status === "fail"),
    true,
  );
});

test("runLidarrLibraryAccessTest passes when a track file is readable", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lidarr-test-"));
  const albumDir = path.join(rootDir, "Artist", "Album");
  const trackPath = path.join(albumDir, "Artist_Album_01_Track.mp3");
  await fs.mkdir(albumDir, { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const previousFlowRoot = process.env.WEEKLY_FLOW_FOLDER;
  process.env.WEEKLY_FLOW_FOLDER = rootDir;
  const result = await runLidarrLibraryAccessTest(
    createMockLidarrClient({
      rootPath: rootDir,
      request: async (endpoint) => {
        if (endpoint === "/artist") {
          return [{ id: 100, artistName: "Artist" }];
        }
        if (endpoint === "/album?artistId=100") {
          return [
            {
              id: 603,
              title: "Album",
              statistics: { sizeOnDisk: 100 },
            },
          ];
        }
        return [];
      },
      getTracksByAlbumId: async () => [
        {
          id: 7,
          title: "Track",
          hasFile: true,
          trackFileId: 10915,
        },
      ],
      getTrackFilesByAlbumId: async () => [
        {
          id: 10915,
          path: trackPath,
          size: 5,
        },
      ],
    }),
  );

  if (previousFlowRoot === undefined) {
    delete process.env.WEEKLY_FLOW_FOLDER;
  } else {
    process.env.WEEKLY_FLOW_FOLDER = previousFlowRoot;
  }
  await fs.rm(rootDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.sample?.path, trackPath);
  assert.equal(
    result.steps.some((step) => step.id === "hardlink" && step.status === "pass"),
    true,
  );
  assert.equal(
    result.steps.some((step) => step.id === "ready" && step.status === "pass"),
    true,
  );
});

test("runLidarrLibraryAccessTest warns when flow and Lidarr files are on different filesystems", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lidarr-test-"));
  const albumDir = path.join(rootDir, "Artist", "Album");
  const trackPath = path.join(albumDir, "Artist_Album_01_Track.mp3");
  await fs.mkdir(albumDir, { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const result = await runLidarrLibraryAccessTest(
    createMockLidarrClient({
      rootPath: rootDir,
      request: async (endpoint) => {
        if (endpoint === "/artist") {
          return [{ id: 100, artistName: "Artist" }];
        }
        if (endpoint === "/album?artistId=100") {
          return [
            {
              id: 603,
              title: "Album",
              statistics: { sizeOnDisk: 100 },
            },
          ];
        }
        return [];
      },
      getTracksByAlbumId: async () => [
        {
          id: 7,
          title: "Track",
          hasFile: true,
          trackFileId: 10915,
        },
      ],
      getTrackFilesByAlbumId: async () => [
        {
          id: 10915,
          path: trackPath,
          size: 5,
        },
      ],
    }),
    {
      pathsShareDevice: async () => false,
    },
  );

  await fs.rm(rootDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(
    result.steps.some((step) => step.id === "hardlink" && step.status === "warn"),
    true,
  );
});
