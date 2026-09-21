import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createRequestFailureLogger } from "../../backend/middleware/requestFailureLogger.js";

function sendRequest({ status, body, route = "/sync", alreadyLogged = false }) {
  const events = [];
  const res = new EventEmitter();
  res.statusCode = status;
  res.locals = { failureLogged: alreadyLogged };
  res.json = (value) => value;
  const req = {
    method: "POST",
    baseUrl: "/api/playlists",
    route: { path: route },
    path: "/api/playlists/sync",
    originalUrl: "/api/playlists/sync?token=secret",
  };
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
  assert.deepEqual(events, [["http", "Request failed", {
    method: "POST",
    endpoint: "/api/playlists/sync",
    status: 500,
    reason: "Spotify request timed out",
  }]]);
});

test("failed API response reasons redact credentials and file paths before logging", () => {
  const events = sendRequest({
    status: 502,
    body: {
      message: "Provider failed at https://user:pass@example.test/api?token=url-secret " +
        "Authorization: Bearer bearer-secret clientSecret=client-secret " +
        "while reading /config/private/provider.json",
    },
  });
  const reason = events[0][2].reason;
  assert.match(reason, /Provider failed/);
  assert.match(reason, /\[redacted URL\]/);
  assert.doesNotMatch(reason, /url-secret|bearer-secret|client-secret|\/config\/private|user:pass/);
  assert.ok(reason.length <= 300);
});

test("routine client errors and errors already logged by Express are not duplicated", () => {
  assert.deepEqual(sendRequest({ status: 404, body: { error: "Not found" } }), []);
  assert.deepEqual(sendRequest({ status: 500, body: { error: "Failure" }, alreadyLogged: true }), []);
});
