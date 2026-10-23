import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import type { Response } from "express";
import { createAuthRequest } from "../auth/authFixtures.ts";
import type { logger } from "../../backend/services/logger.ts";
import { test } from "vite-plus/test";

import { createRequestFailureLogger } from "../../backend/middleware/requestFailureLogger.ts";

function sendRequest({
  status,
  body,
  route = "/sync",
  alreadyLogged = false,
}: {
  status: number;
  body: unknown;
  route?: string;
  alreadyLogged?: boolean;
}) {
  const events: Parameters<typeof logger.error>[] = [];
  const req = createAuthRequest({
    method: "POST",
    baseUrl: "/api/playlists",
    route: { path: route },
    path: "/api/playlists/sync",
    originalUrl: "/api/playlists/sync?token=secret",
  });
  const res = Object.assign(new ServerResponse(req), {
    locals: { failureLogged: alreadyLogged },
    json(_value: unknown) {
      return this;
    },
  }) as unknown as Response;
  res.statusCode = status;
  createRequestFailureLogger({ error: (...args) => events.push(args) })(req, res, () => {});
  res.json(body);
  res.emit("finish");
  return events;
}

test("failed API responses log method, endpoint, status and response reason without query secrets", () => {
  const events = sendRequest({
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

test("failed API response reasons redact credentials and file paths before logging", () => {
  const events = sendRequest({
    status: 502,
    body: {
      message:
        "Provider failed at https://user:pass@example.test/api?token=url-secret " +
        "Authorization: Bearer bearer-secret clientSecret=client-secret " +
        "while reading /config/private/provider.json",
    },
  });
  const data = events[0][2];
  assert.ok(data && typeof data === "object" && "reason" in data);
  const reason = data.reason;
  assert.ok(typeof reason === "string");
  assert.match(reason, /Provider failed/);
  assert.match(reason, /\[redacted URL\]/);
  assert.doesNotMatch(reason, /url-secret|bearer-secret|client-secret|\/config\/private|user:pass/);
  assert.ok(reason.length <= 300);
});

test("routine client errors and errors already logged by Express are not duplicated", () => {
  assert.deepEqual(sendRequest({ status: 404, body: { error: "Not found" } }), []);
  assert.deepEqual(
    sendRequest({ status: 500, body: { error: "Failure" }, alreadyLogged: true }),
    [],
  );
});
