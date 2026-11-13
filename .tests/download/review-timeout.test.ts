import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { downloadTracker },
  { retryStaleReviews, approveBlockedJob },
  { withDownloadImportLock },
  { slskdClient },
] = await setupIsolatedBackend(
  "review-timeout",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/blockedJobReview.ts"),
  () => import("../../backend/services/downloadJobs/downloadLocks.ts"),
  () => import("../../backend/services/slskdClient.ts"),
);
const HOUR = 60 * 60 * 1000;
let sequence = 0;

beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
});
afterAll(() => cleanupIsolatedState(state));

async function holdForReview(
  trackName: string,
  folder = path.join(state.baseDir, `held-${++sequence}`),
) {
  const stagingPath = path.join(folder, `${trackName}.flac`);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, "held audio");
  const jobId = createTrackedJob(downloadTracker, { artistName: "The Band", trackName }, "library");
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);
  downloadTracker.setBlocked(jobId, "duration conflicts", stagingPath);
  return { jobId, stagingPath };
}

const exists = async (target: string) => Boolean(await fs.stat(target).catch(() => null));

test("songs held longer than three days are denied and searched again", async () => {
  const held = await holdForReview("Old");
  assert.equal(await retryStaleReviews(Date.now() + 73 * HOUR), 1);
  const job = trackedJob(downloadTracker, held.jobId);
  assert.equal(job.status, "pending");
  assert.equal(job.error, "Review timed out");
  assert.equal(await exists(held.stagingPath), false);
});

test("songs held for less than three days stay held", async () => {
  const held = await holdForReview("Recent");
  assert.equal(await retryStaleReviews(Date.now() + 71 * HOUR), 0);
  assert.equal(trackedJob(downloadTracker, held.jobId).status, "blocked");
  assert.equal(await exists(held.stagingPath), true);
});

test.each([
  ["the review task runs", async () => assert.equal(await retryStaleReviews(), 1)],
  [
    "its review expired",
    async () => assert.equal(await retryStaleReviews(Date.now() + 73 * HOUR), 1),
  ],
  [
    "it is approved",
    async (jobId: string) => assert.equal((await approveBlockedJob(jobId)).status, 404),
  ],
])(
  "a held song whose file is gone is searched again when %s, without denying its source",
  async (_trigger, settle) => {
    const held = await holdForReview("Vanished");
    downloadTracker.updateDownloadMetadata(held.jobId, {
      downloadSource: "ytdlp",
      releaseGuid: "video-id",
    });
    await fs.rm(held.stagingPath);
    await settle(held.jobId);
    const job = trackedJob(downloadTracker, held.jobId);
    assert.equal(job.status, "pending");
    assert.equal(job.error, "Review file is gone");
    assert.deepEqual(job.deniedRemoteSources ?? [], []);
  },
);

test("a timeout waits for an approval in progress and leaves the approved song alone", async () => {
  const held = await holdForReview("Approving");
  let finishApproval!: () => void;
  let lockHeld!: () => void;
  const approvalStarted = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  // The approval imports while it holds the lock.
  const approval = withDownloadImportLock("library", async () => {
    lockHeld();
    await new Promise<void>((resolve) => {
      finishApproval = resolve;
    });
    downloadTracker.setDone(held.jobId, held.stagingPath);
  });
  await approvalStarted;
  const denial = retryStaleReviews(Date.now() + 73 * HOUR);
  try {
    for (let tick = 0; tick < 20; tick += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(trackedJob(downloadTracker, held.jobId).status, "blocked");
    assert.equal(await exists(held.stagingPath), true);
  } finally {
    finishApproval();
    await approval;
  }
  assert.equal(await denial, 0);
  assert.equal(trackedJob(downloadTracker, held.jobId).status, "done");
  assert.equal(await exists(held.stagingPath), true);
});

test("approving a Soulseek song removes the folders it leaves in slskd's downloads", async () => {
  const slskdRoot = path.join(state.baseDir, `slskd-${++sequence}`);
  const held = await holdForReview("Approved", path.join(slskdRoot, "Album", "Disc 1"));
  await fs.writeFile(path.join(slskdRoot, "other.flac"), "another download");
  downloadTracker.updateDownloadMetadata(held.jobId, { downloadSource: "slskd" });
  vi.spyOn(slskdClient, "getDownloadDirectory").mockImplementation(async () => slskdRoot);

  assert.equal((await approveBlockedJob(held.jobId)).status, 200);

  assert.equal(trackedJob(downloadTracker, held.jobId).status, "done");
  assert.equal(await exists(path.join(slskdRoot, "Album")), false);
  assert.equal(await exists(path.join(slskdRoot, "other.flac")), true);
});
