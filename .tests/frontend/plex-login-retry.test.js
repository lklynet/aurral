import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Plex login polling continues after a retryable validation failure", () => {
  const source = fs.readFileSync("frontend/src/pages/Login.jsx", "utf8");
  assert.match(source, /err\.response\?\.data\?\.retryable\) continue/);
});
