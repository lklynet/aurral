export const THEME_STORAGE_KEY = "aurralTheme";
export const THEME_APPEARANCE_STORAGE_KEY = "aurralThemeAppearance:v1";
export const CUSTOM_THEMES_STORAGE_KEY = "aurralThemes:v1";
export const THEME_FILE_VERSION = 1;
export const DEFAULT_THEME_ID = "aurral";
export const THEME_PREFERENCES = ["system", "light", "dark"];
export const THEME_APPEARANCES = ["system", "light", "dark"];

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

const THEME_VARIABLES = Object.fromEntries(
  THEME_COLOR_ROLES.map((role) => [
    role,
    `--aurral-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
  ]),
);
const THEME_COLOR_ROLE_SET = new Set(THEME_COLOR_ROLES);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function parseAlpha(value) {
  if (typeof value !== "string") return null;
  const parsed = value.trim().endsWith("%")
    ? Number.parseFloat(value) / 100
    : Number.parseFloat(value);
  return Number.isFinite(parsed) ? clamp(parsed) : null;
}

function parseChannel(value) {
  if (typeof value !== "string") return null;
  const parsed = value.trim().endsWith("%")
    ? (Number.parseFloat(value) / 100) * 255
    : Number.parseFloat(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 255) : null;
}

function parseHexColor(value) {
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  const expand = (part) => Number.parseInt(part.length === 1 ? `${part}${part}` : part, 16);
  return {
    r: expand(hex.slice(0, hex.length <= 4 ? 1 : 2)),
    g: expand(hex.slice(hex.length <= 4 ? 1 : 2, hex.length <= 4 ? 2 : 4)),
    b: expand(hex.slice(hex.length <= 4 ? 2 : 4, hex.length <= 4 ? 3 : 6)),
    a:
      hex.length === 4
        ? expand(hex.slice(3, 4)) / 255
        : hex.length === 8
          ? expand(hex.slice(6, 8)) / 255
          : 1,
  };
}

function parseRgbFunction(value) {
  const match = /^rgba?\((.*)\)$/i.exec(value.trim());
  if (!match) return null;
  const raw = match[1].trim();
  const slashParts = raw.split("/");
  const channels = slashParts[0]
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let alphaValue = slashParts[1];
  if (channels.length === 4 && alphaValue === undefined) alphaValue = channels.pop();
  if (channels.length !== 3) return null;
  const [r, g, b] = channels.map(parseChannel);
  const a = alphaValue === undefined ? 1 : parseAlpha(alphaValue);
  return [r, g, b, a].every((channel) => channel !== null) ? { r, g, b, a } : null;
}

function parseHslFunction(value) {
  const match = /^hsla?\((.*)\)$/i.exec(value.trim());
  if (!match) return null;
  const raw = match[1].trim();
  const slashParts = raw.split("/");
  const channels = slashParts[0]
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let alphaValue = slashParts[1];
  if (channels.length === 4 && alphaValue === undefined) alphaValue = channels.pop();
  if (channels.length !== 3 || !channels[1].endsWith("%") || !channels[2].endsWith("%")) {
    return null;
  }
  const hue = Number.parseFloat(channels[0]);
  const saturation = Number.parseFloat(channels[1]) / 100;
  const lightness = Number.parseFloat(channels[2]) / 100;
  const alpha = alphaValue === undefined ? 1 : parseAlpha(alphaValue);
  if (![hue, saturation, lightness, alpha].every(Number.isFinite)) return null;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = (((hue % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const matchRgb =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return {
    r: (matchRgb[0] + offset) * 255,
    g: (matchRgb[1] + offset) * 255,
    b: (matchRgb[2] + offset) * 255,
    a: alpha,
  };
}

function decodeGamma(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value) {
  const clamped = clamp(value);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function parseColorFunction(value) {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]*)\)$/i.exec(value.trim());
  if (!match) return null;
  const [channelPart, alphaPart] = match[2].split("/");
  const channels = channelPart.trim().split(/\s+/).map((part) =>
    part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part),
  );
  const alpha = alphaPart === undefined ? 1 : parseAlpha(alphaPart.trim());
  if (channels.length !== 3 || !channels.every(Number.isFinite) || !Number.isFinite(alpha)) return null;
  if (match[1].toLowerCase() === "srgb") {
    return { r: channels[0] * 255, g: channels[1] * 255, b: channels[2] * 255, a: alpha };
  }
  const linear = channels.map(decodeGamma);
  const srgb = [
    1.2249401762805 * linear[0] - 0.2249401762805 * linear[1],
    -0.042056961239 * linear[0] + 1.042056961239 * linear[1],
    -0.0196375547643 * linear[0] - 0.0786360655012 * linear[1] + 1.0982736202656 * linear[2],
  ];
  return {
    r: encodeGamma(srgb[0]) * 255,
    g: encodeGamma(srgb[1]) * 255,
    b: encodeGamma(srgb[2]) * 255,
    a: alpha,
  };
}

export function parseThemeColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "transparent") return null;
  return trimmed.startsWith("#")
    ? parseHexColor(trimmed)
    : trimmed.toLowerCase().startsWith("rgb")
      ? parseRgbFunction(trimmed)
      : trimmed.toLowerCase().startsWith("hsl")
        ? parseHslFunction(trimmed)
        : parseColorFunction(trimmed);
}

function channelToHex(value) {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
}

function rgbaToHex(color) {
  const opaque = `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
  return color.a >= 0.999 ? opaque : `${opaque}${channelToHex(color.a * 255)}`;
}

export function normalizeThemeColor(value) {
  const parsed = parseThemeColor(value);
  return parsed ? rgbaToHex(parsed) : null;
}

export function themeColorToHex(value) {
  return normalizeThemeColor(value);
}

function colorToRgb(value, fallback = { r: 0, g: 0, b: 0, a: 1 }) {
  return parseThemeColor(value) || fallback;
}

function relativeLuminance(color) {
  const channel = (value) => {
    const ratio = clamp(value / 255);
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function readableThemeForeground(background) {
  const color = typeof background === "string" ? colorToRgb(background) : background;
  const light = { r: 255, g: 255, b: 255, a: 1 };
  const dark = { r: 20, g: 20, b: 20, a: 1 };
  return rgbaToHex(contrastRatio(color, light) >= contrastRatio(color, dark) ? light : dark);
}

function mixColors(first, second, amount) {
  const a = colorToRgb(first);
  const b = colorToRgb(second);
  return rgbaToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
    a: 1,
  });
}

export function createThemeColors(appearance, background, accent, overrides = {}) {
  const dark = appearance === "dark";
  const canvas = normalizeThemeColor(background) || (dark ? "#111111" : "#ffffff");
  const accentColor = normalizeThemeColor(accent) || (dark ? "#79a8ff" : "#315fcb");
  const text = normalizeThemeColor(overrides.text) || readableThemeForeground(canvas);
  const muted = normalizeThemeColor(overrides.textMuted) || mixColors(text, canvas, 0.52);
  const subtle = normalizeThemeColor(overrides.textSubtle) || mixColors(muted, canvas, 0.58);
  const chrome = normalizeThemeColor(overrides.chrome) || canvas;
  const surface = normalizeThemeColor(overrides.surface) || mixColors(canvas, text, dark ? 0.035 : 0.015);
  const surfaceRaised = normalizeThemeColor(overrides.surfaceRaised) || mixColors(surface, text, dark ? 0.12 : 0.035);
  const surfacePopover = normalizeThemeColor(overrides.surfacePopover) || mixColors(surfaceRaised, text, dark ? 0.1 : 0.025);
  const surfaceHover = normalizeThemeColor(overrides.surfaceHover) || mixColors(surfacePopover, text, dark ? 0.16 : 0.08);
  const surfaceSelected = normalizeThemeColor(overrides.surfaceSelected) || mixColors(surface, accentColor, dark ? 0.18 : 0.1);
  const border = normalizeThemeColor(overrides.border) || mixColors(canvas, text, dark ? 0.2 : 0.12);
  const borderStrong = normalizeThemeColor(overrides.borderStrong) || mixColors(border, text, 0.4);
  const accentContrast = normalizeThemeColor(overrides.accentContrast) || readableThemeForeground(accentColor);
  return {
    chrome,
    surface,
    surfaceRaised,
    surfacePopover,
    surfaceHover,
    surfaceSelected,
    text,
    textMuted: muted,
    textSubtle: subtle,
    border,
    borderStrong,
    accent: accentColor,
    accentContrast,
    danger: normalizeThemeColor(overrides.danger) || (dark ? "#ff777d" : "#bd2735"),
    warning: normalizeThemeColor(overrides.warning) || (dark ? "#ffbd66" : "#a65c00"),
    success: normalizeThemeColor(overrides.success) || (dark ? "#79d69d" : "#197343"),
    info: normalizeThemeColor(overrides.info) || accentColor,
    ring: normalizeThemeColor(overrides.ring) || accentColor,
    controlOn: normalizeThemeColor(overrides.controlOn) || accentColor,
    controlOnContrast: normalizeThemeColor(overrides.controlOnContrast) || accentContrast,
    scrim: normalizeThemeColor(overrides.scrim) || (dark ? "#000000b8" : "#00000066"),
  };
}

export const BUILT_IN_THEMES = [
  {
    id: DEFAULT_THEME_ID,
    label: "Aurral",
    appearance: "light",
    colors: createThemeColors("light", "#ffffff", "#4d7c0f", {
      chrome: "#e5e7eb",
      surface: "#ffffff",
      surfaceRaised: "#f1f1f1",
      surfacePopover: "#e4e4e4",
      surfaceHover: "#d0d0d0",
      surfaceSelected: "#efefef",
      text: "#171717",
      textMuted: "#525252",
      textSubtle: "#737373",
      border: "#17171714",
      borderStrong: "#17171724",
      accentContrast: "#ffffff",
      danger: "#dc2626",
      warning: "#b45309",
      success: "#15803d",
      info: "#2563eb",
      ring: "#17171775",
      controlOn: "#2563eb",
      controlOnContrast: "#ffffff",
      scrim: "#e5e7ebb8",
    }),
    variants: {
      dark: createThemeColors("dark", "#121212", "#84cc16", {
        chrome: "#000000",
        surface: "#121212",
        surfaceRaised: "#202020",
        surfacePopover: "#2d2d2d",
        surfaceHover: "#424242",
        surfaceSelected: "#232323",
        text: "#ffffff",
        textMuted: "#b3b3b3",
        textSubtle: "#535353",
        border: "#ffffff14",
        borderStrong: "#ffffff24",
        accentContrast: "#000000",
        danger: "#ef4444",
        warning: "#f59e0b",
        success: "#22c55e",
        info: "#60a5fa",
        ring: "#ffffff75",
        controlOn: "#3b82f6",
        controlOnContrast: "#07111f",
        scrim: "#000000b8",
      }),
    },
  },
];

const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEMES.map((theme) => theme.id));
const RESERVED_THEME_IDS = new Set(["system", "light", "dark", ...BUILT_IN_THEMES.map((theme) => theme.id)]);

export function getThemeModes(theme) {
  return ["light", "dark"].filter((mode) => mode === theme.appearance || Boolean(theme.variants?.[mode]));
}

export function getThemeColorsForMode(theme, mode) {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] || null;
}

export function themeIdFromName(name) {
  const id = String(name || "custom-theme")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return RESERVED_THEME_IDS.has(id) ? `${id}-custom` : id || "custom-theme";
}

function isThemeId(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeAppearance(value) {
  return value === "light" || value === "dark";
}

function isThemeMode(value) {
  return THEME_APPEARANCES.includes(value);
}

function isThemeLabel(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function getDefaultThemeColors(appearance) {
  const theme = BUILT_IN_THEMES[0];
  return getThemeColorsForMode(theme, appearance) || theme.colors;
}

function parseThemeColors(value, appearance) {
  if (!isRecord(value)) throw new Error("Theme colors must be an object.");
  const colors = { ...getDefaultThemeColors(appearance) };
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported Aurral theme color role.`);
    const normalized = normalizeThemeColor(color);
    if (!normalized) throw new Error(`The color for "${role}" is invalid.`);
    colors[role] = normalized;
  }
  return colors;
}

export function parseThemeFile(value) {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }
  const label = value.name ?? value.label;
  if (!isThemeLabel(label)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(value.appearance)) throw new Error('Theme files need an appearance of "light" or "dark".');
  const id = value.id === undefined ? themeIdFromName(label) : value.id;
  if (!isThemeId(id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);
  const colors = parseThemeColors(value.colors, value.appearance);
  const variants = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [mode, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(mode) || mode === value.appearance) throw new Error("Theme variants must contain the other light or dark appearance.");
      variants[mode] = parseThemeColors(variantColors, mode);
    }
  }
  return {
    id,
    label: label.trim(),
    appearance: value.appearance,
    colors,
    ...(Object.keys(variants).length ? { variants } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function storedThemeFile(theme) {
  return {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.managed ? { managed: true } : {}),
  };
}

let customThemeCache = null;
const customThemeListeners = new Set();
const themeListeners = new Set();

function notify(listeners) {
  for (const listener of listeners) listener();
}

function readCustomThemes() {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      try {
        const theme = parseThemeFile(value);
        return BUILT_IN_THEME_IDS.has(theme.id) ? [] : [theme];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function getCustomThemes() {
  if (customThemeCache === null) customThemeCache = readCustomThemes();
  return customThemeCache;
}

export function invalidateThemeCaches() {
  customThemeCache = null;
}

export function subscribeToCustomThemes(listener) {
  customThemeListeners.add(listener);
  return () => customThemeListeners.delete(listener);
}

export function subscribeToThemeChanges(listener) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function saveCustomThemes(themes) {
  try {
    globalThis.localStorage?.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes.map(storedThemeFile)));
  } catch {
    throw new Error("Aurral could not save themes on this device.");
  }
  customThemeCache = themes;
  notify(customThemeListeners);
}

export function installCustomTheme(theme) {
  const normalized = parseThemeFile(storedThemeFile(theme));
  if (RESERVED_THEME_IDS.has(normalized.id)) throw new Error(`The theme id "${normalized.id}" is reserved.`);
  if ([...BUILT_IN_THEMES, ...getCustomThemes()].some((item) => item.id === normalized.id)) {
    throw new Error(`A theme named "${normalized.label}" is already installed.`);
  }
  saveCustomThemes([...getCustomThemes(), normalized]);
  return normalized;
}

export function replaceCustomTheme(theme) {
  const normalized = parseThemeFile(storedThemeFile(theme));
  if (RESERVED_THEME_IDS.has(normalized.id)) throw new Error(`The theme id "${normalized.id}" is reserved.`);
  const themes = getCustomThemes();
  if (!themes.some((item) => item.id === normalized.id)) throw new Error(`The theme "${normalized.label}" is not installed.`);
  saveCustomThemes(themes.map((item) => item.id === normalized.id ? normalized : item));
  return normalized;
}

export function removeCustomTheme(themeId) {
  saveCustomThemes(getCustomThemes().filter((theme) => theme.id !== themeId));
}

export function getThemeDefinition(themeId) {
  return BUILT_IN_THEMES.find((theme) => theme.id === themeId) || getCustomThemes().find((theme) => theme.id === themeId) || null;
}

export function normalizeThemePreference(value) {
  if (THEME_PREFERENCES.includes(value)) return value;
  return getThemeDefinition(value) ? value : "system";
}

function readStoredValue(key) {
  try {
    return globalThis.localStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

export function getThemeSettings() {
  const storedTheme = readStoredValue(THEME_STORAGE_KEY);
  if (THEME_PREFERENCES.includes(storedTheme)) return { themeId: DEFAULT_THEME_ID, appearance: storedTheme };
  const themeId = getThemeDefinition(storedTheme) ? storedTheme : DEFAULT_THEME_ID;
  const storedAppearance = readStoredValue(THEME_APPEARANCE_STORAGE_KEY);
  return { themeId, appearance: isThemeMode(storedAppearance) ? storedAppearance : "system" };
}

export function getThemePreference() {
  const stored = readStoredValue(THEME_STORAGE_KEY);
  return stored && (THEME_PREFERENCES.includes(stored) || getThemeDefinition(stored)) ? stored : "system";
}

function writeThemeSettings(themeId, appearance) {
  try {
    if (themeId === DEFAULT_THEME_ID && THEME_PREFERENCES.includes(appearance)) {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, appearance);
      globalThis.localStorage?.removeItem(THEME_APPEARANCE_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, themeId);
      globalThis.localStorage?.setItem(THEME_APPEARANCE_STORAGE_KEY, appearance);
    }
  } catch {}
}

function getSystemAppearance() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemeSelection(selection = getThemeSettings()) {
  const theme = getThemeDefinition(selection.themeId) || BUILT_IN_THEMES[0];
  const wantedMode = selection.appearance === "system" ? getSystemAppearance() : selection.appearance;
  const mode = getThemeColorsForMode(theme, wantedMode) ? wantedMode : theme.appearance;
  return { theme, mode, colors: getThemeColorsForMode(theme, mode) || theme.colors };
}

function applyResolvedTheme(resolved, selection) {
  const root = globalThis.document?.documentElement;
  if (!root) return resolved;
  if (root.style) {
    for (const variable of Object.values(THEME_VARIABLES)) root.style.removeProperty(variable);
    for (const [role, value] of Object.entries(resolved.colors)) root.style.setProperty(THEME_VARIABLES[role], value);
    root.style.colorScheme = resolved.mode;
  }
  const followsSystem = selection.themeId === DEFAULT_THEME_ID && selection.appearance === "system";
  if (followsSystem) {
    root.removeAttribute?.("data-theme");
    root.removeAttribute?.("data-theme-id");
  } else {
    root.setAttribute?.("data-theme", resolved.mode);
    root.setAttribute?.("data-theme-id", resolved.theme.id);
  }
  for (const meta of globalThis.document.querySelectorAll?.('meta[name="theme-color"]') || []) meta.setAttribute("content", resolved.colors.chrome);
  return resolved;
}

export function applyThemeSelection(selection = getThemeSettings()) {
  return applyResolvedTheme(resolveThemeSelection(selection), selection);
}

export function applyThemePreview(theme, appearance = getThemeSettings().appearance) {
  const wantedMode = appearance === "system" ? getSystemAppearance() : appearance;
  const mode = getThemeColorsForMode(theme, wantedMode) ? wantedMode : theme.appearance;
  const resolved = { theme, mode, colors: getThemeColorsForMode(theme, mode) || theme.colors };
  return applyResolvedTheme(resolved, { themeId: theme.id, appearance });
}

export function setThemeSelection(themeId, appearance = "system") {
  const nextThemeId = getThemeDefinition(themeId) ? themeId : DEFAULT_THEME_ID;
  const nextAppearance = isThemeMode(appearance) ? appearance : "system";
  writeThemeSettings(nextThemeId, nextAppearance);
  const settings = { themeId: nextThemeId, appearance: nextAppearance };
  applyThemeSelection(settings);
  notify(themeListeners);
  return settings;
}

export function setThemePreference(value) {
  if (THEME_PREFERENCES.includes(value)) return setThemeSelection(DEFAULT_THEME_ID, value).appearance;
  if (getThemeDefinition(value)) return setThemeSelection(value, getThemeSettings().appearance).themeId;
  return setThemeSelection(DEFAULT_THEME_ID, "system").appearance;
}

let initialized = false;

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  applyThemeSelection();
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getThemeSettings().appearance === "system") {
        applyThemeSelection();
        notify(themeListeners);
      }
    };
    media.addEventListener?.("change", onChange);
    window.addEventListener("storage", (event) => {
      if ([THEME_STORAGE_KEY, THEME_APPEARANCE_STORAGE_KEY, CUSTOM_THEMES_STORAGE_KEY].includes(event.key)) {
        customThemeCache = null;
        applyThemeSelection();
        notify(customThemeListeners);
        notify(themeListeners);
      }
    });
  }
}

export function createUniqueThemeName(theme, existing = [...BUILT_IN_THEMES, ...getCustomThemes()]) {
  const occupied = new Set(existing.map((item) => item.id));
  if (!occupied.has(theme.id)) return theme;
  for (let index = 2; index < 100; index += 1) {
    const label = `${theme.label} ${index}`.slice(0, 48);
    const candidate = { ...theme, id: themeIdFromName(label), label };
    if (!occupied.has(candidate.id)) return candidate;
  }
  throw new Error(`Too many copies of "${theme.label}".`);
}
