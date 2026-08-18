import test from "node:test";
import assert from "node:assert/strict";

import {
  isActivityQueueItem,
  matchesActivityView,
  normalizeActivityView,
  buildActivityPath,
  buildWantedPath,
} from "../../frontend/src/navigation/activityNavConfig.js";

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

test("wanted links share one page route", () => {
  assert.equal(buildWantedPath("missing"), "/activity/missing");
  assert.equal(buildWantedPath("cutoff"), "/activity/missing?tab=cutoff");
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

test("missing is a separate operation view", () => {
  const failed = { status: "failed", inQueue: false };
  assert.equal(matchesActivityView(failed, "missing"), false);
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
