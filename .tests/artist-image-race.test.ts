import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";
import type { CachedArtistImage } from "../backend/db/helpers/cache.ts";

const wallClockSetTimeout = globalThis.setTimeout;
const wallClockClearTimeout = globalThis.clearTimeout;

// Async gzip runs on the thread pool while the fake clock keeps ticking, which on a busy machine fires the request timeouts these tests hold open.
vi.mock("node:zlib", async (importOriginal) => {
  const zlib = await importOriginal<typeof import("node:zlib")>();
  return {
    ...zlib,
    gzip: (input: string, done: (error: null, result: Buffer) => void) =>
      done(null, zlib.gzipSync(input)),
    gunzip: (input: Buffer, done: (error: null, result: Buffer) => void) =>
      done(null, zlib.gunzipSync(input)),
  };
});

const [
  state,
  { dbOps },
  { getArtistImage },
  { default: details },
  { default: artistCover },
  { default: artistStream },
] = await setupIsolatedBackend(
  "artist-image-race",
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/imageService.ts"),
  () => import("../backend/routes/artists/handlers/details.ts"),
  () => import("../backend/routes/artists/handlers/cover.ts"),
  () => import("../backend/routes/artists/handlers/stream.ts"),
);

useFakeClock();

const originalFetch = globalThis.fetch;
const previousMetadataUrl = process.env.BRAINZMASH_BASE_URL;
process.env.BRAINZMASH_BASE_URL = "http://metadata.invalid";
const fixtures = new Map();
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const fixture = fixtures.get(`${url.hostname}${url.pathname}`);
  if (fixture) return Response.json(await fixture(url));
  if (url.hostname === "metadata.invalid" && url.pathname === "/search/artist") {
    return Response.json([]);
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/search/artist") {
    return Response.json({ data: [], total: 0 });
  }
  if (url.hostname === "musicbrainz.org" && url.pathname === "/ws/2/release") {
    return Response.json({ "release-count": 0, "release-offset": 0, releases: [] });
  }
  if (url.hostname.endsWith("listenbrainz.org")) return Response.json({ payload: {} });
  throw new Error(`Unexpected provider request: ${url}`);
};

const app = signedInAs(testUser(1, { role: "admin" }))
  .route("/", details)
  .route("/", artistCover);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (previousMetadataUrl === undefined) delete process.env.BRAINZMASH_BASE_URL;
  else process.env.BRAINZMASH_BASE_URL = previousMetadataUrl;
  await cleanupIsolatedState(state);
});

const artistId = (number: number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
const oldImage = "https://images.example/old-artist.jpg";
const newImage = "https://images.example/current-artist.jpg";
const image = (url: string) => ({ CoverType: "Artist", Url: url });

function gate() {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    started: started.promise,
    release: released.resolve,
    async wait() {
      started.resolve();
      await released.promise;
    },
  };
}

function artist(
  mbid: string,
  {
    images = [],
    albums = [],
    before = async () => {},
  }: {
    images?: { CoverType: string; Url: string }[];
    albums?: { id: string; title: string; type: string; firstreleasedate?: string }[];
    before?: () => Promise<void>;
  } = {},
) {
  fixtures.set(`metadata.invalid/artist/${mbid}`, async () => {
    await before();
    return {
      id: mbid,
      artistname: `Artist ${mbid}`,
      sortname: `Artist ${mbid}`,
      type: "Person",
      status: "Ended",
      images,
      Albums: albums,
      links: [],
      genres: [],
      artistaliases: [],
      overview: "",
    };
  });
}

async function putOverride(mbid: string, body: { musicbrainzId?: string }) {
  const response = await app.request(`/artists/${mbid}/overrides`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function cover(mbid: string) {
  const response = await app.request(`/artists/${mbid}/cover`);
  assert.equal(response.status, 200);
  return response.json();
}

async function whileOldIsBlocked<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof wallClockSetTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = wallClockSetTimeout(
          () =>
            reject(
              new assert.AssertionError({
                message: "the newer lookup must progress while the old lookup is blocked",
              }),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    wallClockClearTimeout(timer);
  }
}

for (const [index, source, lookup] of [
  [1, "direct image", getArtistImage],
  [2, "Deezer image", getArtistImage],
  [3, "album image", getArtistImage],
  [4, "not-found result", getArtistImage],
  [5, "direct image", cover],
  [6, "not-found result", cover],
] as const) {
  const endpoint = lookup === cover ? "cover endpoint" : "image service";
  test(`${endpoint} keeps the override when an old ${source} finishes last`, async () => {
    const mbid = artistId(index);
    const replacement = artistId(index + 100);
    const oldGate = gate();
    const albumId = artistId(index + 200);
    artist(mbid, {
      images: source === "direct image" ? [image(oldImage)] : [],
      albums:
        source === "album image"
          ? [{ id: albumId, title: "Old Album", type: "Album", firstreleasedate: "2020-01-01" }]
          : [],
      before: () => oldGate.wait(),
    });
    artist(replacement, { images: [image(newImage)] });
    fixtures.set(`metadata.invalid/album/${albumId}`, async () => ({
      id: albumId,
      title: "Old Album",
      images: [{ CoverType: "Cover", Url: oldImage }],
      artists: [],
      releases: [],
    }));
    if (source === "Deezer image") {
      dbOps.setArtistOverride(mbid, { deezerArtistId: "4321" });
      fixtures.set("api.deezer.com/artist/4321", async () => ({
        id: 4321,
        name: "Old Artist",
        picture: oldImage,
        picture_medium: oldImage,
        picture_big: oldImage,
      }));
    }

    const oldLookup = lookup(mbid);
    await oldGate.started;
    let latest: ReturnType<typeof lookup> | undefined;
    try {
      const saved = await putOverride(mbid, { musicbrainzId: replacement });
      assert.equal(saved.musicbrainzId, replacement);
      assert.equal(saved.deezerArtistId, null);
      latest = lookup(mbid);
      const current = await whileOldIsBlocked(latest);
      assert.equal(current.images[0]?.image, newImage);
      assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
    } finally {
      oldGate.release();
      await Promise.allSettled([oldLookup, latest]);
    }

    const oldResult = await oldLookup;
    assert.equal(
      oldResult.images[0]?.image || null,
      source === "not-found result" ? null : oldImage,
    );
    assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
    assert.equal(dbOps.getArtistOverride(mbid)?.musicbrainzId, replacement);
  });
}

test("cached album recovery cannot overwrite an image selected after an override", async () => {
  const mbid = artistId(7);
  const replacement = artistId(107);
  const albumId = artistId(207);
  const oldGate = gate();
  artist(mbid, {
    albums: [{ id: albumId, title: "Old Album", type: "Album", firstreleasedate: "2020-01-01" }],
    before: () => oldGate.wait(),
  });
  artist(replacement, { images: [image(newImage)] });
  dbOps.setImage(mbid, "NOT_FOUND");
  dbOps.setImage(`rg:${albumId}`, oldImage);
  const oldLookup = getArtistImage(mbid);
  await oldGate.started;
  let latest:
    | Promise<{
        url: string | null;
        images: CachedArtistImage[];
        notFound?: boolean;
        transientError?: boolean;
      }>
    | undefined;
  try {
    await putOverride(mbid, { musicbrainzId: replacement });
    latest = getArtistImage(mbid);
    assert.equal((await whileOldIsBlocked(latest)).url, newImage);
  } finally {
    oldGate.release();
    await Promise.allSettled([oldLookup, latest]);
  }
  assert.equal((await oldLookup).url, oldImage);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("setting an override clears a previous in-memory not-found result", async () => {
  const mbid = artistId(8);
  const replacement = artistId(108);
  artist(mbid);
  artist(replacement, { images: [image(newImage)] });
  assert.equal((await getArtistImage(mbid)).notFound, true);

  await putOverride(mbid, { musicbrainzId: replacement });

  assert.equal((await getArtistImage(mbid)).url, newImage);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("clearing an override starts a fresh lookup without changing the override response", async () => {
  const mbid = artistId(9);
  const previous = artistId(109);
  const oldGate = gate();
  artist(mbid, { images: [image(newImage)] });
  artist(previous, { images: [image(oldImage)], before: () => oldGate.wait() });
  dbOps.setArtistOverride(mbid, { musicbrainzId: previous, deezerArtistId: "9876" });
  const oldLookup = getArtistImage(mbid);
  await oldGate.started;
  let latest:
    | Promise<{
        url: string | null;
        images: CachedArtistImage[];
        notFound?: boolean;
        transientError?: boolean;
      }>
    | undefined;
  try {
    assert.deepEqual(await putOverride(mbid, {}), {
      mbid,
      musicbrainzId: null,
      deezerArtistId: null,
    });
    assert.equal(dbOps.getArtistOverride(mbid), null);
    latest = getArtistImage(mbid);
    assert.equal((await whileOldIsBlocked(latest)).url, newImage);
  } finally {
    oldGate.release();
    await Promise.allSettled([oldLookup, latest]);
  }
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("an old sibling search cannot replace a newer explicit override", async () => {
  const mbid = artistId(10);
  const replacement = artistId(110);
  const sibling = artistId(210);
  const searchGate = gate();
  artist(mbid);
  artist(replacement, { images: [image(newImage)] });
  artist(sibling, { images: [image(oldImage)] });
  fixtures.set(
    "metadata.invalid/search/artist",
    async (url: { searchParams: { get: (arg0: string) => string } }) => {
      if (url.searchParams.get("query") !== `Artist ${mbid}`) return [];
      await searchGate.wait();
      return [{ id: sibling, artistname: `Artist ${mbid}`, images: [image(oldImage)] }];
    },
  );
  const oldLookup = getArtistImage(mbid);
  await searchGate.started;
  let latest:
    | Promise<{
        url: string | null;
        images: CachedArtistImage[];
        notFound?: boolean;
        transientError?: boolean;
      }>
    | undefined;
  try {
    await putOverride(mbid, { musicbrainzId: replacement });
    latest = getArtistImage(mbid);
    assert.equal((await whileOldIsBlocked(latest)).url, newImage);
  } finally {
    searchGate.release();
    await Promise.allSettled([oldLookup, latest]);
    fixtures.delete("metadata.invalid/search/artist");
  }
  assert.equal((await oldLookup).url, oldImage);
  assert.equal(dbOps.getArtistOverride(mbid)?.musicbrainzId, replacement);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("the existing sibling fallback still saves its override and image without a concurrent edit", async () => {
  const mbid = artistId(11);
  const sibling = artistId(211);
  artist(mbid);
  artist(sibling, { images: [image(oldImage)] });
  fixtures.set("metadata.invalid/search/artist", async () => [
    { id: sibling, artistname: `Artist ${mbid}`, images: [image(oldImage)] },
  ]);
  try {
    assert.equal((await getArtistImage(mbid)).url, oldImage);
    assert.equal(dbOps.getArtistOverride(mbid)?.musicbrainzId, sibling);
    assert.equal(dbOps.getArtistOverride(mbid)?.deezerArtistId, null);
    assert.equal(dbOps.getImage(mbid)?.imageUrl, oldImage);
  } finally {
    fixtures.delete("metadata.invalid/search/artist");
  }
});

test("an old stream not-found result cannot overwrite the current image", async () => {
  const mbid = artistId(12);
  const replacement = artistId(112);
  const oldGate = gate();
  artist(mbid);
  artist(replacement, { images: [image(newImage)] });
  dbOps.setArtistOverride(mbid, { deezerArtistId: "5432" });
  fixtures.set("api.deezer.com/artist/5432", async () => {
    await oldGate.wait();
    return {
      id: 5432,
      name: "Missing Image",
      picture: null,
      picture_medium: null,
      picture_big: null,
    };
  });
  const oldStream = Promise.resolve(artistStream.request(`/artists/${mbid}/stream`)).then(
    async (response) => {
      assert.equal(response.status, 200);
      return response.text();
    },
  );
  await oldGate.started;
  let latest:
    | Promise<{
        url: string | null;
        images: CachedArtistImage[];
        notFound?: boolean;
        transientError?: boolean;
      }>
    | undefined;
  try {
    await putOverride(mbid, { musicbrainzId: replacement });
    latest = getArtistImage(mbid);
    assert.equal((await whileOldIsBlocked(latest)).url, newImage);
  } finally {
    oldGate.release();
    await Promise.allSettled([oldStream, latest]);
  }
  assert.match(await oldStream, /event: cover\ndata: \{"images":\[\]\}/);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("finishing an old lookup leaves the replacement lookup registered", async () => {
  const mbid = artistId(13);
  const replacement = artistId(113);
  const oldGate = gate();
  const newGate = gate();
  artist(mbid, { images: [image(oldImage)], before: () => oldGate.wait() });
  artist(replacement, { images: [image(newImage)], before: () => newGate.wait() });
  const oldLookup = getArtistImage(mbid);
  await oldGate.started;
  let latest:
    | Promise<{
        url: string | null;
        images: CachedArtistImage[];
        notFound?: boolean;
        transientError?: boolean;
      }>
    | undefined;
  try {
    await putOverride(mbid, { musicbrainzId: replacement });
    latest = getArtistImage(mbid);
    await whileOldIsBlocked(newGate.started);
    oldGate.release();
    assert.equal((await oldLookup).url, oldImage);
    newGate.release();
    assert.equal((await latest).url, newImage);
    assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
  } finally {
    oldGate.release();
    newGate.release();
    await Promise.allSettled([oldLookup, latest]);
  }
});

for (const [index, recoveredUrl, finishRecoveryFirst] of [
  [14, oldImage, false],
  [15, null, false],
  [16, oldImage, true],
  [17, null, true],
] as const) {
  const recoveryResult = recoveredUrl ? "a cached cover" : "no cached cover";
  const order = finishRecoveryFirst ? "first" : "last";
  test(`forced refresh supersedes negative-cache recovery returning ${recoveryResult} ${order}`, async () => {
    const mbid = artistId(index);
    const albumId = artistId(requireFixture(index) + 200);
    const deezerArtistId = String(6000 + requireFixture(index));
    const recoveryGate = gate();
    const providerGate = gate();
    let providerRequests = 0;
    artist(mbid, { albums: [{ id: albumId, title: "Old Album", type: "Album" }] });
    fixtures.set(`metadata.invalid/album/${albumId}`, async () => {
      await recoveryGate.wait();
      return { id: albumId, title: "Old Album", images: [], artists: [], releases: [] };
    });
    fixtures.set(`api.deezer.com/artist/${deezerArtistId}`, async () => {
      providerRequests += 1;
      await providerGate.wait();
      return {
        id: Number(deezerArtistId),
        name: "Current Artist",
        picture: newImage,
        picture_medium: newImage,
        picture_big: newImage,
      };
    });
    dbOps.setArtistOverride(mbid, { deezerArtistId });
    dbOps.setImage(mbid, "NOT_FOUND");
    if (recoveredUrl) dbOps.setImage(`rg:${albumId}`, recoveredUrl);

    const recovery = getArtistImage(mbid);
    await recoveryGate.started;
    const refreshed = getArtistImage(mbid, { forceRefresh: true });
    const repeatedRefresh = getArtistImage(mbid, true);
    let laterRefresh:
      | Promise<{
          url: string | null;
          images: CachedArtistImage[];
          notFound?: boolean;
          transientError?: boolean;
        }>
      | undefined;
    let normalLookup:
      | Promise<{
          url: string | null;
          images: CachedArtistImage[];
          notFound?: boolean;
          transientError?: boolean;
        }>
      | undefined;
    try {
      await whileOldIsBlocked(providerGate.started);
      if (finishRecoveryFirst) {
        recoveryGate.release();
        await recovery;
        assert.equal(dbOps.getImage(mbid)?.imageUrl, "NOT_FOUND");
        laterRefresh = getArtistImage(mbid, { forceRefresh: true });
        normalLookup = getArtistImage(mbid);
      }

      providerGate.release();
      const current = await refreshed;
      assert.equal(current.url, newImage);
      assert.equal(await repeatedRefresh, current);
      if (finishRecoveryFirst) {
        assert.equal(await laterRefresh, current);
        assert.equal(await normalLookup, current);
      }
      assert.equal(providerRequests, 1);
      assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
    } finally {
      recoveryGate.release();
      providerGate.release();
      await Promise.allSettled([recovery, refreshed, repeatedRefresh, laterRefresh, normalLookup]);
    }

    const original = await recovery;
    assert.equal(original.url, recoveredUrl);
    assert.equal(!!original.notFound, !recoveredUrl);
    assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
  });
}

test("every concurrent lookup saves its result however many are pending", async () => {
  const shared = artistId(118);
  const sharedGate = gate();
  artist(shared, { images: [image(newImage)], before: () => sharedGate.wait() });
  const mbids = Array.from({ length: 150 }, (_, index) => artistId(300 + index));
  for (const mbid of mbids) dbOps.setArtistOverride(mbid, { musicbrainzId: shared });

  const lookups = mbids.map((mbid) => getArtistImage(mbid));
  try {
    await sharedGate.started;
  } finally {
    sharedGate.release();
  }

  for (const result of await Promise.all(lookups)) assert.equal(result.url, newImage);
  assert.deepEqual(
    mbids.filter((mbid) => dbOps.getImage(mbid)?.imageUrl !== newImage),
    [],
  );
});

test("a forced refresh searches albums that a pending lookup skips", async () => {
  const mbid = artistId(19);
  const albumId = artistId(219);
  const lookupGate = gate();
  artist(mbid, {
    albums: [
      { id: albumId, title: "Current Album", type: "Album", firstreleasedate: "2020-01-01" },
    ],
    before: () => lookupGate.wait(),
  });
  fixtures.set(`metadata.invalid/album/${albumId}`, async () => ({
    id: albumId,
    title: "Current Album",
    images: [{ CoverType: "Cover", Url: newImage }],
    artists: [],
    releases: [],
  }));
  dbOps.setDeezerMbidCache(`artist_rg:${mbid}`, "NOT_FOUND");

  const lookup = getArtistImage(mbid);
  await lookupGate.started;
  const refreshed = getArtistImage(mbid, { forceRefresh: true });
  lookupGate.release();

  assert.equal((await refreshed).url, newImage);
  assert.equal((await lookup).notFound, true);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});
