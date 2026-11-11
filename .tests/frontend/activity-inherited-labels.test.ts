import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { groupAlbumGrabRequests, lookupLabel } from "../../lib/activity.ts";
import { activityRequest } from "./fixtures.ts";

test("label lookups ignore inherited object keys", () => {
  const table = { slskd: "Soulseek" };
  assert.equal(lookupLabel(table, "slskd"), "Soulseek");
  assert.equal(lookupLabel(table, "constructor"), undefined);
  assert.equal(lookupLabel(table, "toString"), undefined);
  assert.equal(lookupLabel(table, null), undefined);
});

test("an album grab with a source named constructor shows the name as written", () => {
  const row = activityRequest({
    id: "job-1",
    status: "processing",
    requestedAt: "2025-03-04T15:30:00.000Z",
    jobId: "job-1",
    trackName: "Track",
    artistName: "Artist",
    albumName: "Album",
    inQueue: true,
    albumGrab: {
      id: "grab-1",
      memberJobIds: ["job-1"],
      phase: "constructor",
      source: "constructor",
      fallbackReason: null,
      requestedAt: "2025-03-04T15:30:00.000Z",
    },
  });
  const [grouped] = groupAlbumGrabRequests([row]);
  assert.ok(grouped !== undefined);
  assert.equal(grouped.sourceSummary, "constructor");
  assert.equal(grouped.statusLabel, "Queued");
});
