import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "@fontsource-variable/inter/opsz.css";
import "./index.css";
import { reportClientError, startErrorReporting } from "./utils/errorReporting.ts";
import { initializeTheme } from "./utils/theme.ts";
import { getBootstrapStatus } from "./utils/appHealth.ts";
import { getAppBasePath } from "./utils/basePath.ts";
import { prefetchRoute } from "./navigation/routePrefetch.ts";

const UPDATE_RELOAD_AT_KEY = "aurral:update-reload-at";
const UPDATE_RELOAD_COOLDOWN_MS = 30000;

initializeTheme();

const prefetchCurrentRoute = async () => {
  const bootstrap = await getBootstrapStatus();
  if (bootstrap.onboardingRequired || (bootstrap.authRequired && !bootstrap.user)) return;
  const base = getAppBasePath();
  const { pathname, search } = window.location;
  const path = base === "/" ? pathname : pathname.slice(base.length) || "/";
  await prefetchRoute(path + search, { userId: bootstrap.user?.id ?? null });
};

if (!window.location.pathname.endsWith("/oauth.html")) {
  window.addEventListener("vite:preloadError", () => {
    const lastAt = Number(globalThis?.sessionStorage?.getItem(UPDATE_RELOAD_AT_KEY) || 0);
    if (Date.now() - lastAt < UPDATE_RELOAD_COOLDOWN_MS) return;
    globalThis?.sessionStorage?.setItem(UPDATE_RELOAD_AT_KEY, String(Date.now()));
    window.location.reload();
  });
  startErrorReporting();
  prefetchCurrentRoute().catch(() => {});
  ReactDOM.createRoot(document.getElementById("root")!, {
    onCaughtError: (error, { componentStack }) => {
      console.error(error);
      reportClientError("react", error, componentStack);
    },
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
