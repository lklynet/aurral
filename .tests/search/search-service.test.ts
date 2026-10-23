import { asAppError } from "../../lib/errors.ts";
import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { createMockHttpServer } from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { dbOps } from "../../backend/db/helpers/index.ts";
import { clearMetadataProviderCaches } from "../../backend/services/providers/brainzmashProvider.ts";
import {
  normalizeAlbumReleaseTypesFilter,
  searchAlbums,
  searchArtists,
} from "../../backend/services/searchService.ts";
import { libraryManager } from "../../backend/services/libraryManager.ts";
import { lidarrClient } from "../../backend/services/lidarrClient.ts";

test("searchArtists normalizes BrainzMash artists", async () => {
  let requests = 0;
  const server = await createMockHttpServer((request, response) => {
    if (!request.url?.startsWith("/search/artist")) {
      response.writeHead(404);
      response.end();
      return;
    }
    requests += 1;
    if (requests === 1) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "artist-mbid",
          artistname: "Adele",
          sortname: "Adele",
          type: "Person",
          genres: ["pop"],
          images: [{ Url: "https://images.example/adele.jpg", CoverType: "poster" }],
        },
      ]),
    );
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();

  try {
    const result = await searchArtists("Adele", 5, 0);
    assert.equal(result.items[0].id, "artist-mbid");
    assert.equal(result.items[0].name, "Adele");
    assert.equal(result.items[0].artistType, "Person");
    assert.deepEqual(result.items[0].genres, ["pop"]);
    assert.equal(result.items[0].imageUrl, "https://images.example/adele.jpg");
    assert.equal(requests, 2);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
  }
});

test("searchAlbums names the album's credited artist, not the first one listed", async () => {
  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/search/album")
          ? [
              {
                id: "agaetis",
                title: "Ágætis byrjun",
                artistid: "sigur-ros",
                artists: [
                  { id: "amiina", artistname: "amiina" },
                  { id: "sigur-ros", artistname: "Sigur Rós" },
                ],
              },
            ]
          : [],
      ),
    );
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  try {
    const [album] = (await searchAlbums("Agaetis byrjun", 5, 0)).items;
    assert.deepEqual([album.artistName, album.artistMbid], ["Sigur Rós", "sigur-ros"]);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
  }
});

test("searchAlbums puts the album an artist and title search names first", async () => {
  const album = (id: string, artistname: string, title: string, secondarytypes: string[] = []) => ({
    id,
    title,
    secondarytypes,
    artistid: artistname,
    artists: [{ id: artistname, artistname }],
  });
  const server = await createMockHttpServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        url.pathname !== "/search/album"
          ? []
          : [
              album("tribute", "Royal Philharmonic Orchestra", "Plays Fleetwood Mac's Rumours", [
                "Compilation",
              ]),
              album("bundle", "Fleetwood Mac", "Fleetwood Mac / Rumours", ["Compilation"]),
              album("self-titled", "Fleetwood Mac", "Fleetwood Mac"),
              album("cello", "Trevor Exter", "Fleetwood Mac Rumours: Solo Cello"),
              album("rumours", "Fleetwood Mac", "Rumours"),
            ].slice(0, Number(url.searchParams.get("limit")) || undefined),
      ),
    );
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  try {
    const [first] = (await searchAlbums("Fleetwood Mac Rumours", 2, 0)).items;
    assert.deepEqual([first.artistName, first.title], ["Fleetwood Mac", "Rumours"]);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
  }
});

test("searchAlbums reports a further page while more results exist", async () => {
  const server = await createMockHttpServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        url.pathname !== "/search/album"
          ? []
          : Array.from({ length: 45 }, (_, index) => ({
              id: `album-${index}`,
              title: `Paged Album ${index}`,
              artistid: "paged",
              artists: [{ id: "paged", artistname: "Paged Artist" }],
            })).slice(0, Number(url.searchParams.get("limit")) || undefined),
      ),
    );
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  try {
    assert.equal((await searchAlbums("Paged Album", 20, 20)).hasMore, true);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
  }
});

test("normalizeAlbumReleaseTypesFilter removes invalid and duplicate release types", () => {
  assert.deepEqual(normalizeAlbumReleaseTypesFilter("Album,Live,Album,Invalid"), ["Album", "Live"]);
});

const boardsOfCanada = {
  id: 7,
  artistName: "Boards of Canada",
  foreignArtistId: "artist-mbid",
  monitor: "none",
};

const geogaddi = {
  id: 42,
  artistId: 7,
  foreignAlbumId: "album-mbid",
  title: "Geogaddi",
  monitored: true,
  statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
};

test("requestAlbumFromSearch queues a new artist album search with the artist add", async () => {
  let waitCalls = 0;
  let artistAddOptions: Parameters<typeof libraryManager.addArtistWithResolvedOptions>[2];

  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(undefined);
  vi.spyOn(libraryManager, "getArtist").mockResolvedValue(null);
  vi.spyOn(libraryManager, "resolveArtistAddOptions").mockImplementation(
    async () =>
      ({
        quality: "standard",
        monitorOption: "none",
        rootFolderPath: "/music/main",
        qualityProfileId: 7,
      }) as Awaited<ReturnType<typeof libraryManager.resolveArtistAddOptions>>,
  );
  vi.spyOn(libraryManager, "addArtistWithResolvedOptions").mockImplementation(
    async (_mbid, _name, options) => {
      artistAddOptions = options;
      return {
        id: "7",
        mbid: "artist-mbid",
        foreignArtistId: "artist-mbid",
        artistName: "Boards of Canada",
        monitorOption: "none",
      } as Awaited<ReturnType<typeof libraryManager.addArtistWithResolvedOptions>>;
    },
  );
  vi.spyOn(libraryManager, "waitForAlbumByMbidForArtist").mockImplementation(async () => {
    waitCalls += 1;
    return null;
  });
  vi.spyOn(libraryManager, "addAlbum").mockImplementation(
    async (artistId, albumMbid, albumName, options) => {
      assert.equal(waitCalls, 0);
      assert.equal(artistId, "7");
      assert.equal(albumMbid, "album-mbid");
      assert.equal(albumName, "Geogaddi");
      assert.equal(options?.triggerSearch, true);
      return {
        id: "42",
        artistId: "7",
        mbid: "album-mbid",
        foreignAlbumId: "album-mbid",
        albumName: "Geogaddi",
        monitored: true,
        statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
      } as Awaited<ReturnType<typeof libraryManager.addAlbum>>;
    },
  );

  const result = await libraryManager.requestAlbumFromSearch({
    albumMbid: "album-mbid",
    albumName: "Geogaddi",
    artistMbid: "artist-mbid",
    artistName: "Boards of Canada",
    triggerSearch: true,
    user: testUser(1, { permissions: { addAlbum: true, addArtist: true } }),
  });

  assert.equal(result.success, true);
  assert.equal(result.createdArtist, true);
  assert.equal(result.createdAlbum, true);
  assert.equal(result.triggeredSearch, true);
  assert.equal(result.album.id, "42");
  assert.equal(artistAddOptions?.triggerSearch, true);
});

test("requestAlbumFromSearch preserves an addAlbum conflict status", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(undefined);
  vi.spyOn(libraryManager, "getArtist").mockResolvedValue({
    id: "7",
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
  } as Awaited<ReturnType<typeof libraryManager.getArtist>>);
  vi.spyOn(libraryManager, "ensureArtistMonitored").mockImplementation(async (artist) => artist);
  vi.spyOn(libraryManager, "addAlbum").mockImplementation(
    async () =>
      ({
        error: "Album already exists in Lidarr under a different artist",
        statusCode: 409,
      }) as Awaited<ReturnType<typeof libraryManager.addAlbum>>,
  );

  await assert.rejects(
    () =>
      libraryManager.requestAlbumFromSearch({
        albumMbid: "album-mbid",
        albumName: "Geogaddi",
        artistMbid: "artist-mbid",
        artistName: "Boards of Canada",
      }),
    (error) => {
      assert.equal(asAppError(error)?.statusCode, 409);
      assert.equal(
        asAppError(error)?.message ?? "",
        "Album already exists in Lidarr under a different artist",
      );
      return true;
    },
  );
});

test("requestAlbumFromSearch rejects when artist must be created without addArtist permission", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(libraryManager, "getArtist").mockResolvedValue(null);

  await assert.rejects(
    () =>
      libraryManager.requestAlbumFromSearch({
        albumMbid: "album-mbid",
        albumName: "Chrono Trigger",
        artistMbid: "artist-mbid",
        artistName: "Various Artists",
        user: testUser(1, { permissions: { addAlbum: true, addArtist: false } }),
      }),
    (error) => {
      assert.equal(asAppError(error)?.statusCode, 403);
      assert.match(asAppError(error)?.message ?? "", /Permission required: addArtist/);
      return true;
    },
  );
});

test("addAlbum checks artist monitoring while monitoring only the requested album", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ ...boardsOfCanada, monitored: false });
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(undefined);
  vi.spyOn(lidarrClient, "addAlbum").mockResolvedValue(geogaddi);
  const updateArtistMonitoring = vi
    .spyOn(lidarrClient, "updateArtistMonitoring")
    .mockResolvedValue({
      ...boardsOfCanada,
      monitored: true,
      monitorNewItems: "none",
      addOptions: { monitor: "none" },
    });

  const album = await libraryManager.addAlbum(7, "album-mbid", "Geogaddi");

  assert.equal(album.id, "42");
  assert.deepEqual(updateArtistMonitoring.mock.calls, [[7, "none"]]);
});

test("addAlbum force-refreshes and searches an existing album", async () => {
  const existingAlbum = { ...geogaddi, foreignAlbumId: "fresh-album-mbid" };

  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ ...boardsOfCanada, monitored: true });
  const getAlbumByMbid = vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(existingAlbum);
  vi.spyOn(lidarrClient, "getAlbum").mockResolvedValue(existingAlbum);
  const addAlbum = vi.spyOn(lidarrClient, "addAlbum").mockResolvedValue(existingAlbum);
  const triggerAlbumSearch = vi.spyOn(lidarrClient, "triggerAlbumSearch").mockResolvedValue({});
  vi.spyOn(libraryManager, "ensureRequestedAlbumMonitoring").mockImplementation(
    async () => ({}) as Awaited<ReturnType<typeof libraryManager.ensureRequestedAlbumMonitoring>>,
  );
  vi.spyOn(libraryManager, "scheduleRequestedAlbumMonitoringRepair").mockImplementation(() => {});

  const album = await libraryManager.addAlbum(7, "fresh-album-mbid", "Geogaddi", {
    triggerSearch: true,
  });

  assert.equal(album.id, "42");
  assert.equal(getAlbumByMbid.mock.calls[0][1]?.forceRefresh, true);
  assert.equal(addAlbum.mock.calls.length, 0);
  assert.deepEqual(triggerAlbumSearch.mock.calls, [[42]]);
});

test("addAlbum coalesces concurrent requests for the same album", async () => {
  let releaseAdd!: () => void;
  const addGate = new Promise<void>((resolve) => {
    releaseAdd = resolve;
  });

  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ ...boardsOfCanada, monitored: true });
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(undefined);
  const addAlbum = vi.spyOn(lidarrClient, "addAlbum").mockImplementation(async () => {
    await addGate;
    return { ...geogaddi, foreignAlbumId: "concurrent-album-mbid" };
  });

  const firstRequest = libraryManager.addAlbum(7, "concurrent-album-mbid", "Geogaddi");
  const secondRequest = libraryManager.addAlbum(7, "concurrent-album-mbid", "Geogaddi");
  releaseAdd();

  const [first, second] = await Promise.all([firstRequest, secondRequest]);
  assert.equal(addAlbum.mock.calls.length, 1);
  assert.equal(first.id, "42");
  assert.equal(second.id, "42");
});

test("addAlbum reports when Lidarr already owns an album under another artist", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ ...boardsOfCanada, monitored: true });
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue({
    id: 99,
    artistId: 8,
    foreignAlbumId: "owned-by-another-artist",
    title: "Geogaddi",
    monitored: true,
  });
  const addAlbum = vi
    .spyOn(lidarrClient, "addAlbum")
    .mockRejectedValue(new Error("AlbumExistsValidator: This album has already been added"));

  const result = await libraryManager.addAlbum(7, "owned-by-another-artist", "Geogaddi");

  assert.equal(result.statusCode, 409);
  assert.equal(result.error, "Album already exists in Lidarr under a different artist");
  assert.equal(addAlbum.mock.calls.length, 0);
});

test("addAlbum monitors and searches the requested album after Lidarr conflict lag", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ ...boardsOfCanada, monitored: false });
  vi.spyOn(lidarrClient, "getAlbumByMbid").mockResolvedValue(undefined);
  const updateArtistMonitoring = vi
    .spyOn(lidarrClient, "updateArtistMonitoring")
    .mockResolvedValue({ ...boardsOfCanada, monitored: true });
  vi.spyOn(lidarrClient, "addAlbum").mockRejectedValue(
    new Error("AlbumExistsValidator: This album has already been added"),
  );
  vi.spyOn(libraryManager, "waitForAlbumByMbidForArtist").mockImplementation(
    async () =>
      ({ ...geogaddi, monitored: false }) as Awaited<
        ReturnType<typeof libraryManager.waitForAlbumByMbidForArtist>
      >,
  );
  const monitorAlbum = vi.spyOn(lidarrClient, "monitorAlbum").mockResolvedValue(geogaddi);
  const triggerAlbumSearch = vi.spyOn(lidarrClient, "triggerAlbumSearch").mockResolvedValue({});
  vi.spyOn(lidarrClient, "getAlbum").mockResolvedValue(geogaddi);

  const album = await libraryManager.addAlbum(7, "album-mbid", "Geogaddi", {
    triggerSearch: true,
  });

  assert.equal(album.id, "42");
  assert.equal(album.monitored, true);
  assert.deepEqual(updateArtistMonitoring.mock.calls, [[7, "none"]]);
  assert.deepEqual(monitorAlbum.mock.calls, [[42, true]]);
  assert.deepEqual(triggerAlbumSearch.mock.calls, [[42]]);
});
