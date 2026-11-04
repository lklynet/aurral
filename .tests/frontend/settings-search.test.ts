import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  SETTINGS_SEARCH_ITEMS,
  resolveSettingsPath,
  searchSettings,
  type SettingsSearchContext,
} from "../../frontend/src/pages/Settings/settingsSections.ts";

const everything: SettingsSearchContext = {
  canManageServer: true,
  lidarrConnected: true,
  signInMethods: true,
  sidebarArt: true,
};

const paths = (query: string, context = everything) =>
  searchSettings(query, context).map((result) => result.path);

test("every searchable group is a group title the settings pages render", () => {
  const settingsDir = path.resolve(import.meta.dirname, "../../frontend/src/pages/Settings");
  const titles = new Set(
    readdirSync(settingsDir, { recursive: true })
      .filter((file) => String(file).endsWith(".tsx"))
      .flatMap((file) =>
        readFileSync(path.join(settingsDir, String(file)), "utf8")
          .split("<SettingsGroup")
          .slice(1)
          .map((tag) => /^[^<]*?\btitle="([^"]+)"/.exec(tag)?.[1]),
      ),
  );
  const missing = SETTINGS_SEARCH_ITEMS.flatMap((item) =>
    item.group && !titles.has(item.group) ? [`${item.section.id}: ${item.group}`] : [],
  );
  assert.deepEqual(missing, []);
});

test("settings search opens services on their own page and groups on their section", () => {
  assert.deepEqual(paths("slskd"), ["downloads/slskd"]);
  assert.deepEqual(paths("soulseek"), ["downloads/slskd"]);
  assert.ok(paths("sso").includes("users"));
  assert.equal(
    searchSettings("library folder", everything).find((result) => result.path === "library")?.group,
    "Library folder",
  );
});

test("settings search lists page names, then other names, then keyword matches", () => {
  assert.deepEqual(paths("lidarr"), ["profile", "library/lidarr", "library"]);
  assert.equal(paths("status")[0], "status");
});

test("settings search hides groups the page would not show", () => {
  const hidden = { ...everything, lidarrConnected: false, signInMethods: false };
  assert.equal(paths("lidarr defaults", hidden).length, 0);
  assert.equal(paths("sign in methods", hidden).length, 0);
  const member = { ...hidden, canManageServer: false };
  assert.ok(paths("api key", member).includes("profile"));
  assert.ok(!paths("api key", member).includes("general"));
  assert.equal(paths("metadata server", member).length, 0);
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
