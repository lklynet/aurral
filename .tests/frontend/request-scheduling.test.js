import test from "node:test";
import assert from "node:assert/strict";

import {
  getActivityPollIntervalMs,
  getBootstrapPollIntervalMs,
  shouldPollDiscoveryHealth,
} from "../../frontend/src/utils/requestScheduling.js";

test("activity uses a slower reconciliation interval while its sockets are connected", () => {
  assert.equal(
    getActivityPollIntervalMs({ isConnected: false, isListLikeView: true }),
    15_000,
  );
  assert.equal(
    getActivityPollIntervalMs({ isConnected: true, isListLikeView: true }),
    60_000,
  );
  assert.equal(
    getActivityPollIntervalMs({ isConnected: true, isListLikeView: false }),
    300_000,
  );
});

test("discovery health polling is only a disconnected socket fallback", () => {
  assert.equal(shouldPollDiscoveryHealth({ isConnected: true }), false);
  assert.equal(shouldPollDiscoveryHealth({ isConnected: false }), true);
});

test("bootstrap polling slows down while the heartbeat socket is healthy", () => {
  assert.equal(getBootstrapPollIntervalMs({ isConnected: false }), 30_000);
  assert.equal(getBootstrapPollIntervalMs({ isConnected: true }), 120_000);
});
