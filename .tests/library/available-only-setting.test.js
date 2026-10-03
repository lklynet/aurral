import assert from "node:assert/strict";
import test from "node:test";

import { resolveAvailableOnly } from "../../backend/routes/library/handlers/libraryIndex.js";

const connected = (extra = {}) => ({
  integrations: { lidarr: { url: "http://lidarr:8686", apiKey: "key", ...extra } },
});

test("explicit availableOnly query param overrides the configured default", () => {
  assert.equal(resolveAvailableOnly("true", connected({ availableOnly: false })), true);
  assert.equal(resolveAvailableOnly("false", connected({ availableOnly: true })), false);
  assert.equal(resolveAvailableOnly("true", {}), true);
});

test("with Lidarr connected, the setting decides and defaults to on", () => {
  assert.equal(resolveAvailableOnly(undefined, connected({ availableOnly: true })), true);
  assert.equal(resolveAvailableOnly(undefined, connected({ availableOnly: false })), false);
  assert.equal(resolveAvailableOnly(undefined, connected()), true);
  assert.equal(resolveAvailableOnly(undefined, connected({ enabled: false })), true);
});

test("without a Lidarr connection, nothing is hidden", () => {
  assert.equal(resolveAvailableOnly(undefined, undefined), false);
  assert.equal(resolveAvailableOnly(undefined, { integrations: { lidarr: { availableOnly: true } } }), false);
});
