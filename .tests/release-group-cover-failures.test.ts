import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";
import { requireFixture } from "./playlists/fixtures.ts";

const mbid = "11111111-1111-4111-8111-111111111111";
const fallbackMbid = "22222222-2222-4222-8222-222222222222";
const replies = new Map<string, { status: number; body: unknown }>();
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

const [isolatedState, { dbOps }, { clearMetadataProviderCaches }, { fetchReleaseGroupCoverUrl }] =
  await setupIsolatedBackend(
    "release-group-cover-failures",
    () => import("../backend/db/helpers/index.ts"),
    () => import("../backend/services/providers/brainzmashProvider.ts"),
    () => import("../backend/services/releaseGroupCoverService.ts"),
  );

dbOps.updateSettings({
  integrations: {
    ...dbOps.getSettings().integrations,
    metadata: { enableNarrowFallbacks: false },
  },
});

beforeEach(() => {
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

test("failed cover metadata requests log the MBID and remain retryable", async () => {
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

  await fetchReleaseGroupCoverUrl(mbid);

  assert.deepEqual(requests, [`/album/${mbid}`]);
  assert.match(JSON.stringify(warnings.mock.calls[1]), /cooling down/);
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
    reason: `Request to ${new URL(providerServer.url).host} failed with status code 404`,
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
