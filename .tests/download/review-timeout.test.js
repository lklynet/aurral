import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { denyExpiredReviews }] = await setupIsolatedBackend(
  "review-timeout",
  "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/blockedJobReview.js",
);
const HOUR = 60 * 60 * 1000;
let sequence = 0;

test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(state));

async function holdForReview(trackName) {
  const stagingPath = path.join(state.baseDir, `held-${++sequence}`, `${trackName}.flac`);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, "held audio");
  const jobId = downloadTracker.addJob({ artistName: "The Band", trackName }, "library");
  downloadTracker.setDownloading(jobId);
  downloadTracker.setBlocked(jobId, "duration conflicts", stagingPath);
  return { jobId, stagingPath };
}

const exists = async (target) => Boolean(await fs.stat(target).catch(() => null));

test("songs held longer than the maximum wait are denied and searched again", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), reviewTimeoutHours: 24 });
  const held = await holdForReview("Old");
  assert.equal(await denyExpiredReviews(Date.now() + 25 * HOUR), 1);
  const job = downloadTracker.getJob(held.jobId);
  assert.equal(job.status, "pending");
  assert.equal(job.error, "Review timed out");
  assert.equal(await exists(held.stagingPath), false);
});

test("songs within the maximum wait stay held", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), reviewTimeoutHours: 24 });
  const held = await holdForReview("Recent");
  assert.equal(await denyExpiredReviews(Date.now() + 23 * HOUR), 0);
  assert.equal(downloadTracker.getJob(held.jobId).status, "blocked");
  assert.equal(await exists(held.stagingPath), true);
});

test("a maximum wait of zero keeps held songs indefinitely", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), reviewTimeoutHours: 0 });
  const held = await holdForReview("Kept");
  assert.equal(await denyExpiredReviews(Date.now() + 1000 * HOUR), 0);
  assert.equal(downloadTracker.getJob(held.jobId).status, "blocked");
});

test("the stored maximum wait is limited to whole hours up to 30 days", () => {
  for (const [stored, expected] of [[48, 48], [0, 0], [721, 0], [-1, 0], [1.5, 0], ["x", 0]]) {
    dbOps.updateSettings({ ...dbOps.getSettings(), reviewTimeoutHours: stored });
    assert.equal(dbOps.getSettings().reviewTimeoutHours, expected, String(stored));
  }
});
