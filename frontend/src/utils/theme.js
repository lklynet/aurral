export const THEME_STORAGE_KEY = "aurralTheme";
export const THEME_PREFERENCES = ["system", "light", "dark"];

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : "system";
}

export function getThemePreference() {
  try {
    return normalizeThemePreference(globalThis.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function setThemePreference(value) {
  const preference = normalizeThemePreference(value);

  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {}

  const root = globalThis.document?.documentElement;
  if (preference === "system") {
    root?.removeAttribute("data-theme");
  } else {
    root?.setAttribute("data-theme", preference);
  }

  return preference;
}
