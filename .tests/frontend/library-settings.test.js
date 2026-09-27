import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLibraryManagerControl,
  describeLidarrConnectionState,
} from "../../frontend/src/pages/Settings/utils/librarySettings.js";

const optionById = (control, id) => control.options.find((option) => option.id === id);

test("an unsaved manager preference shows the resolved default without a reset action", () => {
  const control = describeLibraryManagerControl({
    libraryOwner: { defaultLibraryOwner: "lidarr", storedDefaultLibraryOwner: null },
    lidarrConfigured: true,
  });

  assert.equal(control.value, "lidarr");
  assert.equal(control.statusLabel, "Default");
  assert.equal(control.canUseDefault, false);
  assert.equal(optionById(control, "lidarr").disabled, false);
  assert.equal(control.lidarrUnavailableReason, null);
});

test("a saved manager preference is labelled saved and can return to the default", () => {
  const control = describeLibraryManagerControl({
    libraryOwner: { defaultLibraryOwner: "aurral", storedDefaultLibraryOwner: "aurral" },
    lidarrConfigured: true,
  });

  assert.equal(control.value, "aurral");
  assert.equal(control.statusLabel, "Saved");
  assert.equal(control.canUseDefault, true);
});

test("Lidarr cannot be chosen while Lidarr is not configured and the reason is stated", () => {
  const control = describeLibraryManagerControl({
    libraryOwner: { defaultLibraryOwner: "aurral", storedDefaultLibraryOwner: null },
    lidarrConfigured: false,
  });

  assert.equal(control.value, "aurral");
  assert.equal(optionById(control, "aurral").disabled, false);
  assert.equal(optionById(control, "lidarr").disabled, true);
  assert.match(control.lidarrUnavailableReason, /Lidarr/);
});

test("a saved Lidarr preference is kept and explained while Lidarr is not configured", () => {
  const unsaved = describeLibraryManagerControl({
    libraryOwner: { defaultLibraryOwner: "aurral", storedDefaultLibraryOwner: null },
    lidarrConfigured: false,
  });
  const control = describeLibraryManagerControl({
    libraryOwner: { defaultLibraryOwner: "lidarr", storedDefaultLibraryOwner: "lidarr" },
    lidarrConfigured: false,
  });

  assert.equal(control.value, "lidarr");
  assert.equal(control.statusLabel, "Saved");
  assert.equal(control.canUseDefault, true);
  assert.equal(optionById(control, "lidarr").disabled, true);
  assert.notEqual(control.lidarrUnavailableReason, unsaved.lidarrUnavailableReason);
});

test("the control has no selection until the preference loads", () => {
  const control = describeLibraryManagerControl({ libraryOwner: undefined, lidarrConfigured: true });

  assert.equal(control.value, null);
  assert.equal(control.statusLabel, null);
  assert.equal(control.canUseDefault, false);
});

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
