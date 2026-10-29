import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import type { hc, InferResponseType } from "hono/client";
import type discoveryApp from "../../backend/routes/discovery/index.ts";
import { playlistTrack } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { dbOps }, persistedDiscovery, { FlowTrackSource }, { api }] =
  await setupIsolatedBackend(
    "genre-blocklist",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/discovery/persistence.ts"),
    () => import("../../backend/services/flows/flowTrackSource.ts"),
    () => import("../../backend/routes/api.ts"),
  );

type DiscoverRoutes = ReturnType<typeof hc<typeof discoveryApp>>["discover"];
type DiscoverBody = InferResponseType<DiscoverRoutes["$get"], 200>;
type BlockedTags = InferResponseType<DiscoverRoutes["blocked-tags"]["$get"], 200>;

beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
afterAll(() => cleanupIsolatedState(state));

const appFor = (userId: number) => signedInAs(testUser(userId)).route("/", api);

const postBlock = (userId: number, tag: string) =>
  appFor(userId).request("/discover/blocked-tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag }),
  });

const blockGenre = async (userId: number, tag: string) => {
  const body: BlockedTags = await (await postBlock(userId, tag)).json();
  return body.tags;
};

const discover = async (userId: number) => {
  const body: DiscoverBody = await (await appFor(userId).request("/discover")).json();
  return body;
};

test("a blocked genre hides its picks and genre rows for that user until unblocked", async () => {
  dbOps.updateDiscoveryCache({
    recommendations: [
      { name: "Kept", tags: ["shoegaze"] },
      { name: "Hidden", tags: ["Hip-Hop", "shoegaze"] },
    ],
    topGenres: ["shoegaze", "hip hop"],
    topTags: ["hip-hop"],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();

  assert.deepEqual(await blockGenre(7, " Hip Hop "), ["hip hop"]);
  assert.equal((await postBlock(7, "seen live")).status, 400);
  const blocked = await discover(7);
  assert.deepEqual(
    blocked.recommendations.map((artist) => artist.name),
    ["Kept"],
  );
  assert.deepEqual(blocked.topGenres, ["shoegaze"]);
  assert.deepEqual(blocked.topTags, []);
  assert.equal((await discover(8)).recommendations.length, 2);

  const removed = await appFor(7).request("/discover/blocked-tags?tag=hip-hop", {
    method: "DELETE",
  });
  const { tags }: BlockedTags = await removed.json();
  assert.deepEqual(tags, []);
  assert.equal((await discover(7)).recommendations.length, 2);
});

test("flows drop trending and focus artists carrying a blocked genre", async () => {
  await blockGenre(7, "k-pop");
  const source = new FlowTrackSource();
  const track = (artistName: string) => ({
    ...playlistTrack({ artistName, trackName: `${artistName} Song` }),
    reason: "Test",
  });
  let focusTags: unknown;
  source._getLibraryArtistKeySet = async () => new Set<string>();
  source.getTrendingTracks = async () => [track("Idol Group"), track("Trend Band")];
  source._getArtistTopTagLists = async (artists) =>
    artists.map((artist) => (artist.name === "Idol Group" ? ["K-Pop", "dance"] : ["indie"]));
  source._getFocusCandidates = async (_limit, options) => {
    focusTags = options?.tags;
    return [
      source._buildBaseCandidate(track("Idol Two"), "focus", 0, { artistTags: ["k pop"] }),
      source._buildBaseCandidate(track("Focus Band"), "focus", 1, { artistTags: ["indie"] }),
    ];
  };

  const plan = await source.buildFlowRunPlan({
    ownerUserId: 7,
    mix: { discover: 0, mix: 0, trending: 50, focus: 50 },
    tags: ["K-Pop", "indie"],
    size: 4,
  });

  assert.deepEqual(focusTags, ["indie"]);
  assert.deepEqual(plan.primaryTracks.map((entry) => entry.artistName).sort(), [
    "Focus Band",
    "Trend Band",
  ]);
});
