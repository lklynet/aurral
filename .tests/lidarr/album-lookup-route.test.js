import assert from "node:assert/strict";
import test from "node:test";

import { registerMisc } from "../../backend/routes/library/handlers/misc.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { logger } from "../../backend/services/logger.js";

test("album batch lookup bypasses stale cache and unrelated broken albums", async () => {
  const routes = new Map();
  registerMisc({
    get() {},
    post(path, handler) {
      routes.set(path, handler);
    },
  });

  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumMbidIndex = lidarrClient.getAlbumMbidIndex;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalWarn = logger.warn;
  let lookupOptions;
  let warning;
  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumMbidIndex = async () => {
    throw new Error("Sequence contains more than one element");
  };
  lidarrClient.getAlbumByMbid = async (mbid, options) => {
    lookupOptions = options;
    if (mbid === "broken-album") {
      throw new Error("Lidarr lookup failed");
    }
    return mbid === "target-album"
      ? {
          id: 42,
          artistId: 7,
          foreignAlbumId: "target-album",
          title: "To Be Still",
          monitored: true,
          statistics: {
            percentOfTracks: 0,
            sizeOnDisk: 0,
            trackCount: 11,
            trackFileCount: 0,
          },
        }
      : undefined;
  };
  logger.warn = (category, message, data) => {
    warning = { category, message, data };
  };

  let statusCode = 200;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  try {
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: ["target-album", "broken-album"] } },
      response,
    );

    assert.equal(statusCode, 200);
    assert.equal(body?.["target-album"]?.inLibrary, true);
    assert.equal(body?.["target-album"]?.status, "monitored");
    assert.equal(lookupOptions?.forceRefresh, true);
    assert.deepEqual(warning, {
      category: "library",
      message: "Lidarr album lookup failed",
      data: {
        foreignAlbumId: "broken-album",
        message: "Lidarr lookup failed",
      },
    });

    statusCode = 200;
    body = undefined;
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: Array.from({ length: 101 }, (_, index) => `album-${index}`) } },
      response,
    );

    assert.equal(statusCode, 400);
    assert.equal(body?.error, "mbids must contain at most 100 unique values");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumMbidIndex = originalGetAlbumMbidIndex;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    logger.warn = originalWarn;
  }
});
