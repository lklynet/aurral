import { test, beforeAll, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import type { hc, InferRequestType, InferResponseType } from "hono/client";
import type discoveryApp from "../../backend/routes/discovery/index.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { dbOps, userOps }, discovery, { getUserDiscovery }, { api }] =
  await setupIsolatedBackend(
    "spotify-import",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/discovery/index.ts"),
    () => import("../../backend/services/discovery/userDiscovery.ts"),
    () => import("../../backend/routes/api.ts"),
  );

type ImportRoute = ReturnType<typeof hc<typeof discoveryApp>>["discover"]["spotify-import"];
type ImportBody = InferRequestType<ImportRoute["$put"]>["json"];
type Summary = InferResponseType<ImportRoute["$get"], 200>["summary"];

const originalFetch = globalThis.fetch;
let userId = 0;

beforeAll(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const user = userOps.createUser("alice", "hash");
  assert.ok(user);
  userId = user.id;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
});

afterAll(async () => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  await cleanupIsolatedState(state);
});

const request = async (method: "GET" | "PUT" | "DELETE", body?: ImportBody) => {
  const response = await signedInAs(testUser(userId))
    .route("/", api)
    .request("/discover/spotify-import", {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
  assert.equal(response.status, 200);
  const json: { summary: Summary } = await response.json();
  return json.summary;
};

const seedNames = async () => {
  await discovery.updateUserDiscoveryCache(userId);
  return (await getUserDiscovery(userId, 0)).body.basedOn.map((seed) => [seed.name, seed.source]);
};

test("an imported Spotify history seeds discovery until it is removed", async () => {
  const artist = {
    plays: 40,
    likedTracks: 2,
    followed: false,
    firstPlayedAt: 1_600_000_000_000,
    lastPlayedAt: 1_700_000_000_000,
  };
  const summary = await request("PUT", {
    artists: [
      { ...artist, name: "Alvvays", score: 30 },
      { ...artist, name: "Slowdive", score: 10, followed: true, lastPlayedAt: null },
    ],
  });
  assert.deepEqual(summary && { ...summary, importedAt: typeof summary.importedAt }, {
    artists: 2,
    plays: 80,
    likedTracks: 4,
    followedArtists: 1,
    firstPlayedAt: artist.firstPlayedAt,
    lastPlayedAt: artist.lastPlayedAt,
    importedAt: "number",
  });
  assert.deepEqual(await request("GET"), summary);
  assert.deepEqual(await seedNames(), [
    ["Alvvays", "spotify"],
    ["Slowdive", "spotify"],
  ]);

  await request("PUT", { artists: [{ ...artist, name: "Beach House", score: 5 }] });
  assert.equal((await request("GET"))?.artists, 1);

  assert.equal(await request("DELETE"), null);
  assert.equal(await request("GET"), null);
  assert.deepEqual(await seedNames(), []);
});
