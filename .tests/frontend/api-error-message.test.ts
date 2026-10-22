import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { getApiErrorMessage } from "../../frontend/src/pages/onboardingUtils.tsx";

const failedRequest = (data: unknown) =>
  Object.assign(new Error("Request failed with status code 502"), {
    response: { status: 502, data },
  });

test("an error message from the server is shown", () => {
  const error = failedRequest({ error: "Lidarr unreachable", message: "Connection refused" });

  assert.equal(getApiErrorMessage(error, "fallback"), "Connection refused");
});

test("the server error text is used when there is no message", () => {
  const error = failedRequest({ error: "Lidarr unreachable" });

  assert.equal(getApiErrorMessage(error, "fallback"), "Lidarr unreachable");
});

test("an object error body from a proxy falls back to the request error text", () => {
  const error = failedRequest({ error: { code: "UPSTREAM_DOWN" } });

  assert.equal(getApiErrorMessage(error, "fallback"), "Request failed with status code 502");
});

test("a failure with no response body uses the fallback", () => {
  assert.equal(getApiErrorMessage("offline", "fallback"), "fallback");
});
