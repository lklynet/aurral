import assert from "node:assert/strict";
import { Hono } from "hono";
import { test } from "vite-plus/test";
import type { AppEnv } from "../../backend/middleware/requestUser.ts";
import type { logger } from "../../backend/services/logger.ts";

import { createRequestFailureLogger } from "../../backend/middleware/requestFailureLogger.ts";

async function sendRequest({ status, body }: { status: number; body: unknown }) {
  const events: Parameters<typeof logger.error>[] = [];
  const app = new Hono<AppEnv>()
    .use(createRequestFailureLogger({ error: (...args) => events.push(args) }))
    .post("/api/playlists/sync", () => Response.json(body, { status }));
  await app.request("/api/playlists/sync?token=secret", { method: "POST" });
  return events;
}

test("failed API responses log method, endpoint, status and response reason without query secrets", async () => {
  const events = await sendRequest({
    status: 500,
    body: { error: "Import failed", message: "Spotify request timed out" },
  });
  assert.deepEqual(events, [
    [
      "http",
      "Request failed",
      {
        method: "POST",
        endpoint: "/api/playlists/sync",
        status: 500,
        reason: "Spotify request timed out",
      },
    ],
  ]);
});

test("failed API response reasons mask credentials before logging", async () => {
  const events = await sendRequest({
    status: 502,
    body: {
      message:
        "Provider failed at https://example.test/api?token=url-secret " +
        "Authorization: Bearer bearer-secret while reading /config/private/provider.json",
    },
  });
  assert.partialDeepStrictEqual(events[0][2], {
    reason:
      "Provider failed at https://example.test/api?token=*** " +
      "Authorization=*** while reading /config/private/provider.json",
  });
});

test("routine client errors are not logged", async () => {
  assert.deepEqual(await sendRequest({ status: 404, body: { error: "Not found" } }), []);
});
