import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { runMonitoringRepairSequence } from "../../backend/services/libraryMonitoringRepair.ts";

test("monitoring repair stops immediately after Lidarr confirms the requested state", async () => {
  let attempts = 0;
  const result = await runMonitoringRepairSequence({
    delaysMs: [0, 0, 0, 0],
    repair: async () => {
      attempts += 1;
      return { artist: { monitored: true }, album: { monitored: true } };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(attempts, 1);
});

test("monitoring repair retries only until the requested state becomes stable", async () => {
  let attempts = 0;
  const result = await runMonitoringRepairSequence({
    delaysMs: [0, 0, 0, 0],
    repair: async () => {
      attempts += 1;
      return {
        artist: { monitored: attempts >= 2 },
        album: { monitored: attempts >= 2 },
      };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(attempts, 2);
});
