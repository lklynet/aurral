import test from "node:test";
import assert from "node:assert/strict";

import {
  isCutoffUnmetAurralJob,
  isMissingAurralJob,
  sortMissingJobs,
} from "../../frontend/src/pages/activity/activityMissingUtils.js";

test("missing activity includes failed Aurral jobs but not upgrades", () => {
  assert.equal(isMissingAurralJob({ status: "failed" }), true);
  assert.equal(isMissingAurralJob({ status: "failed", upgradeForJobId: "job-1" }), false);
  assert.equal(isMissingAurralJob({ status: "done" }), false);
});

test("cutoff activity includes owned files below the preferred quality", () => {
  assert.equal(
    isCutoffUnmetAurralJob({ status: "done", qualityOwned: true, qualityState: "upgrade" }),
    true,
  );
  assert.equal(
    isCutoffUnmetAurralJob({ status: "done", qualityOwned: true, qualityState: "preferred" }),
    false,
  );
  assert.equal(
    isCutoffUnmetAurralJob({ status: "done", qualityOwned: false, qualityState: "upgrade" }),
    false,
  );
});

test("missing activity sorts newest operations first", () => {
  assert.ok(
    sortMissingJobs({ createdAt: 20, trackName: "A" }, { createdAt: 10, trackName: "B" }) < 0,
  );
});
