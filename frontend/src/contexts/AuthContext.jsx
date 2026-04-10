import { createContext, useContext, useState, useEffect } from "react";
import {
  AUTH_INVALID_EVENT,
  checkHealth,
  clearAuthStorage,
  getMe,
  getStoredAuth,
  loginApi,
  logoutApi,
  setStoredAuth,
} from "../utils/api";

const AuthContext = createContext(null);
const AUTH_RECOVERY_RELOAD_KEY = "aurral:auth-recovery-reload";

const resetClientCache = async () => {
  const registrations = globalThis?.navigator?.serviceWorker
    ? await globalThis.navigator.serviceWorker.getRegistrations()
    : [];
  const cacheKeys = globalThis?.caches ? await globalThis.caches.keys() : [];

  await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  await Promise.allSettled(
    cacheKeys.map((cacheKey) => globalThis.caches.delete(cacheKey)),
  );

  return registrations.length > 0 || cacheKeys.length > 0;
};

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuthStatus = async () => {
    try {
      const healthData = await checkHealth();
      const isOnboarding = !!healthData.onboardingRequired;
      setOnboardingRequired(isOnboarding);

      if (isOnboarding) {
        setIsAuthenticated(false);
        setUser(null);
        setIsLoading(false);
        return;
      }

      const isRequired = healthData.authRequired;
      setAuthRequired(isRequired);

      if (isRequired && healthData.user) {
        setUser(healthData.user);
        setIsAuthenticated(true);
        setIsLoading(false);
        return;
      }

      if (!isRequired) {
        setUser(
          healthData.user || {
            role: "admin",
            permissions: {
              accessSettings: true,
              accessFlow: true,
              addArtist: true,
              addAlbum: true,
              changeMonitoring: true,
              deleteArtist: true,
              deleteAlbum: true,
            },
          }
        );
        setIsAuthenticated(true);
        setIsLoading(false);
        return;
      }

      const { token } = getStoredAuth();
      if (token) {
        try {
          const me = await getMe();
          setUser(me.user || null);
          setIsAuthenticated(!!me.user);
        } catch {
          clearAuthStorage();
          setUser(null);
          setIsAuthenticated(false);
        }
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch {
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      globalThis?.sessionStorage?.removeItem(AUTH_RECOVERY_RELOAD_KEY);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const handleInvalidAuth = async () => {
      setIsAuthenticated(false);
      setUser(null);
      setIsLoading(true);

      const hadClientCache = await resetClientCache();
      if (cancelled) return;

      const hasReloaded =
        globalThis?.sessionStorage?.getItem(AUTH_RECOVERY_RELOAD_KEY) === "1";

      if (hadClientCache && !hasReloaded && typeof window !== "undefined") {
        globalThis.sessionStorage?.setItem(AUTH_RECOVERY_RELOAD_KEY, "1");
        window.location.reload();
        return;
      }

      globalThis?.sessionStorage?.removeItem(AUTH_RECOVERY_RELOAD_KEY);
      await checkAuthStatus();
    };

    window.addEventListener(AUTH_INVALID_EVENT, handleInvalidAuth);
    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_INVALID_EVENT, handleInvalidAuth);
    };
  }, []);

  const login = async (password, username) => {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername || !password) return false;

    try {
      const result = await loginApi(normalizedUsername, password);
      if (!result?.token) return false;
      setStoredAuth({ token: result.token });
      setUser(result.user || null);
      setIsAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  };

  const logout = async () => {
    try {
      await logoutApi();
    } catch {}
    clearAuthStorage();
    setIsAuthenticated(false);
    setUser(null);
  };

  const hasPermission = (perm) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return !!user.permissions?.[perm];
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        login,
        logout,
        authRequired,
        onboardingRequired,
        refreshAuth: checkAuthStatus,
        hasPermission,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

/* eslint-disable-next-line react-refresh/only-export-components */
export const useAuth = () => useContext(AuthContext);
