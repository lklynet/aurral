import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  getActivityStatus,
  getActivityStatusFilters,
  isActivityQueueItem,
  normalizeActivityStatus,
  matchesActivityView,
  normalizeActivityView,
  buildActivityPath,
} from "../../frontend/src/navigation/activityNavConfig.ts";

test("normalizeActivityView falls back to queue", () => {
  assert.equal(normalizeActivityView(undefined), "queue");
  assert.equal(normalizeActivityView("bogus"), "queue");
  assert.equal(normalizeActivityView("review"), "queue");
  assert.equal(normalizeActivityView("missing"), "missing");
});

test("buildActivityPath normalizes invalid views", () => {
  assert.equal(buildActivityPath("history"), "/activity/history");
  assert.equal(buildActivityPath("nope"), "/activity/queue");
});

test("blocked items with inQueue appear in the combined queue", () => {
  const blocked = {
    status: "blocked",
    inQueue: true,
    kind: "track_download",
  };
  assert.equal(isActivityQueueItem(blocked), true);
  assert.equal(matchesActivityView(blocked, "queue"), true);
  assert.equal(matchesActivityView(blocked, "history"), false);
});

test("processing items appear in queue not history", () => {
  const active = { status: "processing", inQueue: true };
  assert.equal(matchesActivityView(active, "queue"), true);
  assert.equal(matchesActivityView(active, "review"), false);
  assert.equal(matchesActivityView(active, "history"), false);
});

test("completed items appear in history", () => {
  const done = { status: "completed", inQueue: false };
  assert.equal(matchesActivityView(done, "queue"), false);
  assert.equal(matchesActivityView(done, "review"), false);
  assert.equal(matchesActivityView(done, "history"), true);
});

test("failed items with canReSearch appear in history", () => {
  const failed = { status: "failed", inQueue: false, canReSearch: true };
  assert.equal(matchesActivityView(failed, "history"), true);
});

test("activity statuses sort queue and history items into filters", () => {
  assert.equal(getActivityStatus({ status: "blocked", statusLabel: "Needs review" }), "review");
  assert.equal(getActivityStatus({ status: "pending" }), "queued");
  assert.equal(getActivityStatus({ status: "processing", statusLabel: "Queued" }), "queued");
  assert.equal(
    getActivityStatus({ status: "processing", statusLabel: "Searching for album" }),
    "searching",
  );
  assert.equal(getActivityStatus({ status: "processing", statusLabel: "Moving" }), "downloading");
  assert.equal(getActivityStatus({ status: "processing", statusLabel: "Generating" }), null);
  assert.equal(
    getActivityStatus({ status: "completed", kind: "track_download", statusLabel: "Reused" }),
    "downloaded",
  );
  assert.equal(
    getActivityStatus({ status: "completed", kind: "track_download", upgrade: {} }),
    "upgraded",
  );
  assert.equal(
    getActivityStatus({ status: "completed", kind: "album_requested", statusLabel: "Requested" }),
    null,
  );
  assert.equal(getActivityStatus({ status: "completed", kind: "artist_added" }), null);
  assert.equal(getActivityStatus({ status: "failed", statusLabel: "Not found" }), "failed");
});

test("queue filters hide empty statuses but history keeps them", () => {
  const queue = [
    { status: "processing", statusLabel: "Downloading" },
    { status: "processing", statusLabel: "Downloading" },
    { status: "blocked" },
  ];
  assert.deepEqual(
    getActivityStatusFilters("queue", queue, null).map(({ id, count }) => [id, count]),
    [
      ["downloading", 2],
      ["review", 1],
    ],
  );
  assert.deepEqual(
    getActivityStatusFilters("queue", queue, "searching").map(({ id }) => id),
    ["searching", "downloading", "review"],
  );
  assert.deepEqual(
    getActivityStatusFilters("history", [], null).map(({ id }) => id),
    ["downloaded", "upgraded", "failed", "cancelled"],
  );
});

test("normalizeActivityStatus only accepts statuses the view offers", () => {
  assert.equal(normalizeActivityStatus("history", "failed"), "failed");
  assert.equal(normalizeActivityStatus("history", "searching"), null);
  assert.equal(normalizeActivityStatus("queue", "bogus"), null);
  assert.equal(normalizeActivityStatus("queue", null), null);
});
