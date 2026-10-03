import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  {
    buildSlskdRankingHistoryOptions,
    recordSlskdTransferOutcome,
  },
  { db },
] = await setupIsolatedBackend(
  "slskd-transfer-history",
  "backend/services/slskdTransferHistory.js",
  "backend/config/db-sqlite.js",
);

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function recordOutcome(username, status) {
  recordSlskdTransferOutcome({
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
