import { isDarkColor, normalizeHexColor } from "./themeColor.js";
import { convertLegacyTheme, normalizeThemeName, THEME_DOCUMENT_VERSION, THEME_MODES } from "./theme.js";

export const THEME_GALLERY_URL = "https://tinted-theming.github.io/tinted-gallery/";
export const MAX_THEME_FILE_BYTES = 64 * 1024;

function readYamlScalar(raw) {
  const quoted = raw.match(/^(["'])(.*?)\1/);
  if (quoted) return quoted[2];
  return raw.replace(/\s+#.*$/, "").trim();
}

function parseBase16Scheme(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = readYamlScalar(match[2]);
  }
  const color = (key) => normalizeHexColor(values[key] || values[key.replace(/[A-F]$/, (letter) => letter.toLowerCase())]);
  const background = color("base00");
  const text0 = color("base05");
  const accent = color("base0D");
  if (!background || !text0 || !accent) {
    throw new Error("Paste an Aurral theme file or a base16 or base24 scheme.");
  }
  const mode = isDarkColor(background) ? "dark" : "light";
  const seed = { background, text: text0, accent };
  for (const [role, key] of [["danger", "base08"], ["warning", "base0A"], ["success", "base0B"], ["info", "base0C"]]) {
    const value = color(key);
    if (value) seed[role] = value;
  }
  return { name: (values.name || values.scheme || "Imported theme").slice(0, 48), [mode]: seed };
}

function parseThemeFile(value) {
  if (value?.version === THEME_DOCUMENT_VERSION) {
    const theme = { name: value.name };
    for (const mode of THEME_MODES) if (value[mode]) theme[mode] = value[mode];
    return theme;
  }
  if (value?.version === 1) {
    const { name, light, dark } = convertLegacyTheme(value);
    return { name, ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
  }
  throw new Error("This theme file uses a version Aurral can't read.");
}

export function parseThemeText(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("Paste a theme or choose a file.");
  if (new TextEncoder().encode(source).byteLength > MAX_THEME_FILE_BYTES) {
    throw new Error("That file is too large to be a theme.");
  }
  if (source.startsWith("{")) {
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("That theme file isn't valid JSON.");
    }
    const theme = parseThemeFile(value);
    return { ...theme, name: normalizeThemeName(theme.name) };
  }
  return parseBase16Scheme(source);
}

export function serializeThemeFile(theme) {
  return `${JSON.stringify({
    version: THEME_DOCUMENT_VERSION,
    name: theme.name,
    ...(theme.light ? { light: theme.light } : {}),
    ...(theme.dark ? { dark: theme.dark } : {}),
  }, null, 2)}\n`;
}
