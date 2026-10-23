import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  describeLidarrConnectionState,
  describeRootOverlapWarning,
} from "../../frontend/src/pages/Settings/utils/librarySettings.ts";

const connectedLidarr = { enabled: true, url: "http://lidarr:8686", apiKey: "key" };
const reachableHealth = { lidarr: { circuitOpen: false } };

test("a connected, reachable Lidarr shows no reconnect state", () => {
  assert.equal(
    describeLidarrConnectionState({ lidarr: connectedLidarr, health: reachableHealth }),
    null,
  );
  assert.equal(
    describeLidarrConnectionState({
      lidarr: { ...connectedLidarr, enabled: undefined },
      health: reachableHealth,
    }),
    null,
  );
});

test("disabled and unreachable Lidarr show distinct states, and an unset Lidarr shows none", () => {
  const disabled = describeLidarrConnectionState({
    lidarr: { ...connectedLidarr, enabled: false },
    health: { lidarr: { circuitOpen: false } },
  });
  assert.ok(disabled != null);
  const notConfigured = describeLidarrConnectionState({
    lidarr: { enabled: true, url: "http://lidarr:8686", apiKey: "" },
    health: { lidarr: { circuitOpen: false } },
  });
  const unreachable = describeLidarrConnectionState({
    lidarr: connectedLidarr,
    health: { lidarr: { circuitOpen: true } },
  });
  assert.ok(unreachable != null);

  assert.equal(disabled.reason, "disabled");
  assert.equal(notConfigured, null);
  assert.equal(unreachable.reason, "unreachable");
  assert.notEqual(disabled.title, unreachable.title);
});

test("a disabled Lidarr reports disabled even when its circuit is open", () => {
  const state = describeLidarrConnectionState({
    lidarr: { ...connectedLidarr, enabled: false },
    health: { lidarr: { circuitOpen: true } },
  });
  assert.ok(state != null);

  assert.equal(state.reason, "disabled");
});

test("the reconnect state waits for health before reporting Lidarr unreachable", () => {
  assert.equal(describeLidarrConnectionState({ lidarr: connectedLidarr, health: null }), null);
});

test("equal and nested roots produce one overlap warning naming each Lidarr root", () => {
  const warning = describeRootOverlapWarning([
    { type: "equal", lidarrRoot: "/music", message: "equal" },
    { type: "nested-b-in-a", lidarrRoot: "/downloads/lidarr", message: "nested" },
    { type: "nested-a-in-b", lidarrRoot: "/data", message: "contains" },
  ]);
  assert.ok(warning != null);

  assert.ok(warning.summary);
  assert.equal(warning.details.length, 3);
  assert.match(warning.details[0], /\/music/);
  assert.match(warning.details[1], /\/downloads\/lidarr/);
  assert.match(warning.details[2], /\/data/);
  assert.equal(
    new Set(warning.details.map((detail: string) => detail.replace(/\/\S*/, ""))).size,
    3,
  );
});
