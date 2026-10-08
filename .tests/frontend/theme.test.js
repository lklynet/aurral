import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { pickVividColor } from "../../frontend/src/utils/themeColor.js";
import { parseThemeText, serializeThemeFile } from "../../frontend/src/utils/themeImport.js";

const originals = {
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  matchMedia: globalThis.matchMedia,
};

test.afterEach(() => {
  Object.assign(globalThis, originals);
});

function luminance(hex) {
  const channel = (index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(first, second) {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

function createBrowser({ storage = {}, prefersDark = false } = {}) {
  const stored = new Map(Object.entries(storage));
  const variables = new Map();
  const dataset = {};
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.matchMedia = (query) => ({
    matches: query.includes("dark") ? prefersDark : false,
    addEventListener() {},
  });
  globalThis.document = {
    documentElement: {
      dataset,
      style: {
        setProperty: (name, value) => variables.set(name, value),
        removeProperty: (name) => variables.delete(name),
      },
    },
    querySelectorAll: () => [],
  };
  return { stored, variables, dataset };
}

let moduleCount = 0;
const loadTheme = () => import(`../../frontend/src/utils/theme.js?browser=${++moduleCount}`);

const lowContrastTheme = {
  id: "custom-murky",
  name: "Murky",
  dark: { background: "#2b2b2b", text: "#6e6e6e", accent: "#3a3a5a", danger: "#5a2a2a", warning: "#4a4a20" },
};
const lightOnlyTheme = {
  id: "custom-sunny",
  name: "Sunny",
  light: { background: "#fffdf5", accent: "#ffe14d", success: "#a8f0a0" },
};

test("every theme is readable in light and dark, including low-contrast and one-mode themes", async () => {
  createBrowser();
  const { BUILT_IN_THEMES, getThemePalette } = await loadTheme();

  for (const theme of [...BUILT_IN_THEMES, lowContrastTheme, lightOnlyTheme]) {
    for (const mode of ["light", "dark"]) {
      const palette = getThemePalette(theme, mode);
      const label = `${theme.name} ${mode}`;
      assert.equal(luminance(palette.surface) < 0.2, mode === "dark", `${label} surface matches its mode`);
      assert.ok(contrast(palette.text, palette.surfacePopover) >= 7, `${label} text`);
      assert.ok(contrast(palette.textMuted, palette.surfacePopover) >= 4.5, `${label} muted text`);
      assert.ok(contrast(palette.textSubtle, palette.surfacePopover) >= 3, `${label} subtle text`);
      assert.ok(contrast(palette.accent, palette.surface) >= 3, `${label} accent`);
      assert.ok(contrast(palette.accentContrast, palette.accent) >= 4.5, `${label} text on accent`);
      for (const role of ["danger", "warning", "success", "info"]) {
        assert.ok(contrast(palette[role], palette.surfacePopover) >= 4.5, `${label} ${role}`);
      }
    }
  }
});

test("Aurral's own colors come from the stylesheet and other themes are written to the page", async () => {
  const { variables, dataset } = createBrowser({ prefersDark: true });
  const { initializeTheme, selectTheme } = await loadTheme();

  initializeTheme();
  assert.equal(dataset.theme, "dark");
  assert.equal(variables.size, 0);

  selectTheme("nord");
  assert.equal(dataset.themeId, "nord");
  assert.equal(variables.get("--aurral-surface"), "#2e3440");
  assert.equal(variables.size, 21);

  selectTheme("aurral");
  assert.equal(variables.size, 0);
});

test("theme choices from the previous version carry over", async () => {
  const { stored } = createBrowser({
    storage: {
      aurralTheme: "terminal-sexy-1a2b3c4d",
      "aurralThemeAppearance:v1": "dark",
      "aurralThemes:v1": JSON.stringify([{
        version: 1,
        id: "terminal-sexy-1a2b3c4d",
        name: "Old scheme",
        appearance: "light",
        colors: { surface: "#fdf6e3", text: "#586e75", accent: "#268bd2", border: "#58585814" },
        variants: { dark: { surface: "#002b36", text: "#839496", accent: "#268bd2" } },
      }]),
    },
  });
  const { getThemeDocument } = await loadTheme();

  assert.deepEqual(getThemeDocument(), {
    version: 2,
    themeId: "terminal-sexy-1a2b3c4d",
    appearance: "dark",
    matchArtwork: false,
    themes: [{
      id: "terminal-sexy-1a2b3c4d",
      name: "Old scheme",
      light: { background: "#fdf6e3", text: "#586e75", accent: "#268bd2" },
      dark: { background: "#002b36", text: "#839496", accent: "#268bd2" },
    }],
  });
  assert.equal(stored.has("aurralTheme"), false);
  assert.equal(stored.has("aurralThemes:v1"), false);
  assert.ok(stored.has("aurralTheme:v2"));

  createBrowser({ storage: { aurralTheme: "light" } });
  const fresh = await loadTheme();
  assert.equal(fresh.getThemeDocument().themeId, "aurral");
  assert.equal(fresh.getThemeDocument().appearance, "light");
});

test("the account's saved theme wins and is never echoed back", async () => {
  createBrowser();
  const { getThemeDocument, selectTheme, setThemeAccountSaver, syncThemeWithAccount } = await loadTheme();
  const saved = [];
  setThemeAccountSaver((document) => saved.push(document));

  const accountDocument = { version: 2, themeId: "gruvbox", appearance: "light", matchArtwork: true, themes: [] };
  assert.equal(syncThemeWithAccount(7, accountDocument), null);
  assert.deepEqual(getThemeDocument(), accountDocument);
  assert.equal(saved.length, 0);

  selectTheme("nord");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].themeId, "nord");
});

test("a device's theme is uploaded only to the account that made it", async () => {
  createBrowser();
  const first = await loadTheme();
  first.selectTheme("dracula");
  assert.equal(first.syncThemeWithAccount(3, null).themeId, "dracula");

  assert.equal(first.syncThemeWithAccount(4, null), null);
  assert.equal(first.getThemeDocument().themeId, "aurral");
});

test("the startup script paints the saved theme before the app loads", async () => {
  const { stored } = createBrowser();
  const { getThemePalette, findTheme, initializeTheme, selectTheme } = await loadTheme();
  initializeTheme();
  selectTheme("catppuccin");
  const source = await readFile(new URL("../../frontend/public/theme.js", import.meta.url), "utf8");

  const runStartup = (prefersDark) => {
    const variables = new Map();
    const dataset = {};
    runInNewContext(source, {
      localStorage: { getItem: (key) => stored.get(key) ?? null },
      matchMedia: () => ({ matches: prefersDark }),
      document: { documentElement: { dataset, style: { setProperty: (name, value) => variables.set(name, value) } } },
    });
    return { variables, dataset };
  };

  const dark = runStartup(true);
  assert.equal(dark.dataset.theme, "dark");
  assert.equal(dark.variables.get("--aurral-surface"), getThemePalette(findTheme("catppuccin"), "dark").surface);
  assert.equal(dark.variables.get("--aurral-text-muted"), getThemePalette(findTheme("catppuccin"), "dark").textMuted);

  const light = runStartup(false);
  assert.equal(light.dataset.theme, "light");
  assert.equal(light.variables.get("--aurral-surface"), "#eff1f5");

  selectTheme("aurral");
  assert.equal(runStartup(true).variables.size, 0);
});

test("album art tints the theme only while matching is on", async () => {
  const { variables } = createBrowser({ prefersDark: true });
  const { initializeTheme, setArtworkColor, setMatchArtwork } = await loadTheme();
  initializeTheme();

  setArtworkColor("#e0442b");
  assert.equal(variables.size, 0);

  setMatchArtwork(true);
  const accent = variables.get("--aurral-accent");
  const surface = variables.get("--aurral-surface");
  assert.ok(accent && surface);
  assert.notEqual(surface, "#121212");
  assert.ok(Number.parseInt(accent.slice(1, 3), 16) > Number.parseInt(accent.slice(5, 7), 16), "accent stays red");
  assert.ok(contrast(accent, surface) >= 3);

  setArtworkColor(null);
  assert.equal(variables.size, 0);
});

test("previewing a theme changes the page without changing the saved choice", async () => {
  const { dataset, stored } = createBrowser();
  const { findTheme, initializeTheme, previewTheme } = await loadTheme();
  initializeTheme();
  const before = stored.get("aurralTheme:v2");

  previewTheme(findTheme("solarized"), "dark");
  assert.equal(dataset.themeId, "solarized");
  assert.equal(dataset.theme, "dark");
  assert.equal(stored.get("aurralTheme:v2"), before);

  previewTheme(null);
  assert.equal(dataset.themeId, "aurral");
});

test("removing a theme can be undone in place", async () => {
  createBrowser();
  const { getThemeDocument, removeCustomTheme, restoreCustomTheme, saveCustomTheme } = await loadTheme();
  const first = saveCustomTheme({ name: "First", dark: { background: "#101820", accent: "#f2aa4c" } });
  const second = saveCustomTheme({ name: "Second", light: { background: "#fafafa", accent: "#3366ff" } });
  saveCustomTheme({ name: "Third", light: { background: "#ffffff", accent: "#00aa77" } }, { select: false });

  const removed = removeCustomTheme(second.id);
  assert.equal(getThemeDocument().themeId, "aurral");
  assert.deepEqual(getThemeDocument().themes.map((theme) => theme.name), ["First", "Third"]);

  restoreCustomTheme(removed);
  assert.equal(getThemeDocument().themeId, second.id);
  assert.deepEqual(getThemeDocument().themes.map((theme) => theme.id), [first.id, second.id, "custom-third"]);
});

test("a theme whose background does not match its mode is refused", async () => {
  createBrowser();
  const { saveCustomTheme } = await loadTheme();
  assert.throws(
    () => saveCustomTheme({ name: "Backwards", dark: { background: "#ffffff", accent: "#3366ff" } }),
    /dark background/,
  );
});

test("base16 and base24 schemes import in current and older formats", () => {
  const current = parseThemeText(`system: "base24"
name: "Dracula"
variant: "dark"
palette:
  base00: "#282a36"  # Default Background
  base05: "#f8f8f2"  # Default Foreground
  base08: "#ff5555"  # Red
  base0A: "#f1fa8c"
  base0B: "#50fa7b"
  base0C: "#8be9fd"
  base0D: "#bd93f9"  # Blue
`);
  assert.deepEqual(current, {
    name: "Dracula",
    dark: {
      background: "#282a36",
      text: "#f8f8f2",
      accent: "#bd93f9",
      danger: "#ff5555",
      warning: "#f1fa8c",
      success: "#50fa7b",
      info: "#8be9fd",
    },
  });

  const older = parseThemeText('scheme: "Paper"\nbase00: "f2eede"\nbase05: "000000"\nbase0d: "1e6fcc"\n');
  assert.deepEqual(older, { name: "Paper", light: { background: "#f2eede", text: "#000000", accent: "#1e6fcc" } });
});

test("Aurral theme files round-trip and old theme files still import", () => {
  const theme = { id: "custom-dusk", name: "Dusk", dark: { background: "#1b1d2a", accent: "#c3a6ff" } };
  assert.deepEqual(parseThemeText(serializeThemeFile(theme)), { name: "Dusk", dark: theme.dark });

  const legacy = parseThemeText(JSON.stringify({
    version: 1,
    name: "Legacy",
    appearance: "dark",
    colors: { surface: "#181818", text: "#d8d8d8", accent: "#7cafc2", border: "#d8d8d814" },
  }));
  assert.deepEqual(legacy, { name: "Legacy", dark: { background: "#181818", text: "#d8d8d8", accent: "#7cafc2" } });

  assert.throws(() => parseThemeText("hello there"), /base16/);
  assert.throws(() => parseThemeText('{"version": 9, "name": "Future"}'), /version/);
});

test("album art matching picks the vivid color, not the average", () => {
  const pixels = [];
  const push = (count, rgb) => {
    for (let index = 0; index < count; index += 1) pixels.push(...rgb, 255);
  };
  push(700, [128, 128, 128]);
  push(250, [30, 90, 230]);
  push(50, [220, 40, 40]);

  const color = pickVividColor(pixels);
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  assert.ok(b > r && b > g, `${color} is blue`);

  assert.equal(pickVividColor(Array.from({ length: 400 }, (_, index) => (index % 4 === 3 ? 255 : 90))), null);
});
