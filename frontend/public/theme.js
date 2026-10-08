try {
  const root = document.documentElement;
  const paint = JSON.parse(localStorage.getItem("aurralThemePaint:v1") || "null");
  const legacy = localStorage.getItem("aurralTheme");
  const appearance = paint ? paint.appearance : legacy === "light" || legacy === "dark" ? legacy : localStorage.getItem("aurralThemeAppearance:v1");
  const mode = appearance === "light" || appearance === "dark"
    ? appearance
    : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const colors = paint && paint[mode];
  if (colors && typeof colors === "object") {
    for (const [role, value] of Object.entries(colors)) {
      if (/^[a-z]+$/i.test(role) && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) {
        root.style.setProperty(`--aurral-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
      }
    }
  }
  if (paint && typeof paint.themeId === "string") root.dataset.themeId = paint.themeId;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
} catch {}
