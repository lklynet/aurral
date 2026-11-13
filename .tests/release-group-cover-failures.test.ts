import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";
import { requireFixture } from "./playlists/fixtures.ts";
import { http, type HttpResponse } from "../lib/http.ts";

const mbid = "11111111-1111-4111-8111-111111111111";
const fallbackMbid = "22222222-2222-4222-8222-222222222222";
const replies = new Map<string, { status: number; body: unknown }>();
const requests: string[] = [];
const noArchiveCover: HttpResponse = { status: 404, statusText: "", headers: {}, data: null };
let archiveCover = noArchiveCover;
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
] = await setupIsolatedBackend(
  "release-group-cover-failures",
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/providers/brainzmashProvider.ts"),
  () => import("../backend/services/releaseGroupCoverService.ts"),
  () => import("../backend/services/imageProxyService.ts"),
);

beforeEach(() => {
  archiveCover = noArchiveCover;
  const get = http.get.bind(http);
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (url.startsWith("https://musicbrainz.org/")) throw new Error("MusicBrainz is unavailable");
    return url.startsWith("https://coverartarchive.org/") ? archiveCover : get(url, options);
  });
  clearMetadataProviderCaches();
  dbOps.deleteImage(`rg:${mbid}`);
  replies.clear();
  requests.length = 0;
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
  await providerServer.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

test("a cover the Cover Art Archive has is saved without asking BrainzMash", async () => {
  const release = "33333333-3333-4333-8333-333333333333";
  archiveCover = {
    ...noArchiveCover,
    status: 307,
    headers: {
      location: `https://archive.org/download/mbid-${release}/mbid-${release}-40449613518.jpg`,
    },
  };

  const result = await fetchReleaseGroupCoverUrl(mbid);

  const cover = `https://imagecache.lidarr.audio/v1/caa/${release}/40449613518-1200.jpg`;
  assert.equal(result.imageUrl, buildStableImageProxyUrl(cover));
  assert.equal(dbOps.getImage(`rg:${mbid}`)?.imageUrl, buildStableImageProxyUrl(cover));
  assert.deepEqual(requests, []);
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

test("an unavailable artist/title search logs its context without caching missing artwork", async () => {
  replies.set(`/album/${mbid}`, { status: 200, body: { id: mbid, images: [] } });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await fetchReleaseGroupCoverUrl(mbid, { albumTitle: "Missing Album" });

  assert.equal(result.notFound, false);
  assert.equal(result.transientError, true);
  assert.equal(dbOps.getImage(`rg:${mbid}`), null);
  assert.equal(warnings.mock.calls.length, 1);
  assert.match(
    String(requireFixture(warnings.mock.calls[0])[1]),
    /cover artist\/title lookup failed/,
  );
  assert.deepEqual(warnings.mock.calls[0]?.[2], {
    releaseGroupMbid: mbid,
    artistName: "",
    albumTitle: "Missing Album",
    reason: "MusicBrainz is unavailable",
  });
});

test("a failed metadata lookup still allows the artist/title fallback to return a cover", async () => {
  replies.set(`/album/${mbid}`, { status: 503, body: {} });
  const album = {
    id: fallbackMbid,
    title: "Fallback Album",
    images: [{ CoverType: "Cover", Url: "https://images.example/fallback.jpg" }],
  };
  replies.set("/search/album", { status: 200, body: [album] });
  replies.set(`/album/${fallbackMbid}`, { status: 200, body: album });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await fetchReleaseGroupCoverUrl(mbid, { albumTitle: album.title });

  assert.equal(result.imageUrl, requireFixture(album.images[0]).Url);
  assert.equal(result.notFound, false);
  assert.equal(result.transientError, false);
  assert.equal(dbOps.getImage(`rg:${mbid}`), null);
  assert.equal(warnings.mock.calls.length, 1);
});

test("every release group carries a cover URL that needs no metadata lookup", () => {
  const cachedImage = "https://coverartarchive.org/release-group/cached/front-500.jpg";
  dbOps.setImage(`rg:${mbid}`, cachedImage);
  dbOps.setImage(`rg:${fallbackMbid}`, "NOT_FOUND");
  const unknownMbid = "33333333-3333-4333-8333-333333333333";
  const providerCover = "https://images.example/provider.jpg";

  const covered = withCoverUrls([
    { id: mbid },
    { id: fallbackMbid },
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
