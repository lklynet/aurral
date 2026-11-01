import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }, { api }, discovery, { getUserDiscovery }] =
  await setupIsolatedBackend(
    "listening-history",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/discovery/index.ts"),
    () => import("../../backend/services/discovery/userDiscovery.ts"),
  );

let userId = 0;
const app = signedInAs(() => ({
  id: userId,
  username: "alice",
  role: "user",
  permissions: {},
})).route("/", api);

const patchHistory = async (json: unknown) => {
  const response = await app.request("/users/me/listening-history", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  return { status: response.status, body: await response.json() };
};

const originalFetch = globalThis.fetch;
const originalLastfmApiKey = process.env.LASTFM_API_KEY;

beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  const user = userOps.createUser("alice", "hash");
  assert.ok(user);
  userId = user.id;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("a user keeps a history source for each service and can clear one", async () => {
  const saved = await patchHistory({
    lastfm: " listener ",
    listenbrainz: "brainz-listener",
    koito: "http://koito.local:4110/apis/listenbrainz/",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, {
    lastfm: "listener",
    listenbrainz: "brainz-listener",
    koito: "http://koito.local:4110",
  });

  const cleared = await patchHistory({ listenbrainz: "" });
  assert.deepEqual(cleared.body, {
    lastfm: "listener",
    listenbrainz: null,
    koito: "http://koito.local:4110",
  });

  const response = await app.request("/users/me/listening-history");
  assert.deepEqual(await response.json(), cleared.body);
});

test("an invalid Koito URL is rejected without touching other sources", async () => {
  await patchHistory({ lastfm: "listener" });

  const rejected = await patchHistory({ lastfm: "someone-else", koito: "ftp://koito.local" });

  assert.equal(rejected.status, 400);
  const response = await app.request("/users/me/listening-history");
  assert.deepEqual(await response.json(), { lastfm: "listener", listenbrainz: null, koito: null });
});

test("discovery builds from every history source", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  const similarMbids = new Map([
    ["From Lastfm", "00000000-0000-4000-8000-000000000001"],
    ["From Brainz", "00000000-0000-4000-8000-000000000002"],
  ]);
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    const method = target.searchParams.get("method");
    const artist = target.searchParams.get("artist") ?? "";
    const body = target.pathname.includes("/stats/user/brainz-listener/artists")
      ? { payload: { artists: [{ artist_name: "From Brainz", listen_count: 40 }] } }
      : method === "user.getTopArtists"
        ? { topartists: { artist: [{ name: "From Lastfm", playcount: "50" }] } }
        : method === "artist.getSimilar"
          ? {
              similarartists: {
                artist: [{ name: `Like ${artist}`, mbid: similarMbids.get(artist), match: "0.9" }],
              },
            }
          : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await patchHistory({ lastfm: "listener", listenbrainz: "brainz-listener" });

  await discovery.updateUserDiscoveryCache(userId);

  const { body } = getUserDiscovery(userId, 0);
  assert.deepEqual(body.recommendations.map((artist) => artist.name).sort(), [
    "Like From Brainz",
    "Like From Lastfm",
  ]);
});
