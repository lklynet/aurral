import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("a JSON null message is not reported as a parse failure", async () => {
  const { websocketService } = await import("../backend/services/websocketService.ts");
  const { logger } = await import("../backend/services/logger.ts");
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  websocketService.handleMessage(
    { subscriptions: new Set(), ws: { readyState: 1, send() {} } },
    "null",
  );
  assert.equal(error.mock.calls.length, 0);
  assert.equal(warn.mock.calls.length, 1);
});
