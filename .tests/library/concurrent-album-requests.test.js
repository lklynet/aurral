import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";

const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent new-artist album requests search every requested album", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtistByMbid = lidarrClient.getArtistByMbid;
  const originalAddArtist = lidarrClient.addArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalResolveArtistAddOptions = libraryManager.resolveArtistAddOptions;
  const originalAddAlbum = libraryManager.addAlbum;

  const artistMbid = "concurrent-artist-mbid";
  const artist = {
    id: 7,
    artistName: "Concurrent Artist",
    foreignArtistId: artistMbid,
    monitored: true,
    monitor: "none",
  };
  let releaseArtistAdds;
  const artistAddGate = new Promise((resolve) => {
    releaseArtistAdds = resolve;
  });
  let artistAddCalls = 0;
  const albumSearches = [];

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtistByMbid = async (_mbid, { forceRefresh = false } = {}) =>
    forceRefresh ? artist : null;
  lidarrClient.addArtist = async () => {
    const callNumber = ++artistAddCalls;
    await artistAddGate;
    if (callNumber === 1) {
      await flushImmediate();
      return artist;
    }
    throw new Error("ArtistExistsValidator: artist already exists");
  };
  lidarrClient.getAlbumByMbid = async () => null;
  libraryManager.resolveArtistAddOptions = async () => ({
    quality: "standard",
    monitorOption: "none",
    rootFolderPath: "/music",
    qualityProfileId: 1,
  });
  libraryManager.addAlbum = async (_artistId, albumMbid, albumName, options) => {
    albumSearches.push({ albumMbid, albumName, triggerSearch: options.triggerSearch });
    return {
      id: albumMbid,
      artistId: 7,
      mbid: albumMbid,
      foreignAlbumId: albumMbid,
      albumName,
      monitored: true,
      statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
    };
  };

  try {
    const requests = ["album-a", "album-b", "album-c"].map((albumMbid) =>
      libraryManager.requestAlbumFromSearch({
        albumMbid,
        albumName: albumMbid,
        artistMbid,
        artistName: artist.artistName,
        triggerSearch: true,
        user: {
          role: "user",
          permissions: { addAlbum: true, addArtist: true },
        },
      }),
    );

    while (artistAddCalls < 3) await flushImmediate();
    releaseArtistAdds();

    const results = await Promise.all(requests);
    assert.equal(results.length, 3);
    assert.deepEqual(
      albumSearches.map(({ albumMbid, triggerSearch }) => [albumMbid, triggerSearch]).sort(),
      [
        ["album-a", true],
        ["album-b", true],
        ["album-c", true],
      ],
    );
    assert.equal(results.every((result) => result.status === "searching"), true);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtistByMbid = originalGetArtistByMbid;
    lidarrClient.addArtist = originalAddArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.resolveArtistAddOptions = originalResolveArtistAddOptions;
    libraryManager.addAlbum = originalAddAlbum;
  }
});
