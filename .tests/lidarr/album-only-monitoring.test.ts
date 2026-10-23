type AddedArtist = {
  id: number;
  monitored: boolean;
  monitor: string;
  monitorNewItems: string;
  addOptions: { monitor: string; albumsToMonitor: string[]; searchForMissingAlbums: boolean };
};
import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { LidarrClient } from "../../backend/services/lidarrClient.ts";

function createClient(t: import("vite-plus/test").TestContext) {
  const client = new LidarrClient();
  t.onTestFinished(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  vi.spyOn(client, "resolveArtistAddConfiguration").mockImplementation(async () => ({
    rootFolders: [],
    qualityProfiles: [],
    fallbacks: { rootFolderPath: "/music", qualityProfileId: 1 },
    resolved: { rootFolderPath: "/music", qualityProfileId: 1 },
  }));
  return client;
}

for (const triggerSearch of [false, true]) {
  for (const monitorOption of [undefined, "none"]) {
    test(`album request remains wanted after artist refresh (${monitorOption || "default"}, search=${triggerSearch})`, async (t: import("vite-plus/test").TestContext) => {
      const client = createClient(t);
      let artist: AddedArtist | undefined;
      let refreshSnapshot: AddedArtist | undefined;
      let postedArtist: AddedArtist | undefined;
      const albums = [
        { foreignAlbumId: "requested-album", monitored: false },
        { foreignAlbumId: "other-missing-album", monitored: false },
      ];
      vi.spyOn(client, "request").mockImplementation(async (endpoint, method = "GET", payload) => {
        if (endpoint === "/artist" && method === "POST") {
          const posted = payload as AddedArtist;
          postedArtist = structuredClone(posted);
          // Lidarr's AddArtistService disables the artist for monitor=none.
          artist = {
            ...(payload as AddedArtist),
            id: 7,
            monitored:
              (payload as AddedArtist).addOptions.monitor !== "none" &&
              (payload as AddedArtist).monitored,
          };
          refreshSnapshot = structuredClone(artist);
          return structuredClone(artist);
        }
        if (endpoint === "/artist/7" && method === "GET") return structuredClone(artist);
        if (endpoint === "/artist/7" && method === "PUT") {
          artist = structuredClone(payload as AddedArtist);
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
        assert.ok(artist != null);
        album.monitored = artist.addOptions.albumsToMonitor.includes(album.foreignAlbumId);
      }
      assert.ok(artist != null);
      const currentArtist = artist;
      const wanted = albums.filter((album) => currentArtist.monitored && album.monitored);
      assert.deepEqual(
        wanted.map((album) => album.foreignAlbumId),
        ["requested-album"],
      );
      assert.equal(albums[1].monitored, false);
      assert.ok(artist != null);
      assert.equal(artist.monitorNewItems, "none");
      assert.ok(postedArtist != null);
      assert.equal(postedArtist.monitor, "missing");
      assert.ok(postedArtist != null);
      assert.equal(postedArtist.addOptions.monitor, "missing");
      assert.ok(postedArtist != null);
      assert.equal(postedArtist.addOptions.searchForMissingAlbums, triggerSearch);
    });
  }
}

for (const monitorOption of ["none", "all"]) {
  test(`ordinary artist add preserves the ${monitorOption} monitoring option`, async (t: import("vite-plus/test").TestContext) => {
    const client = createClient(t);
    let postedArtist: AddedArtist | undefined;
    vi.spyOn(client, "request").mockImplementation(async (endpoint, method, payload) => {
      assert.equal(endpoint, "/artist");
      assert.equal(method, "POST");
      postedArtist = payload as AddedArtist;
      return { ...(payload as AddedArtist), id: 7, monitored: true };
    });
    await client.addArtist("artist-mbid", "Test Artist", { monitorOption, metadataProfileId: 1 });
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.addOptions.monitor, monitorOption);
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.addOptions.albumsToMonitor, undefined);
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.monitorNewItems, monitorOption === "all" ? "all" : "none");
  });
}
