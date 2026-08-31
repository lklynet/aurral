import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const mbid = "11111111-1111-4111-8111-111111111111";
const coldMbid = "22222222-2222-4222-8222-222222222222";
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

test("release-group refresh replaces a stale cached link", async () => {
  dbOps.setImage(`rg:${coldMbid}`, "https://images.example/dead-cover.jpg");

  const result = await fetchReleaseGroupCoverUrl(coldMbid, { bypassCache: true });

  assert.equal(providerRequests, 2);
  assert.equal(result.imageUrl, "https://images.example/cold-artist.jpg");
  assert.equal(dbOps.getImage(`rg:${coldMbid}`)?.imageUrl, result.imageUrl);
});
