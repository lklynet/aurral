import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { normalizeBasePath } from "../../frontend/src/utils/basePath.js";

test("normalizeBasePath returns / for root and empty", () => {
  assert.equal(normalizeBasePath("/"), "/");
  assert.equal(normalizeBasePath(""), "/");
});

test("normalizeBasePath strips trailing slash and adds leading slash", () => {
  assert.equal(normalizeBasePath("/app/"), "/app");
  assert.equal(normalizeBasePath("app"), "/app");
});
