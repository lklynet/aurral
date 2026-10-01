import test from "node:test";
import assert from "node:assert/strict";

import {
  getActivityPollIntervalMs,
  getBootstrapPollIntervalMs,
  shouldPollDiscoveryHealth,
} from "../../frontend/src/utils/requestScheduling.js";

test("activity polls less often while its sockets are connected", () => {
  for (const isListLikeView of [true, false]) {
    assert.ok(
      getActivityPollIntervalMs({ isConnected: true, isListLikeView }) >
        getActivityPollIntervalMs({ isConnected: false, isListLikeView }),
    );
  }
  assert.ok(
    getActivityPollIntervalMs({ isConnected: true, isListLikeView: false }) >
      getActivityPollIntervalMs({ isConnected: true, isListLikeView: true }),
  );
});

test("discovery health polling is only a disconnected socket fallback", () => {
  assert.equal(shouldPollDiscoveryHealth({ isConnected: true }), false);
  assert.equal(shouldPollDiscoveryHealth({ isConnected: false }), true);
});

test("bootstrap polling slows down while the heartbeat socket is healthy", () => {
  assert.ok(
    getBootstrapPollIntervalMs({ isConnected: true }) >
      getBootstrapPollIntervalMs({ isConnected: false }),
  );
});
