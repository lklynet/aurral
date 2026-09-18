import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_PROFILES,
  getAppCapabilities,
  resolveAppProfile,
} from "../backend/config/app-profile.js";

test("the default application profile is Full", () => {
  assert.equal(resolveAppProfile({}), APP_PROFILES.FULL);
});

test("only the Diet profile can be selected explicitly", () => {
  assert.equal(
    resolveAppProfile({ AURRAL_PROFILE: "diet" }),
    APP_PROFILES.DIET,
  );
  assert.equal(
    resolveAppProfile({ AURRAL_PROFILE: "unexpected" }),
    APP_PROFILES.FULL,
  );
});

test("Diet keeps shared Lidarr and Last.fm capabilities without media features", () => {
  assert.deepEqual(getAppCapabilities(APP_PROFILES.DIET), {
    profile: APP_PROFILES.DIET,
    auth: true,
    search: true,
    requests: true,
    lidarr: true,
    lastfm: true,
    fullFeatures: false,
    localLibrary: false,
    downloads: false,
    playback: false,
    flows: false,
    backgroundWorkers: false,
    matcher: false,
  });
});

test("Full keeps the existing media capabilities", () => {
  const capabilities = getAppCapabilities(APP_PROFILES.FULL);
  assert.equal(capabilities.profile, APP_PROFILES.FULL);
  assert.equal(capabilities.localLibrary, true);
  assert.equal(capabilities.fullFeatures, true);
  assert.equal(capabilities.downloads, true);
  assert.equal(capabilities.playback, true);
  assert.equal(capabilities.flows, true);
  assert.equal(capabilities.backgroundWorkers, true);
  assert.equal(capabilities.matcher, true);
});
