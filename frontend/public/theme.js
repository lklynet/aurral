try {
  const theme = localStorage.getItem("aurralTheme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
