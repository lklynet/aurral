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

test("the Lidarr import list has one row per artist", () => {
  const items = buildLidarrImportListItems([
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      status: "done",
    },
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      status: "pending",
    },
    {
      artistMbid: "33333333-3333-4333-8333-333333333333",
      status: "failed",
    },
    {
      artistMbid: null,
      status: "done",
    },
    {
      artistMbid: "55555555-5555-4555-8555-555555555555",
      status: "saved",
    },
  ]);
  assert.deepEqual(items, [
    { MusicBrainzId: "11111111-1111-4111-8111-111111111111" },
    { MusicBrainzId: "33333333-3333-4333-8333-333333333333" },
  ]);
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
