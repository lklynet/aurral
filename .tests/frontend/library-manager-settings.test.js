import assert from "node:assert/strict";
import test from "node:test";

import { describeLibraryManagerControl } from "../../frontend/src/pages/Settings/utils/libraryManagerSettings.js";

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
