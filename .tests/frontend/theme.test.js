import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import {
  applyThemePreview,
  BUILT_IN_THEMES,
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  getThemeSettings,
  installCustomTheme,
  invalidateThemeCaches,
  replaceCustomTheme,
  THEME_STORAGE_KEY,
  setThemeSelection,
} from "../../frontend/src/utils/theme.js";
import { parseTerminalSexyTheme } from "../../frontend/src/utils/terminalSexyThemes.js";

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

test.afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.localStorage = originalLocalStorage;
  invalidateThemeCaches();
});

test("Aurral keeps the original light and dark palettes", () => {
  const [aurral] = BUILT_IN_THEMES;
  assert.deepEqual(
    {
      chrome: aurral.colors.chrome,
      surface: aurral.colors.surface,
      surfaceRaised: aurral.colors.surfaceRaised,
      surfacePopover: aurral.colors.surfacePopover,
      surfaceHover: aurral.colors.surfaceHover,
      accent: aurral.colors.accent,
      text: aurral.colors.text,
    },
    {
      chrome: "#e5e7eb",
      surface: "#ffffff",
      surfaceRaised: "#f1f1f1",
      surfacePopover: "#e4e4e4",
      surfaceHover: "#d0d0d0",
      accent: "#4d7c0f",
      text: "#171717",
    },
  );
  assert.deepEqual(
    {
      chrome: aurral.variants.dark.chrome,
      surface: aurral.variants.dark.surface,
      surfaceRaised: aurral.variants.dark.surfaceRaised,
      surfacePopover: aurral.variants.dark.surfacePopover,
      surfaceHover: aurral.variants.dark.surfaceHover,
      accent: aurral.variants.dark.accent,
      text: aurral.variants.dark.text,
    },
    {
      chrome: "#000000",
      surface: "#121212",
      surfaceRaised: "#202020",
      surfacePopover: "#2d2d2d",
      surfaceHover: "#424242",
      accent: "#84cc16",
      text: "#ffffff",
    },
  );
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

  setThemeSelection("aurral", "light");
  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(stored.get(THEME_STORAGE_KEY), "light");

  setThemeSelection("aurral", "system");
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(stored.get(THEME_STORAGE_KEY), "system");
});

test("temporary theme previews change the page without changing saved selection", () => {
  const attributes = new Map();
  const stored = new Map();
  const styles = new Map();
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => styles.set(name, value),
        removeProperty: (name) => styles.delete(name),
      },
      removeAttribute: (name) => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, value),
    },
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };

  const preview = {
    id: "terminal-sexy-preview",
    label: "Preview",
    appearance: "dark",
    colors: { ...BUILT_IN_THEMES[0].variants.dark, accent: "#ff00aa" },
  };
  applyThemePreview(preview, "dark");

  assert.equal(styles.get("--aurral-accent"), "#ff00aa");
  assert.equal(attributes.get("data-theme-id"), "terminal-sexy-preview");
  assert.equal(stored.has(THEME_STORAGE_KEY), false);
  assert.deepEqual(getThemeSettings(), { themeId: "aurral", appearance: "system" });
});

test("terminal.sexy ANSI colors become a complete Aurral palette", () => {
  const source = {
    name: "Example Dark",
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    color: [
      "#000000", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#073642", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  };

  const theme = parseTerminalSexyTheme(source);
  assert.equal(theme.label, "Example Dark");
  assert.equal(theme.appearance, "dark");
  assert.equal(theme.colors.chrome, "#1e1e1e");
  assert.equal(theme.colors.accent, "#268bd2");
  assert.equal(theme.colors.danger, "#dc322f");
  assert.equal(Object.keys(theme.colors).length, BUILT_IN_THEMES[0] && Object.keys(BUILT_IN_THEMES[0].colors).length);
});

test("custom themes persist and restore their selected mode", () => {
  const stored = new Map();
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.document = {
    documentElement: {
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {},
      removeAttribute() {},
    },
    querySelectorAll: () => [],
  };

  const theme = installCustomTheme({
    id: "midnight-garden",
    label: "Midnight garden",
    appearance: "dark",
    colors: { accent: "#6cc5ff" },
  });
  assert.equal(stored.has(CUSTOM_THEMES_STORAGE_KEY), true);
  assert.equal(getCustomThemes()[0].id, theme.id);

  replaceCustomTheme({ ...theme, variants: { light: { accent: "#e5b567" } } });
  assert.equal(getCustomThemes()[0].variants.light.accent, "#e5b567");

  setThemeSelection(theme.id, "dark");
  assert.deepEqual(getThemeSettings(), { themeId: theme.id, appearance: "dark" });
});

test("theme bootstrap restores a saved custom palette before app startup", async () => {
  const source = await readFile(new URL("../../frontend/public/theme.js", import.meta.url), "utf8");
  const values = new Map();
  const dataset = {};
  const storage = new Map([
    [THEME_STORAGE_KEY, "terminal-sexy-custom"],
    ["aurralThemeAppearance:v1", "dark"],
    [CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([{
      version: 1,
      id: "terminal-sexy-custom",
      name: "Custom",
      appearance: "light",
      colors: { chrome: "#eeeeee", surface: "#ffffff", accent: "#315fcb" },
      variants: { dark: { chrome: "#101010", surface: "#181818", accent: "#6cc5ff" } },
    }])],
  ]);

  runInNewContext(source, {
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    matchMedia: () => ({ matches: false }),
    document: {
      documentElement: {
        dataset,
        style: {
          setProperty: (name, value) => values.set(name, value),
          removeProperty: () => {},
        },
      },
    },
  });

  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.themeId, "terminal-sexy-custom");
  assert.equal(values.get("--aurral-chrome"), "#101010");
  assert.equal(values.get("--aurral-accent"), "#6cc5ff");
});
