import { test, afterEach, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Theme = Parameters<typeof import("../../frontend/src/utils/theme.ts").getThemePalette>[0];
type ThemeDocument = ReturnType<
  typeof import("../../frontend/src/utils/theme.ts").getThemeDocument
>;
import { pickVividColor } from "../../frontend/src/utils/themeColor.ts";
import { parseThemeText, serializeThemeFile } from "../../frontend/src/utils/themeImport.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function luminance(hex: string) {
  const channel = (index: number) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(first: string, second: string) {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

function createBrowser({
  storage = {},
  prefersDark = false,
}: { storage?: Record<string, string>; prefersDark?: boolean } = {}) {
  const stored = new Map(Object.entries(storage));
  const variables = new Map<string, string>();
  const dataset: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, String(value)),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") ? prefersDark : false,
    addEventListener() {},
  }));
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      style: {
        setProperty: (name: string, value: string) => variables.set(name, value),
        removeProperty: (name: string) => variables.delete(name),
      },
    },
    querySelectorAll: () => [],
  });
  return { stored, variables, dataset };
}

const loadTheme = () => {
  vi.resetModules();
  return import("../../frontend/src/utils/theme.ts");
};

const lowContrastTheme: Theme = {
  id: "custom-murky",
  name: "Murky",
  dark: {
    background: "#2b2b2b",
    text: "#6e6e6e",
    accent: "#3a3a5a",
    danger: "#5a2a2a",
    warning: "#4a4a20",
  },
};
const lightOnlyTheme: Theme = {
  id: "custom-sunny",
  name: "Sunny",
  light: { background: "#fffdf5", accent: "#ffe14d", success: "#a8f0a0" },
};

test("every theme is readable in light and dark, including low-contrast and one-mode themes", async () => {
  createBrowser();
  const { BUILT_IN_THEMES, getThemePalette } = await loadTheme();

  for (const theme of [...BUILT_IN_THEMES, lowContrastTheme, lightOnlyTheme]) {
    for (const mode of ["light", "dark"] as const) {
      const palette = getThemePalette(theme, mode);
      const label = `${theme.name} ${mode}`;
      assert.equal(
        luminance(palette.surface) < 0.2,
        mode === "dark",
        `${label} surface matches its mode`,
      );
      assert.ok(contrast(palette.text, palette.surfacePopover) >= 7, `${label} text`);
      assert.ok(contrast(palette.textMuted, palette.surfacePopover) >= 4.5, `${label} muted text`);
      assert.ok(contrast(palette.textSubtle, palette.surfacePopover) >= 3, `${label} subtle text`);
      assert.ok(contrast(palette.accent, palette.surface) >= 3, `${label} accent`);
      assert.ok(contrast(palette.accentContrast, palette.accent) >= 4.5, `${label} text on accent`);
      for (const role of ["danger", "warning", "success", "info"] as const) {
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
      "aurralThemes:v1": JSON.stringify([
        {
          version: 1,
          id: "terminal-sexy-1a2b3c4d",
          name: "Old scheme",
          appearance: "light",
          colors: { surface: "#fdf6e3", text: "#586e75", accent: "#268bd2", border: "#58585814" },
          variants: { dark: { surface: "#002b36", text: "#839496", accent: "#268bd2" } },
        },
      ]),
    },
  });
  const { getThemeDocument } = await loadTheme();

  assert.deepEqual(getThemeDocument(), {
    version: 2,
    themeId: "terminal-sexy-1a2b3c4d",
    appearance: "dark",
    matchArtwork: false,
    themes: [
      {
        id: "terminal-sexy-1a2b3c4d",
        name: "Old scheme",
        light: { background: "#fdf6e3", text: "#586e75", accent: "#268bd2" },
        dark: { background: "#002b36", text: "#839496", accent: "#268bd2" },
      },
    ],
  });
  assert.equal(stored.has("aurralTheme"), false);
  assert.equal(stored.has("aurralThemes:v1"), false);
  assert.ok(stored.has("aurralTheme:v2"));

  createBrowser({ storage: { aurralTheme: "light" } });
  const fresh = await loadTheme();
  assert.equal(fresh.getThemeDocument().themeId, "aurral");
  assert.equal(fresh.getThemeDocument().appearance, "light");

  const legacyTheme = (index: number) => ({
    version: 1,
    id: index === 0 ? "nord" : `old-theme-${index}`,
    name: index === 0 ? "Nord" : `Old theme ${index}`,
    appearance: "dark",
    colors: { surface: "#101820", text: "#e0e0e0", accent: index === 0 ? "#ff00aa" : "#f2aa4c" },
  });
  const crowded = createBrowser({
    storage: {
      aurralTheme: "nord",
      "aurralThemes:v1": JSON.stringify(
        Array.from({ length: 55 }, (_, index) => legacyTheme(index)),
      ),
    },
  });
  const migrated = (await loadTheme()).getThemeDocument();
  const selected = migrated.themes.find((theme) => theme.id === migrated.themeId);
  assert.ok(selected != null);
  assert.equal(selected.name, "Nord");
  assert.equal(selected.dark?.accent, "#ff00aa");
  assert.notEqual(selected.id, "nord");
  assert.ok(
    crowded.stored.has("aurralThemes:v1"),
    "the old copy stays while some themes did not fit",
  );
});

function fakeAccount(initial: ThemeDocument | null = null) {
  const account = { stored: initial, saves: [] as ThemeDocument[], loads: [] as (() => void)[] };
  return {
    ...account,
    get stored() {
      return account.stored;
    },
    loadAccountTheme: () =>
      new Promise<{ theme: ThemeDocument | null }>((resolve) => {
        account.loads.push(() => resolve({ theme: account.stored }));
      }),
    saveAccountTheme: async (document: ThemeDocument) => {
      account.saves.push(document);
      account.stored = document;
    },
    answer: async () => {
      while (!account.loads.length) await new Promise<void>((resolve) => setImmediate(resolve));
      const answer = account.loads.shift();
      assert.ok(answer);
      answer();
    },
  };
}

test("the account's saved theme wins and is never echoed back", async () => {
  createBrowser();
  const { getThemeDocument, selectTheme, startThemeAccountSync } = await loadTheme();
  const accountDocument: ThemeDocument = {
    version: 2,
    themeId: "gruvbox",
    appearance: "light",
    matchArtwork: true,
    themes: [],
  };
  const account = fakeAccount(accountDocument);
  const sync = startThemeAccountSync({ userId: 7, ...account });
  await account.answer();
  await sync.ready;

  assert.deepEqual(getThemeDocument(), accountDocument);
  assert.equal(account.saves.length, 0);

  selectTheme("nord");
  await sync.refresh;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    account.saves.map((document) => document.themeId),
    ["nord"],
  );
});

test("a device's theme is uploaded only to the account that made it", async () => {
  createBrowser();
  const theme = await loadTheme();
  theme.selectTheme("dracula");

  const owner = fakeAccount();
  const ownerSync = theme.startThemeAccountSync({ userId: 3, ...owner });
  await owner.answer();
  await ownerSync.ready;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(owner.saves[0]?.themeId, "dracula");
  ownerSync.stop();

  const other = fakeAccount();
  const otherSync = theme.startThemeAccountSync({ userId: 4, ...other });
  await other.answer();
  await otherSync.ready;
  assert.equal(other.saves.length, 0);
  assert.equal(theme.getThemeDocument().themeId, "aurral");
});

test("a refresh that started before a local change does not undo it", async () => {
  createBrowser();
  const theme = await loadTheme();
  const account = fakeAccount({
    version: 2,
    themeId: "gruvbox",
    appearance: "dark",
    matchArtwork: false,
    themes: [],
  });
  const sync = theme.startThemeAccountSync({ userId: 5, ...account });
  await account.answer();
  await sync.ready;

  const refreshing = sync.refresh();
  theme.selectTheme("nord");
  await account.answer();
  await refreshing;

  assert.equal(theme.getThemeDocument().themeId, "nord");
  assert.equal(account.stored?.themeId, "nord");
});

test("saves still queued at sign-out are not sent to the next account", async () => {
  createBrowser();
  const theme = await loadTheme();
  const account = fakeAccount({
    version: 2,
    themeId: "aurral",
    appearance: "dark",
    matchArtwork: false,
    themes: [],
  });
  const { promise: firstSave, resolve: releaseFirstSave } = Promise.withResolvers<void>();
  const saveAccountTheme = async (document: ThemeDocument) => {
    if (!account.saves.length) await firstSave;
    account.saves.push(document);
  };
  const sync = theme.startThemeAccountSync({
    userId: 6,
    loadAccountTheme: account.loadAccountTheme,
    saveAccountTheme,
  });
  await account.answer();
  await sync.ready;

  theme.selectTheme("nord");
  await new Promise<void>((resolve) => setImmediate(resolve));
  theme.selectTheme("solarized");
  sync.stop();
  releaseFirstSave();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    account.saves.map((document) => document.themeId),
    ["nord"],
  );
});

test("undo does not restore a theme past the limit", async () => {
  createBrowser();
  const theme = await loadTheme();
  for (let index = 0; index < theme.MAX_CUSTOM_THEMES; index += 1) {
    theme.saveCustomTheme(
      { name: `Theme ${index}`, dark: { background: "#101820", accent: "#f2aa4c" } },
      { select: false },
    );
  }
  const removed = theme.removeCustomTheme(theme.getThemeDocument().themes[0].id);
  assert.ok(removed != null);
  theme.saveCustomTheme(
    { name: "Replacement", dark: { background: "#101820", accent: "#f2aa4c" } },
    { select: false },
  );

  assert.throws(() => theme.restoreCustomTheme(removed), /up to/);
  assert.equal(theme.getThemeDocument().themes.length, theme.MAX_CUSTOM_THEMES);
  assert.equal(theme.getThemeDocument().themes.at(-1)?.name, "Replacement");
});

test("a browser that cannot store themes reports it and keeps the old copy", async () => {
  const { stored } = createBrowser({ storage: { aurralTheme: "dark" } });
  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const theme = await loadTheme();

  assert.equal(theme.getThemeDocument().appearance, "dark");
  assert.equal(stored.get("aurralTheme"), "dark");
  assert.throws(
    () =>
      theme.saveCustomTheme({
        name: "Unsaved",
        dark: { background: "#101820", accent: "#f2aa4c" },
      }),
    /couldn't save/,
  );
});

test("the startup script paints the saved theme before the app loads", async () => {
  const { stored } = createBrowser();
  const { getThemePalette, findTheme, initializeTheme, selectTheme } = await loadTheme();
  initializeTheme();
  selectTheme("catppuccin");
  const source = await readFile(new URL("../../frontend/public/theme.js", import.meta.url), "utf8");

  const runStartup = (prefersDark: boolean) => {
    const variables = new Map<string, string>();
    const dataset: Record<string, string> = {};
    runInNewContext(source, {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
      matchMedia: () => ({ matches: prefersDark }),
      document: {
        documentElement: {
          dataset,
          style: { setProperty: (name: string, value: string) => variables.set(name, value) },
        },
      },
    });
    return { variables, dataset };
  };

  const catppuccin = findTheme("catppuccin");
  assert.ok(catppuccin);
  const dark = runStartup(true);
  assert.equal(dark.dataset.theme, "dark");
  assert.equal(dark.variables.get("--aurral-surface"), getThemePalette(catppuccin, "dark").surface);
  assert.equal(
    dark.variables.get("--aurral-text-muted"),
    getThemePalette(catppuccin, "dark").textMuted,
  );

  const light = runStartup(false);
  assert.equal(light.dataset.theme, "light");
  assert.equal(light.variables.get("--aurral-surface"), "#eff1f5");

  selectTheme("aurral");
  assert.equal(runStartup(true).variables.size, 0);
});

test("album art tints the theme only while immersive mode is on", async () => {
  const { variables } = createBrowser({ prefersDark: true });
  const { initializeTheme, setArtworkColor, setImmersiveMode } = await loadTheme();
  initializeTheme();

  setArtworkColor("#e0442b");
  assert.equal(variables.size, 0);

  setImmersiveMode(true);
  const accent = variables.get("--aurral-accent");
  const surface = variables.get("--aurral-surface");
  assert.ok(accent && surface);
  assert.notEqual(surface, "#121212");
  assert.ok(
    Number.parseInt(accent.slice(1, 3), 16) > Number.parseInt(accent.slice(5, 7), 16),
    "accent stays red",
  );
  assert.ok(contrast(accent, surface) >= 3);

  setImmersiveMode(false);
  assert.equal(variables.size, 0);
  setImmersiveMode(true);
  assert.equal(variables.get("--aurral-accent"), accent);

  setArtworkColor(null);
  assert.equal(variables.size, 0);
});

test("previewing a theme changes the page without changing the saved choice", async () => {
  const { dataset, stored } = createBrowser();
  const { findTheme, getPaintedThemeMode, initializeTheme, previewTheme, subscribeToTheme } =
    await loadTheme();
  initializeTheme();
  const before = stored.get("aurralTheme:v2");
  const seenModes: string[] = [];
  subscribeToTheme(() => seenModes.push(getPaintedThemeMode()));

  previewTheme(findTheme("solarized"), "dark");
  assert.equal(dataset.themeId, "solarized");
  assert.equal(dataset.theme, "dark");
  assert.equal(stored.get("aurralTheme:v2"), before);

  previewTheme(null);
  assert.equal(dataset.themeId, "aurral");
  assert.deepEqual(seenModes, ["dark", "light"]);
});

test("removing a theme can be undone in place", async () => {
  createBrowser();
  const { getThemeDocument, removeCustomTheme, restoreCustomTheme, saveCustomTheme } =
    await loadTheme();
  const first = saveCustomTheme({
    name: "First",
    dark: { background: "#101820", accent: "#f2aa4c" },
  });
  const second = saveCustomTheme({
    name: "Second",
    light: { background: "#fafafa", accent: "#3366ff" },
  });
  saveCustomTheme(
    { name: "Third", light: { background: "#ffffff", accent: "#00aa77" } },
    { select: false },
  );

  const removed = removeCustomTheme(second.id);
  assert.ok(removed != null);
  assert.equal(getThemeDocument().themeId, "aurral");
  assert.deepEqual(
    getThemeDocument().themes.map((theme) => theme.name),
    ["First", "Third"],
  );

  restoreCustomTheme(removed);
  assert.equal(getThemeDocument().themeId, second.id);
  assert.deepEqual(
    getThemeDocument().themes.map((theme) => theme.id),
    [first.id, second.id, "custom-third"],
  );
});

test("a theme whose background does not match its mode is refused", async () => {
  createBrowser();
  const { saveCustomTheme } = await loadTheme();
  assert.throws(
    () =>
      saveCustomTheme({ name: "Backwards", dark: { background: "#ffffff", accent: "#3366ff" } }),
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

  const older = parseThemeText(
    'scheme: "Paper"\nbase00: "f2eede"\nbase05: "000000"\nbase0d: "1e6fcc"\n',
  );
  assert.deepEqual(older, {
    name: "Paper",
    light: { background: "#f2eede", text: "#000000", accent: "#1e6fcc" },
  });
});

test("Aurral theme files round-trip and old theme files still import", () => {
  const theme = {
    id: "custom-dusk",
    name: "Dusk",
    dark: { background: "#1b1d2a", accent: "#c3a6ff" },
  };
  assert.deepEqual(parseThemeText(serializeThemeFile(theme)), { name: "Dusk", dark: theme.dark });

  const legacy = parseThemeText(
    JSON.stringify({
      version: 1,
      name: "Legacy",
      appearance: "dark",
      colors: { surface: "#181818", text: "#d8d8d8", accent: "#7cafc2", border: "#d8d8d814" },
    }),
  );
  assert.deepEqual(legacy, {
    name: "Legacy",
    dark: { background: "#181818", text: "#d8d8d8", accent: "#7cafc2" },
  });

  assert.throws(() => parseThemeText("hello there"), /base16/);
  assert.throws(() => parseThemeText('{"version": 9, "name": "Future"}'), /version/);
  assert.throws(
    () =>
      parseThemeText(
        '{"version": 2, "name": "Broken", "dark": {"background": "#101820", "accent": 123}}',
      ),
    /invalid/,
  );
});

test("album art matching picks the vivid color, not the average", () => {
  const pixels: number[] = [];
  const push = (count: number, rgb: number[]) => {
    for (let index = 0; index < count; index += 1) pixels.push(...rgb, 255);
  };
  push(700, [128, 128, 128]);
  push(250, [30, 90, 230]);
  push(50, [220, 40, 40]);

  const color = pickVividColor(pixels);
  assert.ok(color != null);
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  assert.ok(b > r && b > g, `${color} is blue`);

  assert.equal(
    pickVividColor(Array.from({ length: 400 }, (_, index) => (index % 4 === 3 ? 255 : 90))),
    null,
  );
});
