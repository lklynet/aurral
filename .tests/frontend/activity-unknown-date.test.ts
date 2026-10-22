import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  buildHistoryListEntries,
  type ActivityRequest,
} from "../../frontend/src/pages/activity/activityListUtils.ts";

const lidarrRequest = (id: string, requestedAt: string | null): ActivityRequest => ({
  id,
  source: "lidarr",
  type: "album",
  albumId: id,
  albumMbid: null,
  albumName: "Album",
  artistName: "Artist",
  status: "pending",
  statusLabel: "Queued",
  requestedAt,
  inQueue: false,
  canReSearch: false,
});

test("a request with no date is grouped under Unknown date", () => {
  const entries = buildHistoryListEntries([lidarrRequest("lidarr-queue-1", null)]);
  assert.deepEqual(
    entries.map((entry) => (entry.type === "date" ? entry.label : entry.request.id)),
    ["Unknown date", "lidarr-queue-1"],
  );
});
