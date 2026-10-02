import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLidarrConnectionState,
  describeRootOverlapWarning,
} from "../../frontend/src/pages/Settings/utils/librarySettings.js";

const connectedLidarr = { enabled: true, url: "http://lidarr:8686", apiKey: "key" };
const reachableHealth = { lidarr: { configured: true, circuitOpen: false } };

test("a connected, reachable Lidarr shows no reconnect state", () => {
  assert.equal(
    describeLidarrConnectionState({ lidarr: connectedLidarr, health: reachableHealth }),
    null,
  );
  assert.equal(
    describeLidarrConnectionState({ lidarr: { ...connectedLidarr, enabled: undefined }, health: reachableHealth }),
    null,
  );
});

test("disabled, unconfigured, and unreachable Lidarr each show a distinct reconnect state", () => {
  const disabled = describeLidarrConnectionState({
    lidarr: { ...connectedLidarr, enabled: false },
    health: { lidarr: { configured: false, circuitOpen: false } },
  });
  const notConfigured = describeLidarrConnectionState({
    lidarr: { enabled: true, url: "http://lidarr:8686", apiKey: "" },
    health: { lidarr: { configured: false, circuitOpen: false } },
  });
  const unreachable = describeLidarrConnectionState({
    lidarr: connectedLidarr,
    health: { lidarr: { configured: true, circuitOpen: true } },
  });

  assert.equal(disabled.reason, "disabled");
  assert.equal(notConfigured.reason, "not-configured");
  assert.equal(unreachable.reason, "unreachable");
  const titles = new Set([disabled.title, notConfigured.title, unreachable.title]);
  assert.equal(titles.size, 3);
  for (const state of [disabled, notConfigured, unreachable]) {
    assert.match(state.message, /Lidarr media stays visible/);
  }
});

test("a disabled Lidarr reports disabled even when its circuit is open", () => {
  const state = describeLidarrConnectionState({
    lidarr: { ...connectedLidarr, enabled: false },
    health: { lidarr: { configured: true, circuitOpen: true } },
  });

  assert.equal(state.reason, "disabled");
});

test("the reconnect state waits for health before reporting Lidarr unreachable", () => {
  assert.equal(describeLidarrConnectionState({ lidarr: connectedLidarr, health: null }), null);
});

test("no overlap warning is shown when the roots are separate", () => {
  assert.equal(describeRootOverlapWarning(undefined), null);
  assert.equal(describeRootOverlapWarning([]), null);
});

test("equal and nested roots produce one allowed-overlap warning naming each Lidarr root", () => {
  const warning = describeRootOverlapWarning([
    { type: "equal", lidarrRoot: "/music", message: "equal" },
    { type: "nested-b-in-a", lidarrRoot: "/downloads/lidarr", message: "nested" },
    { type: "nested-a-in-b", lidarrRoot: "/data", message: "contains" },
  ]);

  assert.match(warning.summary, /allowed/);
  assert.match(warning.summary, /rename, import, or delete/);
  assert.equal(warning.details.length, 3);
  assert.match(warning.details[0], /\/music/);
  assert.match(warning.details[1], /\/downloads\/lidarr/);
  assert.match(warning.details[2], /\/data/);
  assert.equal(new Set(warning.details.map((detail) => detail.replace(/\/\S*/, ""))).size, 3);
});
