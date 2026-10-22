import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  getIsolatedQueueGroup,
  isQueueOwnedByGroup,
} from "../backend/services/backgroundWorkerQueues.ts";

test("only registered queues belong to a worker group", () => {
  assert.equal(getIsolatedQueueGroup("library-scan"), "library");
  assert.equal(getIsolatedQueueGroup("constructor"), undefined);
  assert.equal(getIsolatedQueueGroup("toString"), undefined);
  assert.equal(isQueueOwnedByGroup("notification-outbox", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("constructor"), true);
  assert.equal(isQueueOwnedByGroup("constructor", "downloads"), false);
});
