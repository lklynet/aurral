import {
  createThemeColors,
  normalizeThemeColor,
  parseThemeColor,
  parseThemeFile,
  THEME_FILE_VERSION,
} from "./theme.js";

export const TERMINAL_SEXY_SCHEME_ROOT = "https://raw.githubusercontent.com/stayradiated/terminal.sexy/master/dist/schemes";
export const TERMINAL_SEXY_FEATURED_PATHS = [
  "base16/monokai.dark",
  "base16/solarized.dark",
  "base16/ocean.dark",
  "collection/dawn",
  "xcolors.net/zenburn",
];

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULTS = 24;
const REQUEST_TIMEOUT_MS = 15_000;

let catalogPromise = null;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHash(value) {
  let hash = 2_166_136_261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeSchemePath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path || path.length > 512 || path.includes("..") || !/^[\w./ -]+$/.test(path)) return null;
  return path;
}

function humanizeSchemePath(path) {
  const name = path.split("/").pop() || path;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function schemeFamilyPath(path) {
  return path.replace(/\.(?:dark|light)$/i, "");
}

function schemeEntry(path) {
  const category = path.split("/", 1)[0];
  const familyPath = schemeFamilyPath(path);
  return {
    id: `terminal-sexy-${shortHash(path)}`,
    path,
    familyPath,
    label: humanizeSchemePath(familyPath),
    category,
    appearance: /\.light$/i.test(path) ? "light" : /\.dark$/i.test(path) ? "dark" : null,
  };
}

export function normalizeTerminalSexyCatalog(value) {
  if (!Array.isArray(value)) throw new Error("Terminal.sexy returned an unreadable scheme catalog.");
  const catalog = value.flatMap((path) => {
    const normalized = safeSchemePath(path);
    return normalized ? [schemeEntry(normalized)] : [];
  });
  if (!catalog.length) throw new Error("Terminal.sexy returned no color schemes.");
  return catalog;
}

export function groupTerminalSexyCatalog(catalog) {
  const groups = new Map();
  for (const scheme of catalog) {
    const key = scheme.familyPath || schemeFamilyPath(scheme.path);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: `terminal-sexy-${shortHash(key)}`,
        path: scheme.path,
        label: humanizeSchemePath(key),
        category: scheme.category,
        appearance: scheme.appearance,
        sources: {},
      };
      groups.set(key, group);
    }
    group.sources[scheme.appearance || "default"] = scheme;
    if (!group.appearance && scheme.appearance) group.appearance = scheme.appearance;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    id: `terminal-sexy-${shortHash(group.sources.dark?.path || group.path)}`,
  }));
}

export function selectTerminalSexyFeaturedThemes(catalog, limit = TERMINAL_SEXY_FEATURED_PATHS.length) {
  const max = Math.max(0, limit);
  if (!max) return [];
  const groups = groupTerminalSexyCatalog(catalog);
  const byPath = new Map(groups.flatMap((group) => Object.values(group.sources).map((scheme) => [scheme.path, group])));
  const preferred = TERMINAL_SEXY_FEATURED_PATHS.flatMap((path) => {
    const scheme = byPath.get(path);
    return scheme ? [scheme] : [];
  });
  const fallback = groups.filter((scheme) => scheme.sources.dark || scheme.appearance !== "light");
  const selected = [];
  const seen = new Set();
  for (const group of [...preferred, ...fallback, ...groups]) {
    if (seen.has(group)) continue;
    seen.add(group);
    selected.push(group);
    if (selected.length >= max) break;
  }
  return selected;
}

function schemeUrl(path) {
  const normalized = safeSchemePath(path);
  if (!normalized) throw new Error("That terminal.sexy scheme path is invalid.");
  return `${TERMINAL_SEXY_SCHEME_ROOT}/${normalized.split("/").map(encodeURIComponent).join("/")}.json`;
}

async function fetchJson(url, signal, message) {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortRequest, { once: true });
  const timeoutId = setTimeout(abortRequest, REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(message);
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error(message);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error(message);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(message, { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(message, { cause: error });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRequest);
  }
}

export function clearTerminalSexyCatalogCache() {
  catalogPromise = null;
}

export async function loadTerminalSexyCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchJson(
      `${TERMINAL_SEXY_SCHEME_ROOT}/index.json`,
      undefined,
      "Terminal.sexy schemes are unavailable right now.",
    ).then(normalizeTerminalSexyCatalog).catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

export async function searchTerminalSexyThemes(query, { signal, limit = MAX_RESULTS } = {}) {
  const catalog = groupTerminalSexyCatalog(await loadTerminalSexyCatalog());
  if (signal?.aborted) return [];
  const normalizedQuery = String(query || "").trim().toLowerCase();
  return catalog
    .filter((scheme) => !normalizedQuery || `${scheme.label} ${scheme.path} ${scheme.category} ${Object.values(scheme.sources).map((source) => source.path).join(" ")}`.toLowerCase().includes(normalizedQuery))
    .slice(0, Math.max(1, limit));
}

function relativeLuminance(color) {
  const channel = (value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function terminalColors(value) {
  if (!isRecord(value)) throw new Error("Terminal.sexy schemes must contain a JSON object.");
  if (!Array.isArray(value.color) || value.color.length < 16) throw new Error("That terminal.sexy scheme has no complete ANSI palette.");
  const colors = value.color.map((color, index) => {
    const normalized = normalizeThemeColor(color);
    if (!normalized) throw new Error(`That terminal.sexy scheme has an invalid color at index ${index}.`);
    return normalized;
  });
  const background = normalizeThemeColor(value.background);
  const foreground = normalizeThemeColor(value.foreground);
  if (!background || !foreground) throw new Error("That terminal.sexy scheme has no valid foreground and background colors.");
  return { colors, background, foreground };
}

export function parseTerminalSexyTheme(value, sourceName = "") {
  const { colors: ansi, background, foreground } = terminalColors(value);
  const appearance = relativeLuminance(parseThemeColor(background)) < 0.179 ? "dark" : "light";
  const label = typeof value.name === "string" && value.name.trim()
    ? value.name.trim().slice(0, 48)
    : humanizeSchemePath(sourceName || "terminal-sexy-scheme");
  const id = `terminal-sexy-${shortHash(sourceName || label)}`;
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    id,
    name: label,
    appearance,
    colors: createThemeColors(appearance, background, ansi[4], {
      chrome: background,
      text: foreground,
      border: ansi[8],
      danger: ansi[1],
      warning: ansi[3],
      success: ansi[2],
      info: ansi[6],
    }),
  });
}

export async function importTerminalSexyTheme(scheme, { signal } = {}) {
  const sources = scheme?.sources ? Object.entries(scheme.sources) : [[null, scheme]];
  const themes = await Promise.all(sources.map(async ([sourceMode, source]) => {
    const path = source?.path || source;
    const value = await fetchJson(schemeUrl(path), signal, "That terminal.sexy scheme is unavailable right now.");
    return {
      sourceMode,
      theme: parseTerminalSexyTheme(value, safeSchemePath(path) || ""),
    };
  }));
  const primary = scheme?.sources
    ? themes.find(({ sourceMode }) => sourceMode === "light")
      || themes.find(({ sourceMode }) => sourceMode === "dark")
      || themes[0]
    : themes[0];
  const appearance = scheme?.sources && (primary.sourceMode === "light" || primary.sourceMode === "dark")
    ? primary.sourceMode
    : primary.theme.appearance;
  const variants = Object.fromEntries(
    themes
      .filter(({ sourceMode, theme }) => theme !== primary.theme && (sourceMode === "light" || sourceMode === "dark"))
      .map(({ sourceMode, theme }) => [sourceMode, theme.colors])
      .filter(([mode]) => mode !== appearance),
  );
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    id: scheme?.id || primary.theme.id,
    name: scheme?.label || primary.theme.label,
    appearance,
    colors: primary.theme.colors,
    ...(Object.keys(variants).length ? { variants } : {}),
  });
}
