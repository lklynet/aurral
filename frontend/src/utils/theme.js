import {
  adjustLightnessForContrast,
  colorAtContrast,
  contrastRatio,
  hexToOklch,
  isDarkColor,
  mixColors,
  normalizeHexColor,
  oklchToHex,
  withAlpha,
} from "./themeColor.js";
import { THEME_PRESETS } from "./themePresets.js";

export const THEME_STORAGE_KEY = "aurralTheme:v2";
export const THEME_PAINT_STORAGE_KEY = "aurralThemePaint:v1";
export const THEME_OWNER_STORAGE_KEY = "aurralThemeOwner:v1";
export const LEGACY_THEME_STORAGE_KEYS = ["aurralTheme", "aurralThemeAppearance:v1", "aurralThemes:v1"];
export const THEME_DOCUMENT_VERSION = 2;
export const DEFAULT_THEME_ID = "aurral";
export const THEME_APPEARANCES = ["system", "light", "dark"];
export const THEME_MODES = ["light", "dark"];
export const MAX_CUSTOM_THEMES = 50;
export const THEME_SEED_ROLES = ["background", "text", "accent", "danger", "warning", "success", "info"];

export const THEME_COLOR_ROLES = [
  "chrome",
  "surface",
  "surfaceRaised",
  "surfacePopover",
  "surfaceHover",
  "surfaceSelected",
  "text",
  "textMuted",
  "textSubtle",
  "border",
  "borderStrong",
  "accent",
  "accentContrast",
  "danger",
  "warning",
  "success",
  "info",
  "ring",
  "controlOn",
  "controlOnContrast",
  "scrim",
];

const cssVariable = (role) => `--aurral-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

const STATUS_DEFAULTS = {
  light: { danger: "#dc2626", warning: "#b45309", success: "#15803d", info: "#2563eb" },
  dark: { danger: "#ef4444", warning: "#f59e0b", success: "#22c55e", info: "#60a5fa" },
};

export const AURRAL_THEME = {
  id: DEFAULT_THEME_ID,
  name: "Aurral",
  light: { background: "#ffffff", text: "#171717", accent: "#525252" },
  dark: { background: "#121212", text: "#ffffff", accent: "#b3b3b3" },
};

export const BUILT_IN_THEMES = [AURRAL_THEME, ...THEME_PRESETS];
const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const otherMode = (mode) => (mode === "dark" ? "light" : "dark");

function readableOn(background, candidates) {
  return [...candidates, "#ffffff", "#000000"].find((color) => contrastRatio(color, background) >= 4.5)
    || (contrastRatio("#ffffff", background) >= contrastRatio("#000000", background) ? "#ffffff" : "#000000");
}

export function createThemePalette(seed) {
  const dark = isDarkColor(seed.background);
  const surface = normalizeHexColor(seed.background);
  const base = hexToOklch(surface);
  const shade = (delta) => oklchToHex({ ...base, l: base.l + delta });
  const toward = dark ? 1 : -1;
  const surfaceRaised = shade(toward * (dark ? 0.05 : 0.035));
  const surfacePopover = shade(toward * (dark ? 0.1 : 0.075));
  const surfaceHover = shade(toward * (dark ? 0.17 : 0.13));
  const chrome = shade(dark ? -0.06 : -0.07);

  const textSeed = seed.text || oklchToHex({ l: dark ? 0.96 : 0.2, c: Math.min(base.c, 0.02), h: base.h });
  const text = adjustLightnessForContrast(textSeed, surfacePopover, 7);
  const textColor = hexToOklch(text);
  const textContrast = contrastRatio(text, surfacePopover);
  const mutedTarget = clamp(textContrast * 0.48, 4.6, textContrast);
  const subtleTarget = clamp(textContrast * 0.25, 3.2, mutedTarget);
  const textMuted = colorAtContrast(textColor.h, textColor.c, surfacePopover, mutedTarget, dark);
  const textSubtle = colorAtContrast(textColor.h, textColor.c, surfacePopover, subtleTarget, dark);

  const accent = adjustLightnessForContrast(seed.accent, surface, 3);
  const accentContrast = readableOn(accent, [text, surface]);
  const status = Object.fromEntries(
    Object.entries(STATUS_DEFAULTS[dark ? "dark" : "light"]).map(([role, fallback]) => [
      role,
      adjustLightnessForContrast(seed[role] || fallback, surfacePopover, 4.5),
    ]),
  );

  return {
    chrome,
    surface,
    surfaceRaised,
    surfacePopover,
    surfaceHover,
    surfaceSelected: mixColors(surface, accent, dark ? 0.16 : 0.1),
    text,
    textMuted,
    textSubtle,
    border: withAlpha(text, 0.08),
    borderStrong: withAlpha(text, 0.14),
    accent,
    accentContrast,
    ...status,
    ring: withAlpha(text, 0.46),
    controlOn: accent,
    controlOnContrast: accentContrast,
    scrim: dark ? "#000000b8" : withAlpha(chrome, 0.72),
  };
}

function mirrorSeed(seed, mode) {
  const dark = mode === "dark";
  const background = hexToOklch(seed.background);
  const mirrored = {
    background: oklchToHex(dark
      ? { l: 0.2, c: Math.min(background.c, 0.03), h: background.h }
      : { l: 0.98, c: Math.min(background.c * 0.5, 0.012), h: background.h }),
    accent: seed.accent,
  };
  if (seed.text) {
    const text = hexToOklch(seed.text);
    mirrored.text = oklchToHex({ l: dark ? 0.93 : 0.24, c: Math.min(text.c, 0.03), h: text.h });
  }
  for (const role of ["danger", "warning", "success", "info"]) {
    if (seed[role]) mirrored[role] = seed[role];
  }
  return mirrored;
}

export function getThemeSeed(theme, mode) {
  return theme[mode] || mirrorSeed(theme[otherMode(mode)], mode);
}

const paletteCache = new WeakMap();

export function getThemePalette(theme, mode) {
  let palettes = paletteCache.get(theme);
  if (!palettes) {
    palettes = {};
    paletteCache.set(theme, palettes);
  }
  palettes[mode] ||= createThemePalette(getThemeSeed(theme, mode));
  return palettes[mode];
}

export function tintSeedWithArtwork(seed, artwork) {
  const art = hexToOklch(artwork);
  const background = hexToOklch(seed.background);
  const dark = isDarkColor(seed.background);
  return {
    ...seed,
    accent: artwork,
    background: oklchToHex({
      l: background.l,
      c: dark ? Math.min(0.022, art.c * 0.25) : Math.min(0.014, art.c * 0.15),
      h: art.h,
    }),
  };
}

function normalizeSeed(value, mode, themeName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${themeName} has unreadable ${mode} colors.`);
  }
  const seed = {};
  for (const role of THEME_SEED_ROLES) {
    if (value[role] === undefined || value[role] === null || value[role] === "") continue;
    const color = normalizeHexColor(value[role]);
    if (!color) throw new Error(`${themeName} has an invalid ${mode} ${role} color.`);
    seed[role] = color;
  }
  if (!seed.background || !seed.accent) throw new Error(`${themeName} needs a ${mode} background and accent color.`);
  if (isDarkColor(seed.background) !== (mode === "dark")) {
    throw new Error(`${themeName} needs a ${mode} background for its ${mode} colors.`);
  }
  return seed;
}

export function normalizeThemeName(value) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new Error("Give the theme a name.");
  if (name.length > 48) throw new Error("Theme names can be up to 48 characters.");
  return name;
}

export function isThemeId(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(value);
}

export function normalizeTheme(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This theme is unreadable.");
  const name = normalizeThemeName(value.name);
  if (!isThemeId(value.id)) throw new Error(`${name} has an invalid id.`);
  const theme = { id: value.id, name };
  for (const mode of THEME_MODES) {
    if (value[mode] !== undefined && value[mode] !== null) theme[mode] = normalizeSeed(value[mode], mode, name);
  }
  if (!theme.light && !theme.dark) throw new Error(`${name} needs light or dark colors.`);
  return theme;
}

export function createThemeId(name, takenIds = []) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "theme";
  const taken = new Set([...BUILT_IN_THEME_IDS, ...takenIds]);
  let id = `custom-${slug}`;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `custom-${slug}-${suffix}`;
  return id;
}

export function createDefaultThemeDocument() {
  return {
    version: THEME_DOCUMENT_VERSION,
    themeId: DEFAULT_THEME_ID,
    appearance: "system",
    matchArtwork: false,
    themes: [],
  };
}

export function normalizeThemeDocument(value) {
  const document = createDefaultThemeDocument();
  if (!value || typeof value !== "object" || value.version !== THEME_DOCUMENT_VERSION) return document;
  if (THEME_APPEARANCES.includes(value.appearance)) document.appearance = value.appearance;
  document.matchArtwork = value.matchArtwork === true;
  const seen = new Set(BUILT_IN_THEME_IDS);
  for (const item of Array.isArray(value.themes) ? value.themes : []) {
    if (document.themes.length >= MAX_CUSTOM_THEMES) break;
    try {
      const theme = normalizeTheme(item);
      if (seen.has(theme.id)) continue;
      seen.add(theme.id);
      document.themes.push(theme);
    } catch {
      continue;
    }
  }
  if (isThemeId(value.themeId) && seen.has(value.themeId)) document.themeId = value.themeId;
  return document;
}

export function isDefaultThemeDocument(document) {
  return JSON.stringify(document) === JSON.stringify(createDefaultThemeDocument());
}

export function convertLegacyTheme(value) {
  if (!value || typeof value !== "object" || !value.colors) throw new Error("This theme file is unreadable.");
  const palettes = [value.colors, ...Object.values(value.variants || {})];
  const theme = { id: value.id, name: value.name ?? value.label };
  for (const colors of palettes) {
    const background = normalizeHexColor(String(colors?.surface || "").slice(0, 7));
    const accent = normalizeHexColor(String(colors?.accent || "").slice(0, 7));
    if (!background || !accent) continue;
    const mode = isDarkColor(background) ? "dark" : "light";
    if (theme[mode]) continue;
    const seed = { background, accent };
    for (const role of ["text", "danger", "warning", "success", "info"]) {
      const color = normalizeHexColor(String(colors[role] || "").slice(0, 7));
      if (color) seed[role] = color;
    }
    theme[mode] = seed;
  }
  return theme;
}

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function migrateLegacyDocument() {
  const selection = readStorage("aurralTheme");
  const appearance = readStorage("aurralThemeAppearance:v1");
  const legacyThemes = parseJson(readStorage("aurralThemes:v1"));
  if (selection === null && appearance === null && legacyThemes === null) return null;
  const themes = [];
  let themeId = THEME_APPEARANCES.includes(selection) ? DEFAULT_THEME_ID : selection;
  for (const item of Array.isArray(legacyThemes) ? legacyThemes : []) {
    try {
      const legacy = convertLegacyTheme(item);
      const taken = themes.map((theme) => theme.id);
      const id = isThemeId(legacy.id) && !BUILT_IN_THEME_IDS.has(legacy.id) && !taken.includes(legacy.id)
        ? legacy.id
        : createThemeId(legacy.name, taken);
      themes.push(normalizeTheme({ ...legacy, id }));
      if (legacy.id === selection) themeId = id;
    } catch {
      continue;
    }
  }
  const document = normalizeThemeDocument({
    version: THEME_DOCUMENT_VERSION,
    themeId,
    appearance: THEME_APPEARANCES.includes(selection) ? selection : appearance,
    themes,
  });
  const keptEveryTheme = document.themes.length === themes.length;
  if (writeStorage(THEME_STORAGE_KEY, JSON.stringify(document)) && keptEveryTheme) {
    for (const key of LEGACY_THEME_STORAGE_KEYS) writeStorage(key, null);
  }
  return document;
}

function readLocalDocument() {
  const stored = parseJson(readStorage(THEME_STORAGE_KEY));
  if (stored) return normalizeThemeDocument(stored);
  return migrateLegacyDocument() || createDefaultThemeDocument();
}

let documentCache = null;
let artworkColor = null;
let preview = null;
let saveToAccount = null;
let appliedPalette = null;
let tweenFrame = null;
let lastPaintCache = null;
const listeners = new Set();

export function getThemeDocument() {
  documentCache ||= readLocalDocument();
  return documentCache;
}

export function subscribeToTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAllThemes(document = getThemeDocument()) {
  return [...BUILT_IN_THEMES, ...document.themes];
}

export function findTheme(themeId, document = getThemeDocument()) {
  return getAllThemes(document).find((theme) => theme.id === themeId) || null;
}

export function isCustomTheme(theme) {
  return Boolean(theme) && !BUILT_IN_THEME_IDS.has(theme.id);
}

function commit(document, { fromAccount = false } = {}) {
  documentCache = document;
  const storedLocally = writeStorage(THEME_STORAGE_KEY, JSON.stringify(document));
  render();
  for (const listener of listeners) listener();
  if (!fromAccount) saveToAccount?.(document);
  return storedLocally || Boolean(saveToAccount);
}

const NOT_SAVED_MESSAGE = "This browser couldn't save your themes. They'll reset when the page reloads.";

function update(changes) {
  commit(normalizeThemeDocument({ ...getThemeDocument(), ...changes }));
}

export function selectTheme(themeId) {
  update({ themeId: findTheme(themeId) ? themeId : DEFAULT_THEME_ID });
}

export function setThemeAppearance(appearance) {
  update({ appearance: THEME_APPEARANCES.includes(appearance) ? appearance : "system" });
}

export function setMatchArtwork(matchArtwork) {
  update({ matchArtwork: Boolean(matchArtwork) });
}

export function saveCustomTheme(value, { select = true } = {}) {
  const document = getThemeDocument();
  const exists = document.themes.some((theme) => theme.id === value.id);
  const id = exists ? value.id : createThemeId(value.name, document.themes.map((theme) => theme.id));
  const theme = normalizeTheme({ ...value, id });
  if (!exists && document.themes.length >= MAX_CUSTOM_THEMES) {
    throw new Error(`You can keep up to ${MAX_CUSTOM_THEMES} themes. Remove one to add another.`);
  }
  const themes = exists
    ? document.themes.map((item) => (item.id === id ? theme : item))
    : [...document.themes, theme];
  if (!commit({ ...document, themes, themeId: select ? id : document.themeId })) throw new Error(NOT_SAVED_MESSAGE);
  return theme;
}

export function removeCustomTheme(themeId) {
  const document = getThemeDocument();
  const index = document.themes.findIndex((theme) => theme.id === themeId);
  if (index < 0) return null;
  const removed = { theme: document.themes[index], index, wasSelected: document.themeId === themeId };
  commit({
    ...document,
    themes: document.themes.filter((theme) => theme.id !== themeId),
    themeId: removed.wasSelected ? DEFAULT_THEME_ID : document.themeId,
  });
  return removed;
}

export function restoreCustomTheme({ theme, index, wasSelected }) {
  const document = getThemeDocument();
  if (document.themes.some((item) => item.id === theme.id)) return;
  if (document.themes.length >= MAX_CUSTOM_THEMES) {
    throw new Error(`You can keep up to ${MAX_CUSTOM_THEMES} themes. Remove one to restore ${theme.name}.`);
  }
  const themes = [...document.themes];
  themes.splice(index, 0, theme);
  commit({ ...document, themes, themeId: wasSelected ? theme.id : document.themeId });
}

function syncThemeWithAccount(userId, accountDocument) {
  const owner = Number(readStorage(THEME_OWNER_STORAGE_KEY)) || null;
  writeStorage(THEME_OWNER_STORAGE_KEY, String(userId));
  if (accountDocument) {
    const next = normalizeThemeDocument(accountDocument);
    if (JSON.stringify(next) !== JSON.stringify(getThemeDocument())) commit(next, { fromAccount: true });
    return null;
  }
  if (owner !== null && owner !== userId) {
    commit(createDefaultThemeDocument(), { fromAccount: true });
    return null;
  }
  const local = getThemeDocument();
  return isDefaultThemeDocument(local) ? null : local;
}

export function startThemeAccountSync({ userId, loadAccountTheme, saveAccountTheme, onSaveError }) {
  let stopped = false;
  let edits = 0;
  let pending = Promise.resolve();
  const save = (document) => {
    edits += 1;
    pending = pending
      .then(() => (stopped ? undefined : saveAccountTheme(document)))
      .catch(() => {
        if (!stopped) onSaveError?.();
      });
  };
  const refresh = () => {
    const editsAtStart = edits;
    return pending
      .then(() => loadAccountTheme())
      .then((response) => {
        if (stopped || edits !== editsAtStart) return;
        const upload = syncThemeWithAccount(userId, response?.theme || null);
        saveToAccount = save;
        if (upload) save(upload);
      })
      .catch(() => {});
  };
  const ready = refresh();
  return {
    ready,
    refresh,
    stop() {
      stopped = true;
      if (saveToAccount === save) saveToAccount = null;
    },
  };
}

export function previewTheme(theme, mode) {
  preview = theme ? { theme, mode } : null;
  render();
}

export function setArtworkColor(color) {
  const next = normalizeHexColor(color);
  if (next === artworkColor) return;
  artworkColor = next;
  render({ animate: true });
}

function systemMode() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemeMode(appearance = getThemeDocument().appearance) {
  return appearance === "light" || appearance === "dark" ? appearance : systemMode();
}

function mixPaletteColor(from, to, amount) {
  const rgb = mixColors(from.slice(0, 7), to.slice(0, 7), amount);
  if (from.length === 7 && to.length === 7) return rgb;
  const alpha = (hex) => (hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1);
  return withAlpha(rgb, alpha(from) + (alpha(to) - alpha(from)) * amount);
}

function setVariables(root, palette) {
  for (const role of THEME_COLOR_ROLES) {
    if (palette) root.style.setProperty(cssVariable(role), palette[role]);
    else root.style.removeProperty(cssVariable(role));
  }
}

function updateMetaThemeColor(palette) {
  const document = globalThis.document;
  const color = palette?.chrome
    || (document.body && globalThis.getComputedStyle?.(document.body).backgroundColor);
  if (!color) return;
  for (const meta of document.querySelectorAll?.('meta[name="theme-color"]') || []) meta.setAttribute("content", color);
}

function paint(root, palette, { animate, fallback }) {
  if (tweenFrame !== null) {
    globalThis.cancelAnimationFrame?.(tweenFrame);
    tweenFrame = null;
  }
  const from = appliedPalette || fallback;
  appliedPalette = palette;
  const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const to = palette || fallback;
  if (!animate || reduceMotion || !globalThis.requestAnimationFrame || !from || !to || from === to) {
    setVariables(root, palette);
    updateMetaThemeColor(palette);
    return;
  }
  const started = globalThis.performance?.now?.() ?? Date.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / 280);
    const eased = 1 - (1 - progress) ** 3;
    if (progress < 1) {
      setVariables(root, Object.fromEntries(
        THEME_COLOR_ROLES.map((role) => [role, mixPaletteColor(from[role], to[role], eased)]),
      ));
      tweenFrame = globalThis.requestAnimationFrame(step);
      return;
    }
    tweenFrame = null;
    setVariables(root, palette);
    updateMetaThemeColor(palette);
  };
  tweenFrame = globalThis.requestAnimationFrame(step);
}

function writePaintCache(document, theme) {
  const cache = JSON.stringify({
    appearance: document.appearance,
    themeId: theme.id,
    light: theme.id === DEFAULT_THEME_ID ? null : getThemePalette(theme, "light"),
    dark: theme.id === DEFAULT_THEME_ID ? null : getThemePalette(theme, "dark"),
  });
  if (cache === lastPaintCache) return;
  lastPaintCache = cache;
  writeStorage(THEME_PAINT_STORAGE_KEY, cache);
}

function render({ animate = false } = {}) {
  const root = globalThis.document?.documentElement;
  if (!root?.style) return;
  const document = getThemeDocument();
  const theme = preview?.theme || findTheme(document.themeId, document) || AURRAL_THEME;
  const mode = preview?.mode || resolveThemeMode(document.appearance);
  const artwork = !preview && document.matchArtwork ? artworkColor : null;
  const palette = artwork
    ? createThemePalette(tintSeedWithArtwork(getThemeSeed(theme, mode), artwork))
    : theme.id === DEFAULT_THEME_ID
      ? null
      : getThemePalette(theme, mode);
  root.dataset.theme = mode;
  root.dataset.themeId = theme.id;
  root.style.colorScheme = mode;
  paint(root, palette, { animate, fallback: getThemePalette(theme, mode) });
  if (!preview) writePaintCache(document, theme);
}

let initialized = false;

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  render();
  globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (getThemeDocument().appearance === "system") render();
    for (const listener of listeners) listener();
  });
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    documentCache = null;
    render();
    for (const listener of listeners) listener();
  });
}
