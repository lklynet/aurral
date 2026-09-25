import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const linkedArtistMbid = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const unlinkedArtistMbid = "12121212-1212-4121-8121-121212121212";
const albumMbid = "34343434-3434-4343-8343-343434343434";

const linkedArtist = {
  id: linkedArtistMbid,
  artistname: "Queen",
  artistaliases: ["クイーン"],
  genres: ["Rock", "Glam Rock"],
  images: [],
  links: [
    { type: "deezer", target: "https://www.deezer.com/en/artist/412" },
    { type: "discogs", target: "https://www.discogs.com/artist/81013-Queen" },
    { type: "wikidata", target: "https://www.wikidata.org/wiki/Q15862" },
  ],
  Albums: [],
};

const unlinkedArtist = {
  id: unlinkedArtistMbid,
  artistname: "Obscure Artist",
  artistaliases: [],
  genres: [],
  images: [],
  links: [],
  Albums: [],
};

const providerServer = await createMockHttpServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith(`/artist/${linkedArtistMbid}`)) {
    response.end(JSON.stringify(linkedArtist));
    return;
  }
  if (request.url?.startsWith(`/artist/${unlinkedArtistMbid}`)) {
    response.end(JSON.stringify(unlinkedArtist));
    return;
  }
  if (request.url?.startsWith(`/album/${albumMbid}`)) {
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
process.env.BRAINZMASH_BASE_URL = providerServer.url;

const [
  isolatedState,
  { default: axios },
  { getArtistByMbid },
  { musicbrainzGetArtistIdentityByMbid },
  { getArtistTagPayload },
  { registerPreview },
  { getArtistImage },
  { fetchReleaseGroupCoverUrl },
] = await setupIsolatedBackend(
  "brainzmash-linked-metadata",
  "lib/axiosFetch.js",
  "backend/services/providers/brainzmashProvider.js",
  "backend/services/apiClients/musicbrainz.js",
  "backend/routes/artists/shared/transform.js",
  "backend/routes/artists/handlers/preview.js",
  "backend/services/imageService.js",
  "backend/services/releaseGroupCoverService.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
  await providerServer.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

const externalResponse = (url, options) => {
  if (url === "https://api.deezer.com/artist/412") {
    return { id: 412, name: "Queen", picture_big: "https://cdn.deezer.test/queen.jpg" };
  }
  if (url === "https://api.deezer.com/artist/412/top") {
    return {
      data: [{ id: 7, title: "Mustapha", preview: "https://cdn.deezer.test/7.mp3", duration: 180 }],
    };
  }
  if (url === "https://api.deezer.com/artist/412/albums") {
    return {
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
    return { data: [{ id: 999, name: "Queen Tribute Band", picture_big: "https://cdn.deezer.test/wrong.jpg" }] };
  }
  if (options?.params?.method === "artist.getTopTags") {
    return { toptags: { tag: [{ name: "classic rock", count: 100 }] } };
  }
  return {};
};

function recordExternalRequests(t) {
  const requests = [];
  const providerGet = axios.get.bind(axios);
  t.mock.method(axios, "get", async (url, options) => {
    if (String(url).startsWith(providerServer.url)) return providerGet(url, options);
    requests.push(options?.params?.method ? `${url}?method=${options.params.method}` : url);
    return { data: externalResponse(url, options) };
  });
  return requests;
}

test("artist identity comes from BrainzMash names, aliases, and linked provider IDs", async (t) => {
  const requests = recordExternalRequests(t);

  assert.deepEqual(await musicbrainzGetArtistIdentityByMbid(linkedArtistMbid), {
    mbid: linkedArtistMbid,
    name: "Queen",
    aliases: ["クイーン"],
    providerIds: ["412@deezer", "81013@discogs"],
  });
  assert.equal(await musicbrainzGetArtistIdentityByMbid("56565656-5656-4565-8565-565656565656"), null);
  assert.deepEqual(requests, []);
});

test("artist genres come from BrainzMash and Last.fm only fills artists without genres", async (t) => {
  process.env.LASTFM_API_KEY = "test-key";
  t.after(() => delete process.env.LASTFM_API_KEY);
  const requests = recordExternalRequests(t);

  const linked = await getArtistTagPayload(
    linkedArtistMbid,
    "Queen",
    await getArtistByMbid(linkedArtistMbid),
  );
  assert.deepEqual(linked.genres, ["Rock", "Glam Rock"]);
  assert.deepEqual(requests, []);

  const unlinked = await getArtistTagPayload(
    unlinkedArtistMbid,
    "Obscure Artist",
    await getArtistByMbid(unlinkedArtistMbid),
  );
  assert.deepEqual(unlinked.genres, ["classic rock"]);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /method=artist\.getTopTags$/);
});

test("artist previews use the BrainzMash Deezer link instead of a name search", async (t) => {
  const requests = recordExternalRequests(t);
  let handler;
  registerPreview({
    get: (_path, ...handlers) => {
      handler = handlers.at(-1);
    },
  });

  let body;
  await handler(
    { params: { mbid: linkedArtistMbid }, query: { artistName: "Queen" } },
    { json: (value) => (body = value) },
  );

  assert.deepEqual(
    body.tracks.map((track) => track.title),
    ["Mustapha"],
  );
  assert.deepEqual(requests, ["https://api.deezer.com/artist/412/top"]);
});

test("artist images fall back to the BrainzMash-linked Deezer artist", async (t) => {
  const requests = recordExternalRequests(t);

  const result = await getArtistImage(linkedArtistMbid, { forceRefresh: true });

  assert.ok(result.url);
  assert.deepEqual(requests, ["https://api.deezer.com/artist/412"]);
});

test("album covers fall back to the Deezer artist linked on the BrainzMash album", async (t) => {
  const requests = recordExternalRequests(t);

  const result = await fetchReleaseGroupCoverUrl(albumMbid, {
    artistName: "Queen",
    albumTitle: "Jazz",
    bypassCache: true,
  });

  assert.ok(result.imageUrl);
  assert.ok(!requests.some((url) => url.startsWith("https://api.deezer.com/search")));
  assert.ok(requests.includes("https://api.deezer.com/artist/412/albums"));
});
