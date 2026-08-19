import test from "node:test";
import assert from "node:assert/strict";

import {
  clearTerminalSexyCatalogCache,
  groupTerminalSexyCatalog,
  importTerminalSexyTheme,
  normalizeTerminalSexyCatalog,
  searchTerminalSexyThemes,
  selectTerminalSexyFeaturedThemes,
} from "../../frontend/src/utils/terminalSexyThemes.js";

const originalFetch = globalThis.fetch;

const scheme = {
  name: "Solarized Dark",
  background: "#002b36",
  foreground: "#839496",
  color: [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ],
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTerminalSexyCatalogCache();
});

test("terminal.sexy catalogs normalize and discard unsafe paths", () => {
  const catalog = normalizeTerminalSexyCatalog(["base16/solarized.dark", "collection/Dawn", "../unsafe"]);
  assert.deepEqual(catalog.map((entry) => entry.label), ["solarized", "Dawn"]);
  assert.equal(catalog[0].appearance, "dark");
  assert.equal(catalog[1].category, "collection");
});

test("terminal.sexy light and dark paths share one theme card", () => {
  const catalog = normalizeTerminalSexyCatalog(["base16/solarized.dark", "base16/solarized.light"]);
  const [group] = groupTerminalSexyCatalog(catalog);
  assert.equal(group.label, "solarized");
  assert.deepEqual(Object.keys(group.sources), ["dark", "light"]);
});

test("terminal.sexy featured themes choose five stable schemes", () => {
  const catalog = normalizeTerminalSexyCatalog([
    "base16/monokai.dark",
    "base16/solarized.dark",
    "base16/ocean.dark",
    "collection/dawn",
    "xcolors.net/zenburn",
    "base16/3024.dark",
  ]);
  assert.deepEqual(
    selectTerminalSexyFeaturedThemes(catalog).map((entry) => entry.path),
    ["base16/monokai.dark", "base16/solarized.dark", "base16/ocean.dark", "collection/dawn", "xcolors.net/zenburn"],
  );
});

test("terminal.sexy schemes can be searched and imported with variants", async () => {
  const lightScheme = {
    ...scheme,
    name: "Solarized Light",
    background: "#fdf6e3",
    foreground: "#657b83",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/index.json")) return new Response(JSON.stringify(["base16/solarized.dark", "base16/solarized.light"]));
    if (url.endsWith("/base16/solarized.dark.json")) return new Response(JSON.stringify(scheme));
    if (url.endsWith("/base16/solarized.light.json")) return new Response(JSON.stringify(lightScheme));
    throw new Error(`Unexpected URL: ${url}`);
  };

  const [result] = await searchTerminalSexyThemes("solarized");
  assert.equal(result.label, "solarized");
  assert.deepEqual(Object.keys(result.sources), ["dark", "light"]);
  const theme = await importTerminalSexyTheme(result);
  assert.equal(theme.label, "solarized");
  assert.equal(theme.appearance, "light");
  assert.equal(theme.colors.chrome, "#fdf6e3");
  assert.equal(theme.variants.dark.chrome, "#002b36");
});
