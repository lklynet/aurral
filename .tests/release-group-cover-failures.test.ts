import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import { testClient } from "hono/testing";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";
import { requireFixture } from "./playlists/fixtures.ts";
import { stubFetch } from "./helpers/stubFetch.ts";
import { http } from "../lib/http.ts";

const mbid = "11111111-1111-4111-8111-111111111111";
const missingMbid = "22222222-2222-4222-8222-222222222222";
const replies = new Map<string, { status: number; body: unknown }>();
const deezerReplies = new Map<string, { data: unknown[] }>();
const requests: string[] = [];
const providerServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  requests.push(pathname);
  const reply = replies.get(pathname);
  response.statusCode = reply?.status ?? 404;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(reply?.body ?? {}));
});
process.env.BRAINZMASH_BASE_URL = providerServer.url;

const [
  isolatedState,
  { dbOps },
  { clearMetadataProviderCaches },
  { fetchReleaseGroupCoverUrl, withCoverUrls },
  { buildStableImageProxyUrl },
  { default: releaseGroupRoutes },
] = await setupIsolatedBackend(
  "release-group-cover-failures",
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/providers/brainzmashProvider.ts"),
  () => import("../backend/services/releaseGroupCoverService.ts"),
  () => import("../backend/services/imageProxyService.ts"),
  () => import("../backend/routes/artists/handlers/releaseGroup.ts"),
);

beforeEach(() => {
  const get = http.get.bind(http);
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (!url.startsWith("https://api.deezer.com/")) return get(url, options);
    const page = deezerReplies.get(new URL(url).pathname)?.data ?? [];
    const data = { data: page.slice(0, Number(options?.query?.limit) || 25) };
    return { status: 200, statusText: "OK", headers: {}, data };
  });
  clearMetadataProviderCaches();
  dbOps.deleteImage(`rg:${mbid}`);
  replies.clear();
  deezerReplies.clear();
  requests.length = 0;
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
  await providerServer.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

test("a cover two callers want at once is asked for once and saved", async () => {
  const cover = "https://images.example/shared.jpg";
  replies.set(`/album/${mbid}`, {
    status: 200,
    body: { id: mbid, images: [{ CoverType: "Cover", Url: cover }] },
  });

  const [result, sameTime] = await Promise.all([
    fetchReleaseGroupCoverUrl(mbid),
    fetchReleaseGroupCoverUrl(mbid),
  ]);

  assert.equal(result.imageUrl, buildStableImageProxyUrl(cover));
  assert.deepEqual(sameTime, result);
  assert.deepEqual(requests, [`/album/${mbid}`]);
  assert.equal(dbOps.getImage(`rg:${mbid}`)?.imageUrl, buildStableImageProxyUrl(cover));
});

test("failed cover metadata requests log the MBID once and remain retryable", async () => {
  replies.set(`/album/${mbid}`, { status: 503, body: {} });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await fetchReleaseGroupCoverUrl(mbid);

  assert.equal(result.imageUrl, null);
  assert.equal(result.notFound, false);
  assert.equal(result.transientError, true);
  assert.equal(dbOps.getImage(`rg:${mbid}`), null);
  assert.equal(warnings.mock.calls.length, 1);
  assert.match(String(requireFixture(warnings.mock.calls[0])[1]), /cover metadata lookup failed/);
  assert.deepEqual(warnings.mock.calls[0]?.[2], {
    releaseGroupMbid: mbid,
    reason: `Request to ${new URL(providerServer.url).host} failed with status code 503`,
  });

  const retried = await fetchReleaseGroupCoverUrl(mbid);

  assert.deepEqual(requests, [`/album/${mbid}`]);
  assert.equal(retried.transientError, true);
  assert.equal(warnings.mock.calls.length, 1);
  assert.equal(dbOps.getImage(`rg:${mbid}`), null);
});

test("confirmed missing metadata is cached as missing artwork without a warning", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await fetchReleaseGroupCoverUrl(mbid);
  await fetchReleaseGroupCoverUrl(mbid);

  assert.equal(result.notFound, true);
  assert.equal(result.transientError, false);
  assert.equal(dbOps.getImage(`rg:${mbid}`)?.imageUrl, "NOT_FOUND");
  assert.deepEqual(requests, [`/album/${mbid}`]);
  assert.equal(warnings.mock.calls.length, 0);
});

test("an album BrainzMash has no cover for takes Deezer's, however long the discography, without asking BrainzMash again", async () => {
  replies.set(`/album/${mbid}`, {
    status: 200,
    body: { id: mbid, images: [{ CoverType: "Disc", Url: "https://images.example/disc.png" }] },
  });
  const cover = "https://images.example/deezer.jpg";
  deezerReplies.set("/search/artist", { data: [{ id: 7, name: "Cover Artist" }] });
  deezerReplies.set("/artist/7/albums", {
    data: [
      ...Array.from({ length: 120 }, (_, index) => ({
        id: 100 + index,
        title: `Earlier ${index}`,
        record_type: "album",
      })),
      { id: 9, title: "Covered", record_type: "album", cover_xl: cover },
    ],
  });

  const result = await fetchReleaseGroupCoverUrl(mbid, {
    artistName: "Cover Artist",
    albumTitle: "Covered",
  });

  assert.equal(result.imageUrl, cover);
  assert.deepEqual(requests, [`/album/${mbid}`]);
  assert.equal(dbOps.getImage(`rg:${mbid}`), null);
});

test("a refresh swaps a cover link that no longer loads for Deezer's on the album page too, and keeps it when Deezer has none", async (t) => {
  const dead = "https://images.example/dead.jpg";
  const cover = "https://images.example/deezer-swap.jpg";
  replies.set(`/album/${mbid}`, {
    status: 200,
    body: { id: mbid, images: [{ CoverType: "Cover", Url: dead }] },
  });
  deezerReplies.set("/search/artist", { data: [{ id: 8, name: "Swap Artist" }] });
  deezerReplies.set("/artist/8/albums", {
    data: [{ id: 10, title: "Swapped", record_type: "album", cover_xl: cover }],
  });
  const realFetch = globalThis.fetch;
  stubFetch(t, (url, init) =>
    url.href === dead ? new Response(null, { status: 404 }) : realFetch(url, init),
  );
  await fetchReleaseGroupCoverUrl(mbid);

  const unmatched = await fetchReleaseGroupCoverUrl(mbid, {
    artistName: "Swap Artist",
    albumTitle: "Something Else",
    bypassCache: true,
  });
  assert.equal(unmatched.imageUrl, dead);

  const swapped = await fetchReleaseGroupCoverUrl(mbid, {
    artistName: "Swap Artist",
    albumTitle: "Swapped",
    bypassCache: true,
  });
  assert.equal(swapped.imageUrl, cover);
  assert.equal(dbOps.getImage(`rg:${mbid}`)?.imageUrl, cover);
  assert.equal((await fetchReleaseGroupCoverUrl(mbid)).imageUrl, cover);
  const details = await testClient(releaseGroupRoutes).artists["release-group"][":mbid"].$get({
    param: { mbid },
  });
  const album = await details.json();
  assert.equal("coverUrl" in album && album.coverUrl, cover);
});

test("every release group carries a cover URL that needs no metadata lookup", () => {
  const cachedImage = "https://coverartarchive.org/release-group/cached/front-500.jpg";
  dbOps.setImage(`rg:${mbid}`, cachedImage);
  dbOps.setImage(`rg:${missingMbid}`, "NOT_FOUND");
  const unknownMbid = "33333333-3333-4333-8333-333333333333";
  const providerCover = "https://images.example/provider.jpg";

  const covered = withCoverUrls([
    { id: mbid },
    { id: missingMbid },
    { id: unknownMbid },
    { id: "44444444-4444-4444-8444-444444444444", coverUrl: providerCover },
    { id: null },
  ]);

  assert.deepEqual(
    covered.map(({ coverUrl }) => coverUrl),
    [
      buildStableImageProxyUrl(cachedImage),
      null,
      `/api/artists/release-group/${unknownMbid}/cover/image`,
      providerCover,
      null,
    ],
  );
  assert.deepEqual(requests, []);
});
