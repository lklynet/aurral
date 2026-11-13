import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { removeLegacyDeemixDownload }, { getDownloadClient }, { logger }] =
  await setupIsolatedBackend(
    "deemix-log-safety",
    () => import("../../backend/services/deemixSource.ts"),
    () => import("../../backend/services/download/downloadClientSettings.ts"),
    () => import("../../backend/services/logger.ts"),
  );

afterAll(async () => cleanupIsolatedState(isolatedState));

test("deemix queue cleanup logs a safe diagnostic when removal fails", async () => {
  vi.spyOn(getDownloadClient("deemix"), "removeFromQueue").mockImplementation(async () => {
    throw new Error("Failed at https://example.test/api?token=secret-value");
  });
  const warnings: Parameters<typeof logger.warn>[] = [];
  vi.spyOn(logger, "warn").mockImplementation((...args) => warnings.push(args));

  assert.equal(await removeLegacyDeemixDownload({ phase: "poll", queueUuid: "queue-id" }), true);

  assert.deepEqual(
    warnings.map(([, , details]) => details),
    [{ uuid: "queue-id", reason: "Failed at https://example.test/api?token=***" }],
  );
});
