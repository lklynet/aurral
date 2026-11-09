type AddedArtist = {
  id: number;
  monitored: boolean;
  monitor: string;
  monitorNewItems: string;
  addOptions: { monitor: string; albumsToMonitor: string[]; searchForMissingAlbums: boolean };
};
import { describe, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { LidarrClient } from "../../backend/services/lidarrClient.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";

function createClient() {
  const client = new LidarrClient();
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
    test(`album request remains wanted after artist refresh (${monitorOption || "default"}, search=${triggerSearch})`, async () => {
      const client = createClient();
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
      assert.equal(albums[1]?.monitored, false);
      assert.ok(artist != null);
      assert.equal(artist.monitorNewItems, "none");
      assert.ok(postedArtist != null);
      assert.equal(postedArtist.addOptions.monitor, "missing");
      assert.ok(postedArtist != null);
      assert.equal(postedArtist.addOptions.searchForMissingAlbums, triggerSearch);
    });
  }
}

for (const monitorOption of ["none", "all"]) {
  test(`ordinary artist add preserves the ${monitorOption} monitoring option`, async () => {
    const client = createClient();
    let postedArtist: AddedArtist | undefined;
    vi.spyOn(client, "request").mockImplementation(async (endpoint, method, payload) => {
      assert.equal(endpoint, "/artist");
      assert.equal(method, "POST");
      postedArtist = payload as AddedArtist;
      return { ...(payload as AddedArtist), id: 7, monitored: true };
    });
    const added = await client.addArtist("artist-mbid", "Test Artist", {
      monitorOption,
      metadataProfileId: 1,
    });
    assert.equal(added.addOptions?.monitor, monitorOption);
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.addOptions.monitor, monitorOption === "none" ? "future" : "all");
    assert.equal(postedArtist.monitored, true);
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.addOptions.albumsToMonitor, undefined);
    assert.ok(postedArtist != null);
    assert.equal(postedArtist.monitorNewItems, monitorOption === "all" ? "all" : "none");
  });
}

describe("waitForArtistAdded", () => {
  useFakeClock();

  test("returns once Lidarr clears addOptions after its post-add pass", async () => {
    const client = new LidarrClient();
    const adding = {
      id: 7,
      artistName: "Test Artist",
      foreignArtistId: "artist-mbid",
      monitored: true,
      addOptions: { monitor: "missing" },
    };
    const getArtist = vi
      .spyOn(client, "getArtist")
      .mockResolvedValueOnce(adding)
      .mockResolvedValueOnce(adding)
      .mockResolvedValue({ ...adding, addOptions: null });

    const artist = await client.waitForArtistAdded(7);

    assert.equal(artist?.addOptions, null);
    assert.equal(getArtist.mock.calls.length, 3);
  });
});
