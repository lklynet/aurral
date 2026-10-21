import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS_TAB,
  normalizeSettingsTabId,
  searchSettingsItems,
} from "../../frontend/src/pages/Settings/settingsTabsConfig.js";

test("custom settings layouts expose their fields to search", () => {
  const expected = {
    system: ["runtime", "version", "database path", "api key"],
    "storage-health": ["disk space", "free space", "run checks"],
    metadata: ["metadata server", "base url", "brainzmash"],
  };

  for (const [tab, queries] of Object.entries(expected)) {
    for (const query of queries) {
      assert.ok(
        searchSettingsItems(query).some((item) => item.id === tab),
        `${tab} search metadata is missing "${query}"`,
      );
    }
  }
});

test("settings search handles punctuation and non-adjacent terms", () => {
  assert.ok(searchSettingsItems("auto login").some((item) => item.id === "users"));
  assert.ok(searchSettingsItems("yt dlp staging").some((item) => item.id === "download-clients"));
  assert.ok(searchSettingsItems("quality cutoff").some((item) => item.id === "download-clients"));
  assert.ok(searchSettingsItems("m4a 320").some((item) => item.id === "download-clients"));
});

test("settings tab ids that name object properties open the default tab", () => {
  for (const tabId of ["constructor", "__proto__", "toString"]) {
    assert.equal(normalizeSettingsTabId(tabId), DEFAULT_SETTINGS_TAB);
  }
  assert.equal(normalizeSettingsTabId("integrations"), "lidarr");
});
