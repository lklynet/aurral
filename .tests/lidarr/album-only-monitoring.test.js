import test from "node:test";
import assert from "node:assert/strict";
import { LidarrClient } from "../../backend/services/lidarrClient.js";

function createClient(t) {
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  t.mock.method(client, "resolveArtistAddConfiguration", async () => ({
    resolved: { rootFolderPath: "/music", qualityProfileId: 1 },
  }));
  return client;
}

for (const triggerSearch of [false, true]) {
  for (const monitorOption of [undefined, "none"]) {
    test(`album request remains wanted after artist refresh (${monitorOption || "default"}, search=${triggerSearch})`, async (t) => {
      const client = createClient(t);
      let artist;
      let refreshSnapshot;
      let postedArtist;
      const albums = [
        { foreignAlbumId: "requested-album", monitored: false },
        { foreignAlbumId: "other-missing-album", monitored: false },
      ];
      t.mock.method(client, "request", async (endpoint, method = "GET", payload) => {
        if (endpoint === "/artist" && method === "POST") {
          postedArtist = structuredClone(payload);
          // Lidarr's AddArtistService disables the artist for monitor=none.
          artist = { ...payload, id: 7, monitored: payload.addOptions.monitor !== "none" && payload.monitored };
          refreshSnapshot = structuredClone(artist);
          return structuredClone(artist);
        }
        if (endpoint === "/artist/7" && method === "GET") return structuredClone(artist);
        if (endpoint === "/artist/7" && method === "PUT") {
          artist = structuredClone(payload);
          return structuredClone(artist);
        }
        assert.fail(`Unexpected Lidarr request: ${method} ${endpoint}`);
      });

      const added = await client.addArtist("artist-mbid", "Test Artist", {
        albumOnly: true,
        albumMbid: "requested-album",
        monitorOption,
        triggerSearch,
        metadataProfileId: 1,
      });
      assert.equal(added.monitored, true);

      // A delayed refresh can write the original artist snapshot after an early repair.
      // Lidarr's AlbumMonitoredService gives AlbumsToMonitor precedence over monitor.
      artist = refreshSnapshot;
      for (const album of albums) {
        album.monitored = artist.addOptions.albumsToMonitor.includes(album.foreignAlbumId);
      }
      const wanted = albums.filter((album) => artist.monitored && album.monitored);
      assert.deepEqual(wanted.map((album) => album.foreignAlbumId), ["requested-album"]);
      assert.equal(albums[1].monitored, false);
      assert.equal(artist.monitorNewItems, "none");
      assert.equal(postedArtist.addOptions.searchForMissingAlbums, triggerSearch);
    });
  }
}

for (const monitorOption of ["none", "all"]) {
  test(`ordinary artist add preserves the ${monitorOption} monitoring option`, async (t) => {
    const client = createClient(t);
    let postedArtist;
    t.mock.method(client, "request", async (endpoint, method, payload) => {
      assert.equal(endpoint, "/artist");
      assert.equal(method, "POST");
      postedArtist = payload;
      return { ...payload, id: 7, monitored: true };
    });
    await client.addArtist("artist-mbid", "Test Artist", { monitorOption, metadataProfileId: 1 });
    assert.equal(postedArtist.addOptions.monitor, monitorOption);
    assert.equal(postedArtist.addOptions.albumsToMonitor, undefined);
    assert.equal(postedArtist.monitorNewItems, monitorOption === "all" ? "all" : "none");
  });
}
