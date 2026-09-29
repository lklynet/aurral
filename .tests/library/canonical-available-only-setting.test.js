import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanonicalAvailableOnly } from "../../backend/routes/library/handlers/canonical.js";

const connected = (extra = {}) => ({
  integrations: { lidarr: { url: "http://lidarr:8686", apiKey: "key", ...extra } },
});

test("explicit availableOnly query param overrides the configured default", () => {
  assert.equal(resolveCanonicalAvailableOnly("true", connected({ availableOnly: false })), true);
  assert.equal(resolveCanonicalAvailableOnly("false", connected({ availableOnly: true })), false);
  assert.equal(resolveCanonicalAvailableOnly("true", {}), true);
});

test("with Lidarr connected, the setting decides and defaults to on", () => {
  assert.equal(resolveCanonicalAvailableOnly(undefined, connected({ availableOnly: true })), true);
  assert.equal(resolveCanonicalAvailableOnly(undefined, connected({ availableOnly: false })), false);
  assert.equal(resolveCanonicalAvailableOnly(undefined, connected()), true);
  assert.equal(resolveCanonicalAvailableOnly(undefined, connected({ enabled: false })), true);
});

test("without a Lidarr connection, nothing is hidden", () => {
  assert.equal(resolveCanonicalAvailableOnly(undefined, undefined), false);
  assert.equal(resolveCanonicalAvailableOnly(undefined, { integrations: { lidarr: { availableOnly: true } } }), false);
});
