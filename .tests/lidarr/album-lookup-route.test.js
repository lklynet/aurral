import assert from "node:assert/strict";
import test from "node:test";

import { registerMisc } from "../../backend/routes/library/handlers/misc.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";

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
  let lookupOptions;
  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumMbidIndex = async () => {
    throw new Error("Sequence contains more than one element");
  };
  lidarrClient.getAlbumByMbid = async (mbid, options) => {
    lookupOptions = options;
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
      { body: { mbids: ["target-album"] } },
      response,
    );

    assert.equal(statusCode, 200);
    assert.equal(body?.["target-album"]?.inLibrary, true);
    assert.equal(body?.["target-album"]?.status, "monitored");
    assert.equal(lookupOptions?.forceRefresh, true);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumMbidIndex = originalGetAlbumMbidIndex;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
  }
});
