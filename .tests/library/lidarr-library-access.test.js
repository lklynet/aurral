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
    result.steps.some((step) => step.id === "ready" && step.status === "pass"),
    true,
  );
});

test("runLidarrLibraryAccessTest shows translated root path when manual Lidarr mapping is used", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lidarr-map-"));
  const musicRoot = path.join(rootDir, "music");
  await fs.mkdir(musicRoot, { recursive: true });

  const previousMappings = process.env.PATH_MAPPINGS;
  const reportedRoot = "/data/media/music";
  process.env.PATH_MAPPINGS = `lidarr|${reportedRoot}|${musicRoot}`;
  const result = await runLidarrLibraryAccessTest(
    createMockLidarrClient({
      rootPath: reportedRoot,
    }),
  );

  if (previousMappings === undefined) {
    delete process.env.PATH_MAPPINGS;
  } else {
    process.env.PATH_MAPPINGS = previousMappings;
  }
  await fs.rm(rootDir, { recursive: true, force: true });

  const mountStep = result.steps.find((step) => step.id === "mount");
  assert.equal(result.ok, true);
  assert.equal(mountStep?.status, "pass");
  assert.match(mountStep?.detail || "", / -> /);
});

function createMultiArtistClient(rootPath, artists) {
  return createMockLidarrClient({
    rootPath,
    request: async (endpoint) => {
      if (endpoint === "/artist") {
        return artists.map(({ id, path: artistPath }) => ({
          id,
          artistName: `Artist ${id}`,
          path: artistPath,
        }));
      }
      const match = endpoint.match(/^\/album\?artistId=(\d+)$/);
      if (match) {
        return [{ id: Number(match[1]), title: "Album", statistics: { sizeOnDisk: 100 } }];
      }
      return [];
    },
    getTracksByAlbumId: async (albumId) => [
      { id: albumId, title: "Track", hasFile: true, trackFileId: albumId },
    ],
    getTrackFilesByAlbumId: async (albumId) => [
      {
        id: albumId,
        path: artists.find((artist) => artist.id === albumId).trackPath,
        size: 5,
      },
    ],
  });
}

test("runLidarrLibraryAccessTest samples an artist inside the root folder over a stale one", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lidarr-stale-"));
  const rootDir = path.join(tempDir, "Music, Vol 1");
  const trackPath = path.join(rootDir, "Artist 2", "Album", "01 - Track.mp3");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const result = await runLidarrLibraryAccessTest(
    createMultiArtistClient(rootDir, [
      {
        id: 1,
        path: "/legacy-root/Artist 1",
        trackPath: "/legacy-root/Artist 1/Album/01 - Track.mp3",
      },
      { id: 2, path: path.dirname(path.dirname(trackPath)), trackPath },
    ]),
  );

  await fs.rm(tempDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.sample?.path, trackPath);
  assert.deepEqual(result.rootPaths, [rootDir]);
});

test("runLidarrLibraryAccessTest blames the root folder, not mounts, for a track outside every root", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lidarr-outside-"));

  const result = await runLidarrLibraryAccessTest(
    createMultiArtistClient(rootDir, [
      {
        id: 1,
        path: "/legacy-root/Artist 1",
        trackPath: "/legacy-root/Artist 1/Album/01 - Track.mp3",
      },
    ]),
  );

  await fs.rm(rootDir, { recursive: true, force: true });

  const fileStep = result.steps.find((step) => step.id === "file");
  assert.equal(result.ok, false);
  assert.equal(fileStep?.status, "fail");
  assert.match(fileStep?.fix || "", /outside its root folders/);
  assert.doesNotMatch(fileStep?.fix || "", /PUID/);
});

test("runLidarrLibraryAccessTest omits unrelated filesystem placement checks", async () => {
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
  );

  await fs.rm(rootDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(
    result.steps.some((step) => step.id === "hardlink"),
    false,
  );
  assert.equal(
    result.steps.some((step) => step.id === "ready" && step.status === "pass"),
    true,
  );
});
