import { normalizeBasePathWithTrailingSlash } from "./basePath.js";

export const PROXY_AUTH_KEY = "aurral:proxy-auth";
export const PROXY_RELOAD_TS_KEY = "aurral:proxy-reload-ts";
export const REAUTH_ATTEMPT_KEY = "aurral:reauth-attempts";

const REAUTH_ATTEMPT_WINDOW_MS = 30000;
const REAUTH_MAX_ATTEMPTS = 3;

export const isProxyAuthActive = () =>
  globalThis?.sessionStorage?.getItem(PROXY_AUTH_KEY) === "1";

export const syncProxyAuthFromBootstrap = (bootstrap) => {
  if (bootstrap?.proxyAuthEnabled) {
    globalThis?.sessionStorage?.setItem(PROXY_AUTH_KEY, "1");
  } else {
    globalThis?.sessionStorage?.removeItem(PROXY_AUTH_KEY);
  }
};

let logoutNavigationPending = false;

export const beginLogoutNavigation = () => {
  logoutNavigationPending = true;
};

export const endLogoutNavigation = () => {
  logoutNavigationPending = false;
};

export const registerReauthAttempt = () => {
  if (logoutNavigationPending) return false;
  const storage = globalThis?.sessionStorage;
  if (!storage) return true;
  let state;
  try {
    state = JSON.parse(storage.getItem(REAUTH_ATTEMPT_KEY) || "null");
  } catch {
    state = null;
  }
  const now = Date.now();
  if (!state || now - state.firstAt > REAUTH_ATTEMPT_WINDOW_MS) {
    state = { count: 0, firstAt: now };
  }
  state.count += 1;
  storage.setItem(REAUTH_ATTEMPT_KEY, JSON.stringify(state));
  if (state.count > REAUTH_MAX_ATTEMPTS) {
    console.error(
      "[Aurral] Repeated auth-recovery navigations in a short window; stopping to avoid a loop. " +
        "Check the reverse proxy / forwardAuth configuration.",
    );
    return false;
  }
  return true;
};

export const resetClientCache = async () => {
  const registrations = globalThis?.navigator?.serviceWorker
    ? await globalThis.navigator.serviceWorker.getRegistrations()
    : [];
  const cacheKeys = globalThis?.caches ? await globalThis.caches.keys() : [];

  await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  await Promise.allSettled(cacheKeys.map((cacheKey) => globalThis.caches.delete(cacheKey)));

  return registrations.length > 0 || cacheKeys.length > 0;
};

export const hardNavigateHome = (basePath = "/") => {
  if (typeof window === "undefined") return;
  const path = normalizeBasePathWithTrailingSlash(basePath);
  window.location.href = `${window.location.origin}${path}`;
};

export const clearAuthRecoveryFlags = () => {
  globalThis?.sessionStorage?.removeItem(PROXY_RELOAD_TS_KEY);
  globalThis?.sessionStorage?.removeItem(PROXY_AUTH_KEY);
  globalThis?.sessionStorage?.removeItem(REAUTH_ATTEMPT_KEY);
};
