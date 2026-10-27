import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { playlistTrack } from "../playlists/fixtures.ts";
import type { hc, InferResponseType } from "hono/client";
import type discoveryApp from "../../backend/routes/discovery/index.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const isolatedState = await createIsolatedStateDir("artist-blocklist");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, discovery, flowTrackSourceModule, { api }] = await Promise.all([
  import("../../backend/config/db-sqlite.ts"),
  import("../../backend/services/discovery/index.ts"),
  import("../../backend/services/flows/flowTrackSource.ts"),
  import("../../backend/routes/api.ts"),
]);

type FeedbackRoutes = ReturnType<typeof hc<typeof discoveryApp>>["discover"]["feedback"];
type FeedbackList = InferResponseType<FeedbackRoutes["$get"], 200>;
type FeedbackAdded = InferResponseType<FeedbackRoutes["$post"], 200>;
type FeedbackRestored = InferResponseType<FeedbackRoutes["restore"]["$post"], 200>;

const { FlowTrackSource } = flowTrackSourceModule;

beforeEach(() => resetDatabase(db));
afterAll(async () => cleanupIsolatedState(isolatedState));

test("artist blocks are per-user and match ids, names, and track aliases", () => {
  discovery.addDiscoveryFeedback("7", {
    artistId: "11111111-1111-1111-1111-111111111111",
    artistName: "Blocked Artist",
    action: "block_artist",
  });

  const allowed = discovery.filterBlockedArtistsForUser("7", [
    { name: "Allowed Artist" },
    { artistName: "Blocked Artist" },
    { artistMbid: "11111111-1111-1111-1111-111111111111", artistName: "Alias" },
    { artistName: "Alias", artistAliases: ["Blocked Artist"] },
  ]);

  assert.deepEqual(
    allowed.map((artist) => artist.name || artist.artistName),
    ["Allowed Artist"],
  );
  assert.equal(discovery.filterBlockedArtistsForUser("8", [{ name: "Blocked Artist" }]).length, 1);
});

test("resetting discovery tastes preserves artist blocks", () => {
  discovery.addDiscoveryFeedback("7", {
    artistName: "Blocked Artist",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistName: "Taste Artist",
    action: "less_like_this",
  });

  const remaining = discovery.resetDiscoveryFeedback("7");

  assert.deepEqual(
    remaining.map((entry) => entry.action),
    ["block_artist"],
  );
});

test("flows exclude only hard-blocked artists", async () => {
  discovery.addDiscoveryFeedback("7", {
    artistName: "Blocked Artist",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistId: "11111111-1111-1111-1111-111111111111",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistName: "Soft Dislike",
    action: "less_like_this",
  });

  const source = new FlowTrackSource();

  const radarTrack = (track: { artistName: string; trackName: string; artistMbid?: string }) => ({
    ...playlistTrack(track),
    reason: "Release radar",
  });
  source.getReleaseRadarTracks = async () => [
    radarTrack({ artistName: "Blocked Artist", trackName: "Blocked Track" }),
    radarTrack({
      artistName: "Renamed Artist",
      artistMbid: "11111111-1111-1111-1111-111111111111",
      trackName: "Blocked By Id",
    }),
    radarTrack({ artistName: "Soft Dislike", trackName: "Still Eligible" }),
  ];
  const plan = await source.buildFlowRunPlan({
    ownerUserId: 7,
    discoverPresetId: "release-radar",
    size: 2,
  });

  assert.deepEqual(
    plan.primaryTracks.map((track) => track.artistName),
    ["Soft Dislike"],
  );
});

const app = signedInAs(testUser(7)).route("/", api);

const send = (method: string, path: string, body?: object) =>
  app.request(`/discover/feedback${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });

const listFeedback = async () => {
  const list: FeedbackList = await (await send("GET", "")).json();
  return list.feedback;
};

const addFeedback = async (body: object) => {
  const added: FeedbackAdded = await (await send("POST", "", body)).json();
  return added.feedback;
};

test("undoing less like this restores the taste it replaced exactly", async () => {
  await addFeedback({ artistName: "Blocked Artist", action: "block_artist" });
  const more = await addFeedback({
    artistName: "Taste Artist",
    action: "more_like_this",
    tagContext: ["shoegaze"],
  });
  const before = await listFeedback();

  await send("DELETE", `/${encodeURIComponent(more.id)}`);
  const less = await addFeedback({ artistName: "Taste Artist", action: "less_like_this" });

  const rejected = await send("POST", "/restore", { removeIds: "all" });
  assert.equal(rejected.status, 400);
  assert.deepEqual(
    (await listFeedback()).map((entry) => entry.id),
    [less.id, before[1].id],
  );

  const restored = await send("POST", "/restore", { removeIds: [less.id], entries: [more] });
  assert.equal(restored.status, 200);
  const { feedbackList }: FeedbackRestored = await restored.json();
  assert.deepEqual(feedbackList, before);
  assert.deepEqual(await listFeedback(), before);
});
