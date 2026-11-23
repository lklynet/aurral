import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import { http } from "../../lib/http.ts";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const requestedKeys: string[][] = [];
const idReplies = new Map<
  string,
  { recordingId?: string | null; albumId?: string | null; artistId?: string | null }
>();

const providerServer = await createMockHttpServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/v1/ids") {
    const keys = (url.searchParams.get("keys") || "").split(",").filter(Boolean);
    requestedKeys.push(keys);
    const ids: Record<string, unknown> = {};
    for (const key of keys) {
      const hit = idReplies.get(key);
      if (hit) ids[key] = hit;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ids }));
    return;
  }
  response.writeHead(404);
  response.end();
});
process.env.METADATA_BASE_URL = providerServer.url;

const [state, { db }, { getDeezerPlaylist }, { clearMetadataProviderCaches }] =
  await setupIsolatedBackend(
    "deezer-playlists",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/importLists/deezerPlaylists.ts"),
    () => import("../../backend/services/providers/metadataProvider.ts"),
  );

beforeEach(() => {
  resetDatabase(db);
  clearMetadataProviderCaches();
  requestedKeys.length = 0;
  idReplies.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await providerServer.close();
  await cleanupIsolatedState(state);
});

test("Deezer playlist imports resolve album MBIDs from deezer-album keys without crossing artists", async () => {
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const otherArtistMbid = "22222222-2222-4222-8222-222222222222";
  const albumMbid = "33333333-3333-4333-8333-333333333333";
  const wrongAlbumMbid = "44444444-4444-4444-8444-444444444444";
  const recordingMbid = "55555555-5555-4555-8555-555555555555";

  idReplies.set("deezer-album:1001", { albumId: albumMbid, artistId: artistMbid });
  idReplies.set("deezer-artist:2001", { artistId: artistMbid });
  idReplies.set("isrc:GBAYE0601498", { recordingId: recordingMbid, artistId: artistMbid });
  idReplies.set("deezer-album:1002", { albumId: wrongAlbumMbid, artistId: otherArtistMbid });

  const providerGet = http.get.bind(http);
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (!url.startsWith("https://api.deezer.com/")) return providerGet(url, options);
    const pathname = new URL(url).pathname;
    if (pathname === "/playlist/42") {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: { id: 42, title: "Deezer Picks", nb_tracks: 2 },
      };
    }
    if (pathname === "/playlist/42/tracks") {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          data: [
            {
              id: 1,
              title: "No ISRC Track",
              duration: 210,
              artist: { id: 2001, name: "Band" },
              album: { id: 1001, title: "Known Album" },
            },
            {
              id: 2,
              title: "ISRC Track",
              isrc: "GBAYE0601498",
              duration: 200,
              artist: { id: 2001, name: "Band" },
              album: { id: 1002, title: "Mismatched Album" },
            },
            {
              id: 3,
              title: "Compilation Track",
              duration: 190,
              artist: { id: 2001, name: "Band" },
              album: { id: 1002, title: "Mismatched Album" },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected Deezer URL: ${url}`);
  });

  const imported = await getDeezerPlaylist("42", { catalogueIds: true });
  assert.deepEqual(requestedKeys, [
    ["deezer-album:1001", "deezer-album:1002", "deezer-artist:2001", "isrc:GBAYE0601498"],
  ]);
  assert.equal(imported.tracks[0]?.albumMbid, albumMbid);
  assert.equal(imported.tracks[0]?.artistMbid, artistMbid);
  assert.equal(imported.tracks[1]?.trackMbid, recordingMbid);
  assert.equal(imported.tracks[1]?.artistMbid, artistMbid);
  assert.equal(imported.tracks[1]?.albumMbid, null);
  assert.equal(imported.tracks[2]?.artistMbid, artistMbid);
  assert.equal(imported.tracks[2]?.albumMbid, null);
});
