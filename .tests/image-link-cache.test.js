import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const mbid = "11111111-1111-4111-8111-111111111111";
const coldMbid = "22222222-2222-4222-8222-222222222222";
const fallbackRequestedMbid = "66666666-6666-4666-8666-666666666666";
const fallbackResolvedMbid = "77777777-7777-4777-8777-777777777777";
const coalescedMbid = "88888888-8888-4888-8888-888888888888";
const canonicalCoverMbid = "99999999-9999-4999-8999-999999999999";
const staleLocalUrl = `/api/image-proxy/${"a".repeat(64)}.webp`;
const imageLinks = [
  {
    image: "https://images.example/artist.jpg",
    front: true,
    types: ["Artist"],
  },
  {
    image: "https://images.example/artist-banner.jpg",
    front: false,
    types: ["Banner"],
  },
];

let providerRequests = 0;
const providerServer = await createMockHttpServer((request, response) => {
  providerRequests += 1;
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith("/search/album")) {
    response.end(
      JSON.stringify([
        {
          id: fallbackResolvedMbid,
          title: "Fallback Album",
          artists: [{ id: "fallback-artist", name: "Fallback Artist" }],
        },
      ]),
    );
    return;
  }
  if (request.url?.includes(`/album/${fallbackRequestedMbid}`)) {
    response.end(
      JSON.stringify({
        id: fallbackRequestedMbid,
        title: "Requested Album",
        images: [],
      }),
    );
    return;
  }
  if (request.url?.includes(`/album/${fallbackResolvedMbid}`)) {
    response.end(
      JSON.stringify({
        id: fallbackResolvedMbid,
        title: "Fallback Album",
        images: [{ CoverType: "Cover", Url: "https://images.example/fallback.jpg" }],
      }),
    );
    return;
  }
  if (request.url?.includes(`/album/${coalescedMbid}`)) {
    response.end(
      JSON.stringify({
        id: coalescedMbid,
        title: "Coalesced Album",
        images: [{ CoverType: "Cover", Url: "https://images.example/coalesced.jpg" }],
      }),
    );
    return;
  }
  response.end(
    JSON.stringify({
      id: coldMbid,
      name: "Cold Artist",
      images: request.url?.includes(coldMbid)
        ? [
            { CoverType: "Artist", Url: "https://images.example/cold-artist.jpg" },
            { CoverType: "Banner", Url: "https://images.example/cold-artist-banner.jpg" },
          ]
        : [],
    }),
  );
});
process.env.BRAINZMASH_BASE_URL = providerServer.url;

const [isolatedState, { dbOps }, { getArtistImage }, { fetchReleaseGroupCoverUrl }] =
  await setupIsolatedBackend(
    "image-link-cache",
    "backend/db/helpers/index.js",
    "backend/services/imageService.js",
    "backend/services/releaseGroupCoverService.js",
  );

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
  await providerServer.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

test("cached artist image links survive byte-cache eviction without metadata requests", async () => {
  dbOps.setImage(mbid, staleLocalUrl, imageLinks);

  const result = await getArtistImage(mbid);

  assert.equal(providerRequests, 0);
  assert.equal(result.url, imageLinks[0].image);
  assert.deepEqual(result.images, imageLinks);
  assert.deepEqual(dbOps.getImages([mbid])[mbid]?.images, imageLinks);
});

test("fresh artist metadata persists every image link", async () => {
  const result = await getArtistImage(coldMbid);

  assert.equal(providerRequests, 1);
  assert.deepEqual(
    result.images.map(({ image, front, types }) => ({ image, front, types })),
    [
      {
        image: "https://images.example/cold-artist.jpg",
        front: true,
        types: ["Artist"],
      },
      {
        image: "https://images.example/cold-artist-banner.jpg",
        front: false,
        types: ["Banner"],
      },
    ],
  );
  assert.deepEqual(dbOps.getImage(coldMbid)?.images, result.images);
});

test("cached release-group links survive byte-cache eviction without metadata requests", async () => {
  const releaseGroupMbid = "33333333-3333-4333-8333-333333333333";
  dbOps.setImage(`rg:${releaseGroupMbid}`, staleLocalUrl);

  const result = await fetchReleaseGroupCoverUrl(releaseGroupMbid);

  assert.equal(providerRequests, 1);
  assert.equal(result.imageUrl, staleLocalUrl);
});

test("canonical Cover Art Archive links stay cached without metadata requests", async () => {
  const imageUrl = `https://coverartarchive.org/release-group/${canonicalCoverMbid}/front`;
  dbOps.setImage(`rg:${canonicalCoverMbid}`, imageUrl);
  const requestsBefore = providerRequests;

  const result = await fetchReleaseGroupCoverUrl(canonicalCoverMbid);

  assert.equal(providerRequests, requestsBefore);
  assert.equal(result.imageUrl, imageUrl);
});

test("release-group refresh replaces a stale cached link", async () => {
  dbOps.setImage(`rg:${coldMbid}`, "https://images.example/dead-cover.jpg");

  const result = await fetchReleaseGroupCoverUrl(coldMbid, { bypassCache: true });

  assert.equal(providerRequests, 2);
  assert.equal(result.imageUrl, "https://images.example/cold-artist.jpg");
  assert.equal(dbOps.getImage(`rg:${coldMbid}`)?.imageUrl, result.imageUrl);
});

test("release-group fallback links are not stored under the requested MBID", async () => {
  const result = await fetchReleaseGroupCoverUrl(fallbackRequestedMbid, {
    artistName: "Fallback Artist",
    albumTitle: "Fallback Album",
    bypassCache: true,
  });

  assert.equal(result.imageUrl, "https://images.example/fallback.jpg");
  assert.equal(dbOps.getImage(`rg:${fallbackRequestedMbid}`), null);
});

test("release-group refreshes coalesce per MBID", async () => {
  const originalSetImage = dbOps.setImage;
  let writes = 0;
  dbOps.setImage = (...args) => {
    writes += 1;
    return originalSetImage(...args);
  };
  try {
    const results = await Promise.all([
      fetchReleaseGroupCoverUrl(coalescedMbid, { bypassCache: true }),
      fetchReleaseGroupCoverUrl(coalescedMbid, { bypassCache: true }),
    ]);
    assert.equal(results[0].imageUrl, "https://images.example/coalesced.jpg");
    assert.equal(results[1].imageUrl, results[0].imageUrl);
    assert.equal(writes, 1);
  } finally {
    dbOps.setImage = originalSetImage;
  }
});
