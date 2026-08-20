try {
  const theme = localStorage.getItem("aurralTheme");
  const appearance = localStorage.getItem("aurralThemeAppearance:v1");
  const systemMode = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const requestedMode = theme === "light" || theme === "dark"
    ? theme
    : appearance === "light" || appearance === "dark"
      ? appearance
      : systemMode;
  const root = document.documentElement;
  let mode = requestedMode;

  if (theme && theme !== "system" && theme !== "light" && theme !== "dark") {
    const storedThemes = JSON.parse(localStorage.getItem("aurralThemes:v1") || "[]");
    const selected = Array.isArray(storedThemes) ? storedThemes.find((item) => item?.id === theme) : null;
    const colors = selected?.variants?.[requestedMode] || selected?.colors;
    if (selected?.variants?.[requestedMode]) mode = requestedMode;
    else if (selected?.appearance === "light" || selected?.appearance === "dark") mode = selected.appearance;
    if (root.style && colors && typeof colors === "object") {
      for (const [role, value] of Object.entries(colors)) {
        if (/^#[\da-f]{3,8}$/i.test(value)) {
          root.style.setProperty(`--aurral-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
        }
      }
    }
    root.dataset.themeId = theme;
  }

  root.dataset.theme = mode;
  if (root.style) root.style.colorScheme = mode;
} catch {}
