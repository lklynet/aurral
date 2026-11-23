import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";
import type { CachedArtistImage } from "../backend/db/helpers/cache.ts";

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

const [state, { dbOps }, { getArtistImage }, { default: details }, { default: artistCover }] =
  await setupIsolatedBackend(
    "artist-image-race",
    () => import("../backend/db/helpers/index.ts"),
    () => import("../backend/services/imageService.ts"),
    () => import("../backend/routes/artists/handlers/details.ts"),
    () => import("../backend/routes/artists/handlers/cover.ts"),
  );

useFakeClock();

const originalFetch = globalThis.fetch;
const previousMetadataUrl = process.env.METADATA_BASE_URL;
process.env.METADATA_BASE_URL = "http://metadata.invalid";
const fixtures = new Map();
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const fixture = fixtures.get(`${url.hostname}${url.pathname}`);
  if (fixture) return Response.json(await fixture(url));
  if (url.hostname === "metadata.invalid" && url.pathname === "/v1/search/artist") {
    return Response.json({ artists: [] });
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
  if (previousMetadataUrl === undefined) delete process.env.METADATA_BASE_URL;
  else process.env.METADATA_BASE_URL = previousMetadataUrl;
  await cleanupIsolatedState(state);
});

const artistId = (number: number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
const oldImage = "https://images.example/old-artist.jpg";
const newImage = "https://images.example/current-artist.jpg";
const image = (url: string) => ({ kind: "Artist", url });

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
    images?: { kind: string; url: string }[];
    albums?: { id: string; title: string; type: string; cover?: string | null }[];
    before?: () => Promise<void>;
  } = {},
) {
  fixtures.set(`metadata.invalid/v1/artist/${mbid}`, async () => {
    await before();
    return {
      id: mbid,
      name: `Artist ${mbid}`,
      sortName: `Artist ${mbid}`,
      type: "Person",
      status: "Ended",
      images,
      albums,
      links: [],
      genres: [],
      aliases: [],
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
  const response = await testClient(app).artists[":mbid"].cover.$get({
    param: { mbid },
    query: {},
  });
  assert.equal(response.status, 200);
  return response.json();
}

for (const [index, source, lookup] of [
  [1, "direct image", getArtistImage],
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
          ? [{ id: albumId, title: "Old Album", type: "Album", cover: oldImage }]
          : [],
      before: () => oldGate.wait(),
    });
    artist(replacement, { images: [image(newImage)] });

    const oldLookup = lookup(mbid);
    await oldGate.started;
    let latest: ReturnType<typeof lookup> | undefined;
    try {
      const saved = await putOverride(mbid, { musicbrainzId: replacement });
      assert.equal(saved.musicbrainzId, replacement);
      assert.equal(saved.deezerArtistId, null);
      latest = lookup(mbid);
      const current = await latest;
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
    assert.equal((await latest).url, newImage);
  } finally {
    oldGate.release();
    await Promise.allSettled([oldLookup, latest]);
  }
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

test("an artist without an image never takes a namesake's image or page", async () => {
  const mbid = artistId(11);
  const namesake = artistId(211);
  artist(mbid);
  artist(namesake, { images: [image(oldImage)] });
  fixtures.set("metadata.invalid/v1/search/artist", async () => ({
    artists: [{ id: namesake, name: `Artist ${mbid}`, image: oldImage }],
  }));
  try {
    assert.equal((await getArtistImage(mbid)).url, null);
    assert.equal(dbOps.getArtistOverride(mbid), null);
  } finally {
    fixtures.delete("metadata.invalid/v1/search/artist");
  }
});

test("an old cover not-found result cannot overwrite the current image", async () => {
  const mbid = artistId(12);
  const replacement = artistId(112);
  const oldGate = gate();
  artist(mbid, { before: () => oldGate.wait() });
  artist(replacement, { images: [image(newImage)] });
  const oldCover = cover(mbid);
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
    assert.equal((await latest).url, newImage);
  } finally {
    oldGate.release();
    await Promise.allSettled([oldCover, latest]);
  }
  assert.deepEqual((await oldCover).images, []);
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
    await newGate.started;
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

test("a forced refresh looks again after a not-found result, and lookups share its request", async () => {
  const mbid = artistId(14);
  const providerGate = gate();
  let providerRequests = 0;
  artist(mbid, {
    images: [image(newImage)],
    before: async () => {
      providerRequests += 1;
      await providerGate.wait();
    },
  });
  dbOps.setImage(mbid, "NOT_FOUND");
  assert.equal((await getArtistImage(mbid)).notFound, true);
  assert.equal(providerRequests, 0);

  const lookups = [getArtistImage(mbid, { forceRefresh: true })];
  try {
    await providerGate.started;
    lookups.push(getArtistImage(mbid, { forceRefresh: true }), getArtistImage(mbid));
  } finally {
    providerGate.release();
  }

  for (const result of await Promise.all(lookups)) assert.equal(result.url, newImage);
  assert.equal(providerRequests, 1);
  assert.equal(dbOps.getImage(mbid)?.imageUrl, newImage);
});

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
