import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { playlistTrack } from "../playlists/fixtures.ts";
import { createResponse, createRouteHarness } from "../library/routeHarness.ts";
import type {
  DiscoveryFeedbackAddResponse,
  DiscoveryFeedbackListResponse,
  DiscoveryFeedbackResponse,
} from "../../backend/routes/discovery/handlers/feedback.ts";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const isolatedState = await createIsolatedStateDir("artist-blocklist");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, discovery, flowTrackSourceModule, { registerFeedback }] = await Promise.all([
  import("../../backend/config/db-sqlite.ts"),
  import("../../backend/services/discovery/index.ts"),
  import("../../backend/services/flows/flowTrackSource.ts"),
  import("../../backend/routes/discovery/handlers/feedback.ts"),
]);

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

const feedbackRoutes = () => {
  const routes = createRouteHarness(registerFeedback);
  return async <Body>(key: string, req: { body?: object; params?: object } = {}) => {
    const res = createResponse<Body>();
    await routes.get(key)({ user: { id: 7 }, params: {}, body: {}, ...req }, res);
    return res;
  };
};

test("undoing less like this restores the taste it replaced exactly", async () => {
  const call = feedbackRoutes();
  await call("POST /feedback", { body: { artistName: "Blocked Artist", action: "block_artist" } });
  const more = (
    await call<DiscoveryFeedbackAddResponse>("POST /feedback", {
      body: { artistName: "Taste Artist", action: "more_like_this", tagContext: ["shoegaze"] },
    })
  ).body.feedback;
  const before = (await call<DiscoveryFeedbackResponse>("GET /feedback")).body.feedback;

  await call("DELETE /feedback/:id", { params: { id: more.id } });
  const less = (
    await call<DiscoveryFeedbackAddResponse>("POST /feedback", {
      body: { artistName: "Taste Artist", action: "less_like_this" },
    })
  ).body.feedback;

  const rejected = await call("POST /feedback/restore", { body: { removeIds: "all" } });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(
    (await call<DiscoveryFeedbackResponse>("GET /feedback")).body.feedback.map((entry) => entry.id),
    [less.id, before[1].id],
  );

  const restored = await call<DiscoveryFeedbackListResponse>("POST /feedback/restore", {
    body: { removeIds: [less.id], entries: [more] },
  });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(restored.body.feedbackList, before);
  assert.deepEqual((await call<DiscoveryFeedbackResponse>("GET /feedback")).body.feedback, before);
});
