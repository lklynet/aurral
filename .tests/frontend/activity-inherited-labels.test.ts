import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  groupAlbumGrabRequests,
  lookupLabel,
  type ActivityRequest,
} from "../../frontend/src/pages/activity/activityListUtils.ts";

test("label lookups ignore inherited object keys", () => {
  const table = { slskd: "Soulseek" };
  assert.equal(lookupLabel(table, "slskd"), "Soulseek");
  assert.equal(lookupLabel(table, "constructor"), undefined);
  assert.equal(lookupLabel(table, "toString"), undefined);
  assert.equal(lookupLabel(table, null), undefined);
});

test("an album grab with a source named constructor shows the name as written", () => {
  const row: ActivityRequest = {
    id: "job-1",
    source: "aurral",
    type: "activity",
    title: "Track",
    subtitle: null,
    status: "processing",
    statusLabel: null,
    requestedAt: "2025-03-04T15:30:00.000Z",
    href: null,
    kind: "track_download",
    playlistId: "library",
    playlistName: null,
    jobId: "job-1",
    trackName: "Track",
    artistName: "Artist",
    albumName: "Album",
    albumMbid: null,
    albumId: null,
    canonicalAlbumId: null,
    requestGroupId: null,
    requestedBy: null,
    sourceFilename: null,
    releaseTitle: null,
    inQueue: true,
    canReSearch: false,
    albumGrab: {
      id: "grab-1",
      memberJobIds: ["job-1"],
      phase: "constructor",
      source: "constructor",
      fallbackReason: null,
      requestedAt: "2025-03-04T15:30:00.000Z",
    },
  };
  const [grouped] = groupAlbumGrabRequests([row]);
  assert.equal(grouped.sourceSummary, "constructor");
  assert.equal(grouped.statusLabel, "Queued");
});
