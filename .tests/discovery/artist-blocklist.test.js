import test from "node:test";
import assert from "node:assert/strict";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("artist-blocklist");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, discovery, flowTrackSourceModule, { registerFeedback }] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/discovery/index.js"),
  importFromRepo("backend/services/flows/flowTrackSource.js"),
  importFromRepo("backend/routes/discovery/handlers/feedback.js"),
]);

const { FlowTrackSource } = flowTrackSourceModule;

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

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

  assert.deepEqual(allowed.map((artist) => artist.name || artist.artistName), ["Allowed Artist"]);
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

  assert.deepEqual(remaining.map((entry) => entry.action), ["block_artist"]);
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

  source.getReleaseRadarTracks = async () => [
    { artistName: "Blocked Artist", trackName: "Blocked Track" },
    {
      artistName: "Renamed Artist",
      artistMbid: "11111111-1111-1111-1111-111111111111",
      trackName: "Blocked By Id",
    },
    { artistName: "Soft Dislike", trackName: "Still Eligible" },
  ];
  const plan = await source.buildFlowRunPlan({
    ownerUserId: 7,
    discoverPresetId: "release-radar",
    size: 2,
  });

  assert.deepEqual(plan.primaryTracks.map((track) => track.artistName), ["Soft Dislike"]);
});

const feedbackRoutes = () => {
  const routes = new Map();
  const register = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1));
  registerFeedback({ get: register("GET"), post: register("POST"), delete: register("DELETE") });
  return (key, req) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    routes.get(key)({ user: { id: 7 }, params: {}, body: {}, ...req }, res);
    return res;
  };
};

test("undoing less like this restores the taste it replaced exactly", () => {
  const call = feedbackRoutes();
  call("POST /feedback", { body: { artistName: "Blocked Artist", action: "block_artist" } });
  const more = call("POST /feedback", {
    body: { artistName: "Taste Artist", action: "more_like_this", tagContext: ["shoegaze"] },
  }).body.feedback;
  const before = call("GET /feedback").body.feedback;

  call("DELETE /feedback/:id", { params: { id: more.id } });
  const less = call("POST /feedback", {
    body: { artistName: "Taste Artist", action: "less_like_this" },
  }).body.feedback;

  const rejected = call("POST /feedback/restore", { body: { removeIds: "all" } });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(call("GET /feedback").body.feedback.map((entry) => entry.id), [less.id, before[1].id]);

  const restored = call("POST /feedback/restore", { body: { removeIds: [less.id], entries: [more] } });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(restored.body.feedbackList, before);
  assert.deepEqual(call("GET /feedback").body.feedback, before);
});
