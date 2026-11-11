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
    assert.equal(result.items[0]?.id, "artist-mbid");
    assert.equal(result.items[0]?.name, "Adele");
    assert.equal(result.items[0]?.artistType, "Person");
    assert.deepEqual(result.items[0]?.genres, ["pop"]);
    assert.equal(result.items[0]?.imageUrl, "https://images.example/adele.jpg");
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
    assert.ok(album);
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
    assert.ok(first);
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

test("requestAlbumFromSearch preserves an addAlbum conflict status", async () => {
  vi.spyOn(libraryManager, "getArtist").mockReturnValue({
    id: "7",
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
  } as ReturnType<typeof libraryManager.getArtist>);
  vi.spyOn(libraryManager, "addAlbum").mockImplementation(
    async () =>
      ({
        error: "Album belongs to a different artist",
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
      assert.equal(asAppError(error)?.message ?? "", "Album belongs to a different artist");
      return true;
    },
  );
});

test("requestAlbumFromSearch rejects when artist must be created without addArtist permission", async () => {
  vi.spyOn(libraryManager, "getArtist").mockReturnValue(null);

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
