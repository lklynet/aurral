import assert from "node:assert/strict";
import test from "node:test";

import {
  filterByCapabilities,
  getCapabilityForPath,
  getUnavailableRouteRedirect,
  hasAppCapability,
} from "../frontend/src/utils/appCapabilities.js";
import {
  getAvailableSettingsTabs,
  searchSettingsItems,
} from "../frontend/src/pages/Settings/settingsTabsConfig.js";

const DIET_CAPABILITIES = {
  profile: "diet",
  fullFeatures: false,
  localLibrary: false,
  playback: false,
  flows: false,
};

test("capability checks stay backwards-compatible with bootstrap payloads without flags", () => {
  assert.equal(hasAppCapability({}, "playback"), true);
  assert.equal(hasAppCapability({ playback: false }, "playback"), false);
});

test("Diet maps Full-only routes to an explicit capability", () => {
  assert.equal(getCapabilityForPath("/library"), "localLibrary");
  assert.equal(getCapabilityForPath("/library/album/123"), "localLibrary");
  assert.equal(getCapabilityForPath("/flows"), "flows");
  assert.equal(getCapabilityForPath("/playlists"), "flows");
  assert.equal(getCapabilityForPath("/activity/missing"), "flows");
  assert.equal(getCapabilityForPath("/artist/artist-mbid"), null);

  assert.equal(getUnavailableRouteRedirect("/library", DIET_CAPABILITIES), "/");
  assert.equal(getUnavailableRouteRedirect("/flows", DIET_CAPABILITIES), "/");
  assert.equal(getUnavailableRouteRedirect("/activity/queue", DIET_CAPABILITIES), null);
  assert.equal(getUnavailableRouteRedirect("/artist/artist-mbid", DIET_CAPABILITIES), null);
});

test("capability-filtered navigation removes only unavailable entries", () => {
  const items = [
    { id: "discover" },
    { id: "library", requiredCapabilities: ["localLibrary"] },
    { id: "flows", requiredCapabilities: ["flows"] },
    { id: "lidarr" },
  ];

  assert.deepEqual(
    filterByCapabilities(items, DIET_CAPABILITIES).map((item) => item.id),
    ["discover", "lidarr"],
  );
});

test("Diet settings keep shared connections while hiding Full-only controls", () => {
  assert.deepEqual(
    getAvailableSettingsTabs(DIET_CAPABILITIES).map((tab) => tab.id),
    ["system", "lidarr", "connect", "discover", "users"],
  );
  assert.equal(searchSettingsItems("webhook", DIET_CAPABILITIES).length, 0);
  assert.ok(searchSettingsItems("last.fm", DIET_CAPABILITIES).length > 0);
  assert.equal(hasAppCapability(DIET_CAPABILITIES, "playback"), false);
});
