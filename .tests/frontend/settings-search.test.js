import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SETTINGS_SEARCH_ITEMS,
  searchSettingsItems,
} from "../../frontend/src/pages/Settings/settingsTabsConfig.js";

const COMPONENTS_BY_TAB = {
  tasks: ["SettingsTasksTab.jsx"],
  lidarr: ["LidarrSettingsModalContent.jsx"],
  indexers: ["SettingsIndexersSection.jsx"],
  "download-clients": [
    "SettingsDownloadClientsSection.jsx",
    "QualityProfileModal.jsx",
    "PathMappingModal.jsx",
  ],
  playback: ["SettingsPlaybackSection.jsx", "NavidromePathMappingModal.jsx"],
  connect: ["SettingsConnectTab.jsx"],
  "rss-news": ["SettingsRssNewsTab.jsx"],
  discover: ["SettingsDiscoverTab.jsx"],
  users: ["SettingsUsersTab.jsx"],
};

const SEARCHED_COMPONENTS =
  "SettingsArrFieldSet|SettingsArrFormGroup|SettingsModalSection|SettingsModalField|" +
  "SettingsModalToggle|IntegrationCard|SettingsIntegrationModal|SystemSection|SystemRow";
const VISIBLE_LABEL = new RegExp(
  `<(?:${SEARCHED_COMPONENTS})\\b[^>]*?\\b(?:legend|label|title)="([^"]+)"`,
  "g",
);

test("settings search covers visible settings labels", async () => {
  const missing = [];
  for (const [tab, files] of Object.entries(COMPONENTS_BY_TAB)) {
    for (const file of files) {
      const source = await readFile(
        new URL(`../../frontend/src/pages/Settings/components/${file}`, import.meta.url),
        "utf8",
      );
      for (const [, label] of source.matchAll(VISIBLE_LABEL)) {
        if (!searchSettingsItems(label).some((item) => item.id === tab)) {
          missing.push(`${tab}: ${label} (${file})`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("settings search includes the hidden metadata route", () => {
  assert.ok(
    SETTINGS_SEARCH_ITEMS.some(
      (item) => item.id === "metadata" && item.searchText.includes("base url"),
    ),
  );
});

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
