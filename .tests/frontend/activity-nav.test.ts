import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  normalizeActivityView,
  buildActivityPath,
} from "../../frontend/src/navigation/activityNavConfig.ts";
import {
  buildActivityPage,
  getActivityStatus,
  getActivityStatusFilters,
  isActivityQueueItem,
  normalizeActivityStatus,
  matchesActivityView,
} from "../../lib/activity.ts";
import { activityRequest } from "./fixtures.ts";

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

test("activity pages count the whole view but return only the requested slice", () => {
  const request = (id: string, status: string, statusLabel: string, requestedAt: string) =>
    activityRequest({ id, status, statusLabel, requestedAt, inQueue: status !== "completed" });
  const requests = [
    request("old-review", "blocked", "Review", "2026-01-01T00:00:00Z"),
    request("new-review", "blocked", "Review", "2026-01-03T00:00:00Z"),
    request("queued", "pending", "Queued", "2026-01-02T00:00:00Z"),
    request("done", "completed", "Downloaded", "2026-01-04T00:00:00Z"),
  ];

  const page = buildActivityPage(requests, { view: "queue", status: null, limit: 2 });
  assert.deepEqual(
    page.items.map(({ id }) => id),
    ["new-review", "queued"],
  );
  assert.equal(page.total, 3);
  assert.equal(page.matching, 3);
  assert.deepEqual(
    page.filters.map(({ id, count }) => [id, count]),
    [
      ["queued", 1],
      ["review", 2],
    ],
  );

  const secondPage = buildActivityPage(requests, {
    view: "queue",
    status: null,
    offset: 2,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.items.map(({ id }) => id),
    ["old-review"],
  );
  assert.equal(secondPage.matching, 3);

  const reviews = buildActivityPage(requests, { view: "queue", status: "review", limit: 1 });
  assert.deepEqual(
    reviews.items.map(({ id }) => id),
    ["new-review"],
  );
  assert.equal(reviews.total, 3);
  assert.equal(reviews.matching, 2);
});

test("queue pages say why downloads are queued and filter to one cause", () => {
  const cause = (kind: "upgrade" | "flow" | "missing", playlistId: string | null = null) => ({
    kind,
    playlistId,
    name: playlistId ? "Weekly Jams" : null,
    syncedFrom: null,
  });
  const queued = (id: string, requestedAt: string, overrides = {}) =>
    activityRequest({ id, status: "pending", inQueue: true, requestedAt, ...overrides });
  const requests = [
    queued("upgrade-1", "2026-01-02T00:00:00Z", { cause: cause("upgrade") }),
    queued("upgrade-2", "2026-01-01T00:00:00Z", { cause: cause("upgrade") }),
    queued("upgrade-3", "2026-01-03T00:00:00Z", { cause: cause("upgrade") }),
    queued("flow", "2026-01-04T00:00:00Z", { cause: cause("flow", "f1") }),
    queued("missing-1", "2026-01-05T00:00:00Z", { cause: cause("missing"), albumName: "A" }),
    queued("missing-2", "2026-01-05T00:00:00Z", { cause: cause("missing"), albumName: "B" }),
    queued("unknown", "2026-01-06T00:00:00Z"),
  ];

  const page = buildActivityPage(requests, { view: "queue", status: null, limit: 25 });
  assert.deepEqual(
    page.causes.map(({ key, count, since, subjects }) => [key, count, since, subjects]),
    [
      ["upgrade", 3, "2026-01-01T00:00:00Z", 0],
      ["missing", 2, "2026-01-05T00:00:00Z", 2],
      ["flow:f1", 1, "2026-01-04T00:00:00Z", 0],
    ],
  );
  assert.equal(page.total, 7);

  const flow = buildActivityPage(requests, {
    view: "queue",
    status: null,
    cause: "flow:f1",
    limit: 25,
  });
  assert.equal(flow.cause, "flow:f1");
  assert.deepEqual(
    flow.items.map(({ id }) => id),
    ["flow"],
  );
  assert.equal(flow.causes.length, 3);
  assert.equal(flow.total, 1);

  const finished = buildActivityPage(requests, {
    view: "queue",
    status: null,
    cause: "share",
    limit: 25,
  });
  assert.equal(finished.cause, null);
  assert.equal(finished.matching, 7);
});
