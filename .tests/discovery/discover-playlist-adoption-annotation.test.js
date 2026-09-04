import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, playlistBuilder, weeklyFlowPlaylistConfig] =
  await setupIsolatedBackend(
    "discover-playlist-adoption-annotation",
    "backend/services/discovery/playlistBuilder.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  );

const { annotateDiscoverPlaylistsForUser } = playlistBuilder;
const { flowPlaylistConfig } = weeklyFlowPlaylistConfig;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const OWNER_USER_ID = 7;

const flow = flowPlaylistConfig.createFlow({
  name: "Today's Top Rock",
  mix: { discover: 34, mix: 33, trending: 33, focus: 0 },
  size: 20,
  scheduleDays: [5],
  scheduleTime: "00:00",
  ownerUserId: OWNER_USER_ID,
  discoverPresetId: "top-rock",
  type: "editorial",
  tag: "rock",
});

const discoverPlaylists = [
  { presetId: "top-rock", name: "Today's Top Rock", tracks: [] },
  { presetId: "top-metal", name: "Metal Mayhem", tracks: [] },
];

test("annotates adopted flows when given a plain user id", () => {
  const annotated = annotateDiscoverPlaylistsForUser(
    discoverPlaylists,
    OWNER_USER_ID,
  );
  assert.equal(annotated[0].adoptedFlowId, flow.id);
  assert.equal(annotated[1].adoptedFlowId, null);
});

test("annotates adopted flows when given a user object", () => {
  const annotated = annotateDiscoverPlaylistsForUser(discoverPlaylists, {
    id: OWNER_USER_ID,
  });
  assert.equal(annotated[0].adoptedFlowId, flow.id);
});

test("does not annotate flows owned by another user", () => {
  const annotated = annotateDiscoverPlaylistsForUser(
    discoverPlaylists,
    OWNER_USER_ID + 1,
  );
  assert.equal(annotated[0].adoptedFlowId, null);
});
