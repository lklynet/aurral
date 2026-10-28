import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi, type TestContext } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const mbid = "10101010-1010-4010-8010-101010101010";
const photo = "https://cdn.deezer.test/recovered-artist.jpg";
const missingArtist = { error: { type: "DataException", message: "no data", code: 800 } };
let artistLinked = true;
const provider = await createMockHttpServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      requireFixture(req.url).startsWith("/artist/")
        ? {
            id: mbid,
            artistname: "Provider Artist",
            images: [],
            Albums: [],
            links: artistLinked
              ? [{ type: "deezer", target: "https://www.deezer.com/artist/101" }]
              : [],
          }
        : [],
    ),
  );
});
process.env.BRAINZMASH_BASE_URL = provider.url;
const [
  state,
  { default: axios },
  deezer,
  { getArtistImage },
  { dbOps },
  { db },
  { clearMetadataProviderCaches },
  { listenbrainzSource },
] = await setupIsolatedBackend(
  "artist-provider-errors",
  () => import("../lib/axiosFetch.ts"),
  () => import("../backend/services/apiClients/deezer.ts"),
  () => import("../backend/services/imageService.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/services/providers/brainzmashProvider.ts"),
  () => import("../backend/services/musicDataSource/listenbrainz.ts"),
);

beforeEach(() => {
  artistLinked = true;
  resetDatabase(db);
  clearMetadataProviderCaches();
  for (const cache of [
    deezer.deezerArtistCache,
    deezer.deezerAlbumCache,
    deezer.deezerTopTrackCache,
  ])
    cache.flushAll();
});
afterAll(async () => {
  await cleanupIsolatedState(state);
  await provider.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

function responses(
  t: TestContext,
  respond: (url: string, options?: Parameters<typeof axios.get>[1]) => unknown,
) {
  const realGet = axios.get.bind(axios);
  vi.spyOn(axios, "get").mockImplementation(
    requireFixture(async (url, options) => {
      if (String(url).startsWith(provider.url)) return realGet(url, options);
      assert.equal(new URL(url).hostname, "api.deezer.com");
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: await respond(String(url), options),
      };
    }),
  );
}

test("an artist name search accepts only the same name, not the first result", async (t) => {
  responses(t, () => ({
    data: [
      { id: 7, name: "Lowkey" },
      { id: 8, name: "Sigur Rós", picture_big: photo },
    ],
  }));
  assert.equal(await deezer.getDeezerArtist("Low"), null);
  assert.equal((await deezer.getDeezerArtist("sigur ros"))?.imageUrl, photo);
});

test("a failed artist ID lookup can recover without clearing its cache", async (t) => {
  let failed = true;
  responses(t, () => {
    if (failed) throw new Error("Provider unavailable");
    return { id: 101, name: "Provider Artist", picture_big: photo };
  });
  assert.equal(await deezer.getDeezerArtistById(101), null);
  failed = false;
  assert.equal((await deezer.getDeezerArtistById(101))?.imageUrl, photo);
});

for (const [mode, options] of [
  ["default", undefined],
  ["strict", { throwOnError: true }],
] as const) {
  test("a missing artist ID is cached as absence for " + mode + " callers", async (t) => {
    let requests = 0;
    responses(t, () => {
      requests++;
      return missingArtist;
    });
    assert.equal(await deezer.getDeezerArtistById(101, options), null);
    assert.equal(await deezer.getDeezerArtistById(101, options), null);
    assert.equal(requests, 1);
  });
}

test("strict and default callers share a missing artist ID without treating it as an outage", async (t: import("vite-plus/test").TestContext) => {
  let release!: () => void;
  let requests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.onTestFinished(() => release());
  responses(t, async () => {
    requests++;
    await gate;
    return missingArtist;
  });
  const results = Promise.allSettled([
    deezer.getDeezerArtistById(101, { throwOnError: true }),
    deezer.getDeezerArtistById(101),
  ]);
  release();
  assert.deepEqual(await results, [
    { status: "fulfilled", value: null },
    { status: "fulfilled", value: null },
  ]);
  assert.equal(await deezer.getDeezerArtistById(101, { throwOnError: true }), null);
  assert.equal(requests, 1);
});

test("artist ID error 4 remains retryable for strict and default callers", async (t) => {
  let failed = true;
  responses(t, () =>
    failed
      ? { error: { code: 4, message: "Provider unavailable" } }
      : { id: 101, name: "Provider Artist", picture_big: photo },
  );
  await assert.rejects(deezer.getDeezerArtistById(101, { throwOnError: true }));
  assert.equal(await deezer.getDeezerArtistById(101), null);
  failed = false;
  assert.equal((await deezer.getDeezerArtistById(101, { throwOnError: true }))?.imageUrl, photo);
});

test("a name-search error in HTTP 200 is not cached as an absent artist", async (t) => {
  let failed = true;
  responses(t, () =>
    failed
      ? { error: { code: 4, message: "Quota" } }
      : { data: [{ id: 101, name: "Provider Artist", picture_big: photo }] },
  );
  assert.equal(await deezer.getDeezerArtist("Provider Artist"), null);
  failed = false;
  assert.equal((await deezer.getDeezerArtist("Provider Artist"))?.id, 101);
});

test("strict and fallback callers sharing an artist lookup retain their error contracts", async (t: import("vite-plus/test").TestContext) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.onTestFinished(() => release());
  responses(t, async () => {
    await gate;
    throw new Error("Provider unavailable");
  });
  const results = Promise.allSettled([
    deezer.getDeezerArtistById(101),
    deezer.getDeezerArtistById(101, { throwOnError: true }),
  ]);
  release();
  const [fallback, strict] = await results;
  assert.deepEqual(fallback, { status: "fulfilled", value: null });
  assert.equal(strict.status, "rejected");
  assert.match(strict.reason.message, /Provider unavailable/);
});

test("a strict name-search caller receives HTTP 200 provider errors", async (t) => {
  responses(t, () => ({ error: { code: 4, message: "Quota" } }));
  await assert.rejects(deezer.getDeezerArtist("Provider Artist", { throwOnError: true }));
  assert.equal(await deezer.getDeezerArtist("Provider Artist"), null);
});

test("a top-track error in HTTP 200 does not cache an empty track list", async (t) => {
  let failed = true;
  responses(t, () =>
    failed
      ? { error: { code: 4, message: "Quota" } }
      : {
          data: [
            {
              id: 7,
              title: "Recovered Song",
              album: { title: "Album" },
              preview: "https://cdn.deezer.test/7.mp3",
              duration: 180,
            },
          ],
        },
  );
  assert.deepEqual(await deezer.deezerGetArtistTopTracksById(101), []);
  failed = false;
  const tracks = await deezer.deezerGetArtistTopTracksById(101);
  assert.equal(tracks[0]?.title, "Recovered Song");
});

test("an artist's Popular list keeps the first six playable tracks in provider order", async (t) => {
  responses(t, () => ({
    status: 200,
    statusText: "OK",
    headers: {},
    data: Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      title: `Track ${index + 1}`,
      album: { title: "Album" },
      preview: index === 1 ? "" : `https://cdn.deezer.test/${index + 1}.mp3`,
      duration: 180,
    })),
  }));
  const tracks = await deezer.deezerGetArtistTopTracksById(101);
  assert.deepEqual(
    tracks.map((track: { title: string }) => track.title),
    ["Track 1", "Track 3", "Track 4", "Track 5", "Track 6", "Track 7"],
  );
});

const artistTopTracks = async () =>
  (await listenbrainzSource.getArtistTopTracks({ name: "Provider Artist" })).map(
    (track: { name: string }) => track.name,
  );

for (const [endpoint, path] of [
  ["an artist search", "/search/artist"],
  ["a top-track", "/artist/101/top"],
] as const) {
  test(endpoint + " error 4 in HTTP 200 leaves artist top tracks retryable", async (t) => {
    let failed = true;
    responses(t, (url: string) => {
      if (failed && url.endsWith(path))
        return { error: { code: 4, message: "Provider unavailable" } };
      return url.endsWith("/search/artist")
        ? { data: [{ id: 101, name: "Provider Artist" }] }
        : { data: [{ id: 7, title: "Recovered Song", album: { title: "Album" }, rank: 900 }] };
    });
    assert.deepEqual(await artistTopTracks(), []);
    failed = false;
    assert.deepEqual(await artistTopTracks(), ["Recovered Song"]);
  });
}

for (const [absence, path, body] of [
  ["an artist search with no results", "/search/artist", { data: [], total: 0 }],
  ["an artist with no top tracks", "/artist/101/top", { data: [], total: 0 }],
  ["an unknown artist ID", "/artist/101/top", missingArtist],
] as const) {
  test(absence + " is cached as having no top tracks", async (t) => {
    const requests: string[] = [];
    responses(t, (url: string) => {
      requests.push(new URL(url).pathname);
      return url.endsWith(path) ? body : { data: [{ id: 101, name: "Provider Artist" }] };
    });
    assert.deepEqual(await artistTopTracks(), []);
    assert.deepEqual(await artistTopTracks(), []);
    assert.deepEqual(requests, path === "/search/artist" ? [path] : ["/search/artist", path]);
  });
}

test("a catalog error in HTTP 200 remains retryable instead of caching an empty catalog", async (t) => {
  let failed = true;
  responses(t, () =>
    failed
      ? { error: { code: 4, message: "Quota" } }
      : {
          data: [
            { id: 9, title: "Recovered Album", record_type: "album", release_date: "2020-01-01" },
          ],
        },
  );
  await assert.rejects(deezer.getDeezerAlbumsForArtist({ id: 101 }));
  failed = false;
  assert.equal((await deezer.getDeezerAlbumsForArtist({ id: 101 }))[0]?.title, "Recovered Album");
});

for (const origin of ["relationship", "override", "name search"] as const) {
  test("a failed " + origin + " artist image remains transient until recovery", async (t) => {
    artistLinked = origin === "relationship";
    if (origin === "override") dbOps.setArtistOverride(mbid, { deezerArtistId: "101" });
    let failed = true;
    responses(t, (url: string) => {
      if (url.endsWith("/search/artist")) {
        if (failed) throw new Error("Provider unavailable");
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          data: [{ id: 101, name: "Provider Artist", picture_big: photo }],
        };
      }
      if (url.endsWith("/artist/101")) {
        if (failed) throw new Error("Provider unavailable");
        return { id: 101, name: "Provider Artist", picture_big: photo };
      }
      return { status: 200, statusText: "OK", headers: {}, data: [] };
    });
    const first = await getArtistImage(mbid, { forceRefresh: true });
    assert.equal(first.transientError, true);
    assert.notEqual(dbOps.getImage(mbid)?.imageUrl, "NOT_FOUND");
    failed = false;
    assert.equal((await getArtistImage(mbid)).url, photo);
  });
}

for (const origin of ["relationship", "override"] as const) {
  test("a missing " + origin + " artist ID allows the image absence to be cached", async (t) => {
    artistLinked = origin === "relationship";
    if (origin === "override") dbOps.setArtistOverride(mbid, { deezerArtistId: "101" });
    let requests = 0;
    responses(t, (url: unknown) => {
      assert.equal(url, "https://api.deezer.com/artist/101");
      requests++;
      return missingArtist;
    });
    assert.deepEqual(await getArtistImage(mbid, { forceRefresh: true }), {
      url: null,
      images: [],
      notFound: true,
    });
    assert.equal(dbOps.getImage(mbid)?.imageUrl, "NOT_FOUND");
    assert.equal(dbOps.getDeezerMbidCache(`artist_rg:${mbid}`), "NOT_FOUND");
    assert.deepEqual(await getArtistImage(mbid), { url: null, images: [], notFound: true });
    assert.equal(requests, 1);
  });
}
