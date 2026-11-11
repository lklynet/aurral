import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  isCutoffUnmetJob,
  getMissingJobKey,
  isMissingJob,
  sortMissingJobs,
} from "../../frontend/src/pages/activity/activityMissingUtils.ts";

test("missing activity includes failed Aurral jobs but not upgrades", () => {
  assert.equal(isMissingJob({ status: "failed" }), true);
  assert.equal(isMissingJob({ status: "failed", upgradeForJobId: "job-1" }), false);
  assert.equal(isMissingJob({ status: "done" }), false);
  assert.equal(isMissingJob({ status: "failed", monitored: false }), false);
});

test("cutoff activity includes owned files below the preferred quality", () => {
  assert.equal(
    isCutoffUnmetJob({ status: "done", qualityOwned: true, qualityState: "upgrade" }),
    true,
  );
  assert.equal(
    isCutoffUnmetJob({ status: "done", qualityOwned: true, qualityState: "preferred" }),
    false,
  );
  assert.equal(
    isCutoffUnmetJob({ status: "done", qualityOwned: false, qualityState: "upgrade" }),
    false,
  );
  assert.equal(
    isCutoffUnmetJob({
      status: "done",
      qualityOwned: true,
      qualityState: "upgrade",
      monitored: false,
    }),
    false,
  );
});

test("missing activity sorts newest operations first", () => {
  assert.ok(
    sortMissingJobs({ createdAt: 20, trackName: "A" }, { createdAt: 10, trackName: "B" }) < 0,
  );
  assert.ok(
    sortMissingJobs({ createdAt: 10, trackName: "A" }, { createdAt: 10, trackName: "B" }) < 0,
  );
  assert.equal(getMissingJobKey({ id: "job-42" }), "job-42");
});
