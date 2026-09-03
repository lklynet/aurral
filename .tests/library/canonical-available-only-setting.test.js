import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanonicalAvailableOnly } from "../../backend/routes/library/handlers/canonical.js";

test("explicit availableOnly query param overrides the configured default", () => {
  const settingsOn = { integrations: { lidarr: { availableOnly: true } } };
  const settingsOff = { integrations: { lidarr: { availableOnly: false } } };

  assert.equal(resolveCanonicalAvailableOnly("true", settingsOff), true);
  assert.equal(resolveCanonicalAvailableOnly("false", settingsOn), false);
});

test("absent availableOnly query param follows the lidarr setting", () => {
  assert.equal(
    resolveCanonicalAvailableOnly(undefined, { integrations: { lidarr: { availableOnly: true } } }),
    true,
  );
  assert.equal(
    resolveCanonicalAvailableOnly(undefined, { integrations: { lidarr: { availableOnly: false } } }),
    false,
  );
});

test("absent query param and unset setting defaults to available-only (on)", () => {
  assert.equal(resolveCanonicalAvailableOnly(undefined, undefined), true);
  assert.equal(resolveCanonicalAvailableOnly(undefined, {}), true);
  assert.equal(resolveCanonicalAvailableOnly(undefined, { integrations: {} }), true);
  assert.equal(
    resolveCanonicalAvailableOnly(undefined, { integrations: { lidarr: {} } }),
    true,
  );
});
