const DOCUMENT_VERSION = 2;
const APPEARANCES: ReadonlySet<unknown> = new Set(["system", "light", "dark"]);
const MODES = ["light", "dark"] as const;
const SEED_ROLES = [
  "background",
  "text",
  "accent",
  "danger",
  "warning",
  "success",
  "info",
] as const;
const MAX_THEMES = 50;
const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

export class ThemeValidationError extends Error {}

type SeedRole = (typeof SEED_ROLES)[number];
type ThemeSeed = Partial<Record<SeedRole, string>>;
type UserTheme = { id: string; name: string; light?: ThemeSeed; dark?: ThemeSeed };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeColor(value: unknown) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[\da-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  return /^[\da-f]{6}$/.test(hex) ? `#${hex}` : null;
}

function normalizeSeed(value: unknown, label: string): ThemeSeed {
  if (!isRecord(value)) throw new ThemeValidationError(`${label} must be an object`);
  const seed: ThemeSeed = {};
  for (const role of SEED_ROLES) {
    if (value[role] === undefined || value[role] === null) continue;
    const color = normalizeColor(value[role]);
    if (!color) throw new ThemeValidationError(`${label}.${role} must be a hex color`);
    seed[role] = color;
  }
  if (!seed.background || !seed.accent)
    throw new ThemeValidationError(`${label} needs background and accent colors`);
  return seed;
}

function normalizeTheme(value: unknown, index: number): UserTheme {
  const label = `themes[${index}]`;
  if (!isRecord(value)) throw new ThemeValidationError(`${label} must be an object`);
  if (typeof value.id !== "string" || !THEME_ID.test(value.id))
    throw new ThemeValidationError(`${label}.id is invalid`);
  const name = typeof value.name === "string" ? value.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 48)
    throw new ThemeValidationError(`${label}.name must be 1 to 48 characters`);
  const theme: UserTheme = { id: value.id, name };
  for (const mode of MODES) {
    if (value[mode] !== undefined && value[mode] !== null)
      theme[mode] = normalizeSeed(value[mode], `${label}.${mode}`);
  }
  if (!theme.light && !theme.dark)
    throw new ThemeValidationError(`${label} needs light or dark colors`);
  return theme;
}

export function normalizeUserThemeDocument(value: unknown) {
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION) {
    throw new ThemeValidationError(`theme.version must be ${DOCUMENT_VERSION}`);
  }
  if (!APPEARANCES.has(value.appearance))
    throw new ThemeValidationError("theme.appearance must be system, light, or dark");
  if (typeof value.themeId !== "string" || !THEME_ID.test(value.themeId))
    throw new ThemeValidationError("theme.themeId is invalid");
  if (!Array.isArray(value.themes) || value.themes.length > MAX_THEMES) {
    throw new ThemeValidationError(`theme.themes must be a list of up to ${MAX_THEMES} themes`);
  }
  const themes = value.themes.map(normalizeTheme);
  if (new Set(themes.map((theme) => theme.id)).size !== themes.length) {
    throw new ThemeValidationError("theme.themes has duplicate ids");
  }
  return {
    version: DOCUMENT_VERSION,
    themeId: value.themeId,
    appearance: value.appearance as "system" | "light" | "dark",
    matchArtwork: value.matchArtwork === true,
    themes,
  };
}
