import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { normalizeBasePath, stripBasePath } from "../../frontend/src/utils/basePath.ts";

test("normalizeBasePath returns / for root and empty", () => {
  assert.equal(normalizeBasePath("/"), "/");
  assert.equal(normalizeBasePath(""), "/");
});

test("normalizeBasePath strips trailing slash and adds leading slash", () => {
  assert.equal(normalizeBasePath("/app/"), "/app");
  assert.equal(normalizeBasePath("app"), "/app");
});

test("stripBasePath gives the in-app route under a subpath install", () => {
  assert.equal(stripBasePath("/library/albums", "/"), "/library/albums");
  assert.equal(stripBasePath("/aurral/library/albums", "/aurral"), "/library/albums");
  assert.equal(stripBasePath("/aurral", "/aurral"), "/");
});
