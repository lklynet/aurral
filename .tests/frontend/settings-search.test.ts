import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  resolveSettingsPath,
  searchSettings,
} from "../../frontend/src/pages/Settings/settingsSections.ts";

const findsSection = (query: string, section: string, canManageServer = true) =>
  searchSettings(query, canManageServer).some((item) => item.section.id === section);

test("settings search finds fields by keyword, punctuation, and non-adjacent terms", () => {
  const expected = {
    status: ["runtime", "version", "database path", "disk space", "run checks"],
    general: ["api key", "date and time format"],
    metadata: ["metadata server", "base url", "brainzmash"],
    users: ["auto login"],
    downloads: ["yt dlp staging", "quality cutoff", "m4a 320"],
    listening: ["listenbrainz", "scrobbling"],
  };

  for (const [section, queries] of Object.entries(expected)) {
    for (const query of queries) {
      assert.ok(findsSection(query, section), `${section} search is missing "${query}"`);
    }
  }
});

test("settings search only shows server settings to people who can manage the server", () => {
  assert.ok(findsSection("scrobbling", "listening", false));
  assert.equal(
    searchSettings("api key", false).some((item) => item.section.group === "server"),
    false,
  );
  assert.equal(findsSection("metadata server", "metadata", false), false);
});

test("settings paths fall back to the default section for unknown or forbidden ids", () => {
  assert.deepEqual(resolveSettingsPath("downloads/slskd", true), {
    section: resolveSettingsPath("downloads", true).section,
    item: "slskd",
  });
  assert.equal(resolveSettingsPath("downloads", false).section.id, "profile");
  assert.equal(resolveSettingsPath("", true).section.id, "general");
  assert.equal(resolveSettingsPath(null, false).section.id, "profile");
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(resolveSettingsPath(inherited, true).section.id, "general");
  }
});
