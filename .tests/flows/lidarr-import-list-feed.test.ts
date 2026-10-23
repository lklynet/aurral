import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { buildLidarrImportListItems, verifyFlowLidarrFeedToken },
  { flowPlaylistConfig },
] = await setupIsolatedBackend(
  "lidarr-import-list-feed",
  () => import("../../backend/services/lidarrImportListFeed.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
);

afterAll(() => cleanupIsolatedState(isolatedState));

test("buildLidarrImportListItems maps jobs to lidarr custom list rows", () => {
  const items = buildLidarrImportListItems([
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      albumMbid: "22222222-2222-4222-8222-222222222222",
    },
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      albumMbid: "22222222-2222-4222-8222-222222222222",
    },
    {
      artistMbid: "33333333-3333-4333-8333-333333333333",
      albumMbid: null,
    },
    { artistMbid: null, albumMbid: "44444444-4444-4444-8444-444444444444" },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    MusicBrainzId: "11111111-1111-4111-8111-111111111111",
    AlbumId: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(items[1], {
    MusicBrainzId: "33333333-3333-4333-8333-333333333333",
  });
});

test("verifyFlowLidarrFeedToken accepts only the flow's own token", () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Feed Flow", size: 10, ownerUserId: 7 });
  const withToken = flowPlaylistConfig.ensureLidarrFeedToken(flow.id);
  assert.ok(withToken?.lidarrFeedToken);
  const { lidarrFeedToken } = withToken;

  assert.equal(verifyFlowLidarrFeedToken("missing-flow", lidarrFeedToken), null);
  assert.equal(verifyFlowLidarrFeedToken(flow.id, ""), null);
  const wrongToken = `${lidarrFeedToken.slice(0, -1)}${lidarrFeedToken.endsWith("0") ? "1" : "0"}`;
  assert.equal(verifyFlowLidarrFeedToken(flow.id, wrongToken), null);
  assert.equal(verifyFlowLidarrFeedToken(flow.id, lidarrFeedToken)?.id, flow.id);
});
