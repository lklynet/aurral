import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { buildSlskdRankingHistoryOptions, recordSlskdTransferOutcome }, { db }] =
  await setupIsolatedBackend(
    "slskd-transfer-history",
    () => import("../../backend/services/slskdTransferHistory.ts"),
    () => import("../../backend/config/db-sqlite.ts"),
  );

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

function recordOutcome(username: string, status: string, reason: string | null = null) {
  recordSlskdTransferOutcome({
    reason,
    job: {
      id: `${username}-${status}`,
      artistName: "Artist",
      trackName: "Track",
      albumName: "Album",
    },
    candidate: {
      raw: {
        user: username,
        file: "Artist/Album/01 - Track.flac",
      },
    },
    status,
  });
}

test("buildSlskdRankingHistoryOptions penalizes repeated failed peers", () => {
  for (let index = 0; index < 5; index += 1) {
    recordOutcome("fragilePeer", "transfer_failed");
  }

  const options = buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("fragilePeer"), true);
  assert.ok(options.getUserQueuePenalty("fragilePeer") > 0);
});

test("buildSlskdRankingHistoryOptions keeps successful peers eligible", () => {
  for (let index = 0; index < 5; index += 1) {
    recordOutcome("recoveredPeer", "transfer_failed");
  }
  recordOutcome("recoveredPeer", "success");

  const options = buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("recoveredPeer"), false);
  assert.ok(options.getUserQueuePenalty("recoveredPeer") > 0);
});

test("a peer that banned Aurral is skipped until it uploads again", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  recordOutcome("strictPeer", "success");
  vi.advanceTimersByTime(1000);
  recordOutcome(
    "strictPeer",
    "transfer_failed",
    "slskd transfer failed: Transfer rejected: Banned",
  );
  assert.equal(buildSlskdRankingHistoryOptions().isUserBlacklisted("strictPeer"), true);

  vi.advanceTimersByTime(1000);
  recordOutcome("strictPeer", "success");
  assert.equal(buildSlskdRankingHistoryOptions().isUserBlacklisted("strictPeer"), false);
});

test("quality-profile rejections never blacklist a peer or penalize its queue position", () => {
  for (let index = 0; index < 6; index += 1) {
    recordOutcome("hiresOnlyPeer", "validation_failed", "quality-below-floor: flac-hires");
  }
  for (let index = 0; index < 3; index += 1) {
    recordOutcome(
      "noUpgradePeer",
      "validation_failed",
      "quality-not-an-upgrade: current=flac-standard, candidate=flac-hires",
    );
  }

  const options = buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("hiresOnlyPeer"), false);
  assert.equal(options.isUserBlacklisted("noUpgradePeer"), false);
  assert.equal(options.getUserQueuePenalty("hiresOnlyPeer"), 0);
  assert.equal(options.getUserQueuePenalty("noUpgradePeer"), 0);
});

test("unreadable and mismatched files still count against a peer", () => {
  for (let index = 0; index < 5; index += 1) {
    recordOutcome("brokenFilesPeer", "validation_failed", "downloaded file is not readable audio");
  }
  for (let index = 0; index < 3; index += 1) {
    recordOutcome(
      "wrongRecordingPeer",
      "validation_failed",
      "downloaded file is 42.0s longer than the requested track",
    );
  }

  const options = buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("brokenFilesPeer"), true);
  assert.equal(options.isUserBlacklisted("wrongRecordingPeer"), true);
});
