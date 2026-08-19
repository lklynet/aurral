try {
  const theme = localStorage.getItem("aurralTheme");
  const appearance = localStorage.getItem("aurralThemeAppearance:v1");
  const mode = theme === "light" || theme === "dark"
    ? theme
    : appearance === "light" || appearance === "dark"
      ? appearance
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = mode;
  if (theme && theme !== "system" && theme !== "light" && theme !== "dark") {
    document.documentElement.dataset.themeId = theme;
  }
} catch {}
