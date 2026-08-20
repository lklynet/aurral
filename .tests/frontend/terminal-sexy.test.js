import test from "node:test";
import assert from "node:assert/strict";

import {
  clearTerminalSexyCatalogCache,
  groupTerminalSexyCatalog,
  importTerminalSexyTheme,
  loadTerminalSexyCatalog,
  normalizeTerminalSexyCatalog,
  searchTerminalSexyThemes,
  selectTerminalSexyFeaturedThemes,
} from "../../frontend/src/utils/terminalSexyThemes.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

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
  globalThis.setTimeout = originalSetTimeout;
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

test("paired terminal.sexy sources keep their declared light and dark modes", async () => {
  const measuredDark = { ...scheme, name: "Measured dark light source", background: "#101010" };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/base16/solarized.dark.json")) return new Response(JSON.stringify(scheme));
    if (url.endsWith("/base16/solarized.light.json")) return new Response(JSON.stringify(measuredDark));
    throw new Error(`Unexpected URL: ${url}`);
  };

  const theme = await importTerminalSexyTheme({
    id: "terminal-sexy-solarized",
    label: "solarized",
    sources: {
      dark: { path: "base16/solarized.dark" },
      light: { path: "base16/solarized.light" },
    },
  });

  assert.equal(theme.appearance, "light");
  assert.equal(theme.colors.chrome, "#101010");
  assert.equal(theme.variants.dark.chrome, "#002b36");
});

test("terminal.sexy catalog failures do not poison later retries", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(["base16/solarized.dark"]));
  };

  await assert.rejects(loadTerminalSexyCatalog(), /unavailable/);
  const catalog = await loadTerminalSexyCatalog();
  assert.equal(catalog[0].path, "base16/solarized.dark");
  assert.equal(attempts, 2);
});

test("terminal.sexy catalog rejects malformed and oversized responses", async () => {
  globalThis.fetch = async () => new Response("not json");
  await assert.rejects(loadTerminalSexyCatalog(), /unavailable/);

  clearTerminalSexyCatalogCache();
  globalThis.fetch = async () => new Response(JSON.stringify(["x".repeat(256 * 1024)]));
  await assert.rejects(loadTerminalSexyCatalog(), /unavailable/);
});

test("terminal.sexy catalog requests abort when they exceed the timeout", async () => {
  let requestSignal;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.fetch = async (_input, options) => {
    requestSignal = options.signal;
    throw new Error("aborted");
  };

  await assert.rejects(loadTerminalSexyCatalog(), /unavailable/);
  assert.equal(requestSignal.aborted, true);
});
