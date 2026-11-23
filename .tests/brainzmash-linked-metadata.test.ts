import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const linkedArtistMbid = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const unlinkedArtistMbid = "12121212-1212-4121-8121-121212121212";
const albumMbid = "34343434-3434-4343-8343-343434343434";

const linkedArtist = {
  id: linkedArtistMbid,
  name: "Queen",
  aliases: ["クイーン"],
  genres: ["Rock", "Glam Rock"],
  images: [],
  links: [
    { type: "deezer", target: "https://www.deezer.com/artist/14085093" },
    { type: "deezer", target: "https://www.deezer.com/en/artist/412" },
    { type: "discogs", target: "https://www.discogs.com/artist/81013-Queen" },
    { type: "wikidata", target: "https://www.wikidata.org/wiki/Q15862" },
    { type: "other", target: "https://constructor/artist/1" },
  ],
  albums: [],
};

const unlinkedArtist = {
  id: unlinkedArtistMbid,
  name: "Obscure Artist",
  aliases: [],
  genres: [],
  images: [],
  links: [],
  albums: [],
};

const topTrackArtistMbid = "89898989-8989-4898-8898-898989898989";
const topTrackAlbumMbid = "90909090-9090-4909-8909-909090909090";
const topTrackArtist = {
  id: topTrackArtistMbid,
  name: "Top Track Band",
  aliases: [],
  genres: ["Rock"],
  images: [],
  links: [{ type: "deezer", target: "https://www.deezer.com/en/artist/412" }],
  albums: [{ id: topTrackAlbumMbid, title: "Greatest Hits", type: "Album" }],
  topTracks: [
    {
      recordingId: "12345678-1234-4123-8123-1234567890ab",
      title: "Bohemian Rhapsody",
      albumId: topTrackAlbumMbid,
      durationMs: 354000,
      listeners: 90000,
    },
  ],
};

const providerPaths: string[] = [];
const providerServer = await createMockHttpServer((request, response) => {
  providerPaths.push(request.url || "");
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith(`/v1/artist/${linkedArtistMbid}`)) {
    response.end(JSON.stringify(linkedArtist));
    return;
  }
  if (request.url?.startsWith(`/v1/artist/${unlinkedArtistMbid}`)) {
    response.end(JSON.stringify(unlinkedArtist));
    return;
  }
  if (request.url?.startsWith(`/v1/artist/${topTrackArtistMbid}`)) {
    response.end(JSON.stringify(topTrackArtist));
    return;
  }
  if (request.url?.startsWith(`/v1/album/${albumMbid}`)) {
    response.end(
      JSON.stringify({ id: albumMbid, title: "Jazz", images: [], artists: [linkedArtist] }),
    );
    return;
  }
  if (request.url?.startsWith("/search/")) {
    response.end("[]");
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
process.env.METADATA_BASE_URL = providerServer.url;

const [
  isolatedState,
  { http },
  { getArtistByMbid },
  { getArtistTagPayload },
  { default: preview },
  { fetchReleaseGroupCoverUrl },
  { getArtistTopTracks },
] = await setupIsolatedBackend(
  "brainzmash-linked-metadata",
  () => import("../lib/http.ts"),
  () => import("../backend/services/providers/metadataProvider.ts"),
  () => import("../backend/routes/artists/shared/transform.ts"),
  () => import("../backend/routes/artists/handlers/preview.ts"),
  () => import("../backend/services/releaseGroupCoverService.ts"),
  () => import("../backend/services/musicDataSource/index.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
  await providerServer.close();
  delete process.env.METADATA_BASE_URL;
});

const externalResponse = (url: string) => {
  if (url === "https://api.deezer.com/artist/412") {
    return { id: 412, name: "Queen", picture_big: "https://cdn.deezer.test/queen.jpg" };
  }
  if (url === "https://api.deezer.com/artist/412/top") {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: [{ id: 7, title: "Mustapha", preview: "https://cdn.deezer.test/7.mp3", duration: 180 }],
    };
  }
  if (url === "https://api.deezer.com/artist/412/albums") {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: [
        {
          id: 9,
          title: "Jazz",
          record_type: "album",
          cover_big: "https://cdn.deezer.test/jazz.jpg",
          release_date: "1978-11-10",
        },
      ],
    };
  }
  if (url.startsWith("https://api.deezer.com/search")) {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: [
        { id: 999, name: "Queen Tribute Band", picture_big: "https://cdn.deezer.test/wrong.jpg" },
      ],
    };
  }
  return {};
};

function recordExternalRequests() {
  const requests: string[] = [];
  const providerGet = http.get.bind(http);
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (String(url).startsWith(providerServer.url)) return providerGet(url, options);
    if (String(url).startsWith("https://musicbrainz.org/")) {
      throw Object.assign(new Error("not found"), { response: { status: 404 } });
    }
    requests.push(url);
    return { status: 200, statusText: "OK", headers: {}, data: externalResponse(url) };
  });
  return requests;
}

test("artist genres come straight from v1 artist metadata without calling ListenBrainz", async () => {
  const requests = recordExternalRequests();

  const linked = getArtistTagPayload(await getArtistByMbid(linkedArtistMbid));
  assert.deepEqual(linked.genres, ["Rock", "Glam Rock"]);

  const unlinked = getArtistTagPayload(await getArtistByMbid(unlinkedArtistMbid));
  assert.deepEqual(unlinked.genres, []);
  assert.deepEqual([...requests], []);
});

test("artist previews play the artist file's top tracks, then the linked Deezer artist's", async () => {
  const requests = recordExternalRequests();
  const previewTracks = async (mbid: string, artistName: string) => {
    const response = await preview.request(
      `/artists/${mbid}/preview?${new URLSearchParams({ artistName })}`,
    );
    const { tracks }: { tracks: { title: string; preview_url: string | null }[] } =
      await response.json();
    return tracks.map((track) => [track.title, track.preview_url]);
  };

  assert.deepEqual(await previewTracks(topTrackArtistMbid, "Top Track Band"), [
    ["Bohemian Rhapsody", "/api/deezer/preview?artist=Top+Track+Band&track=Bohemian+Rhapsody"],
  ]);
  assert.deepEqual(requests, []);

  assert.deepEqual(await previewTracks(linkedArtistMbid, "Queen"), [
    ["Mustapha", "/api/deezer/preview/7.mp3"],
  ]);
  assert.deepEqual(requests, ["https://api.deezer.com/artist/412/top"]);
});

test("top tracks come from v1 artist data first, then fall back to the linked Deezer artist", async () => {
  const requests = recordExternalRequests();

  const fromV1 = await getArtistTopTracks({
    name: "Top Track Band",
    mbid: topTrackArtistMbid,
  });
  assert.deepEqual(fromV1, [
    {
      name: "Bohemian Rhapsody",
      albumName: "Greatest Hits",
      mbid: "12345678-1234-4123-8123-1234567890ab",
      durationMs: 354000,
      popularity: 90000,
    },
  ]);
  assert.deepEqual(requests, []);

  await getArtistByMbid(linkedArtistMbid);
  providerPaths.length = 0;

  const saved = await getArtistTopTracks({
    name: "Queen",
    mbid: linkedArtistMbid,
  });
  const unsaved = await getArtistTopTracks({
    name: "Queens",
    mbid: "78787878-7878-4787-8787-787878787878",
  });

  assert.deepEqual(
    saved.map((track) => track.name),
    ["Mustapha"],
  );
  assert.deepEqual(unsaved, []);
  assert.deepEqual(requests, [
    "https://api.deezer.com/artist/412/top",
    "https://api.deezer.com/search/artist",
  ]);
  assert.deepEqual(providerPaths, ["/v1/artist/78787878-7878-4787-8787-787878787878"]);
});

test("album covers fall back to the Deezer artist linked on the BrainzMash album", async () => {
  const requests = recordExternalRequests();

  const result = await fetchReleaseGroupCoverUrl(albumMbid, {
    artistName: "Queen",
    albumTitle: "Jazz",
    bypassCache: true,
  });

  assert.ok(result.imageUrl);
  assert.ok(!requests.some((url: string) => url.startsWith("https://api.deezer.com/search")));
  assert.ok(requests.includes("https://api.deezer.com/artist/412/albums"));
});
