import test from "node:test";
import assert from "node:assert/strict";

import {
  THEME_STORAGE_KEY,
  getThemePreference,
  normalizeThemePreference,
  setThemePreference,
} from "../../frontend/src/utils/theme.js";

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

test.afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.localStorage = originalLocalStorage;
});

test("theme preferences default invalid stored values to system", () => {
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("sepia"), "system");

  globalThis.localStorage = { getItem: () => "sepia" };
  assert.equal(getThemePreference(), "system");
});

test("theme preferences persist explicit themes and clear the system override", () => {
  const attributes = new Map();
  const stored = new Map();
  globalThis.document = {
    documentElement: {
      removeAttribute: (name) => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, value),
    },
  };
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };

  assert.equal(setThemePreference("light"), "light");
  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(stored.get(THEME_STORAGE_KEY), "light");

  assert.equal(setThemePreference("system"), "system");
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(stored.get(THEME_STORAGE_KEY), "system");
});
