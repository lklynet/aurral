import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  clearAuthStorage,
  getStoredAuth,
  setStoredAuth,
} from "../utils/api/core.js";
import {
  getBootstrapStatus,
  getMe,
  invalidateBootstrapCache,
  loginApi,
  logoutApi,
} from "../utils/api/endpoints/auth.js";
import {
  beginLogoutNavigation,
  endLogoutNavigation,
  isProxyAuthActive,
  syncProxyAuthFromBootstrap,
} from "../utils/authRecovery.js";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const [user, setUser] = useState(null);
  const [bootstrap, setBootstrap] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuthStatus = useCallback(async () => {
    try {
      const bootstrap = await getBootstrapStatus();
      setBootstrap(bootstrap);
      const isOnboarding = !!bootstrap.onboardingRequired;
      setOnboardingRequired(isOnboarding);

      if (isOnboarding) {
        setIsAuthenticated(false);
        setUser(null);
        setIsLoading(false);
        return;
      }

      const isRequired = bootstrap.authRequired;
      setAuthRequired(isRequired);

      if (isRequired && bootstrap.user) {
        syncProxyAuthFromBootstrap(bootstrap);
        setUser(bootstrap.user);
        setIsAuthenticated(true);
        setIsLoading(false);
        return;
      }

      syncProxyAuthFromBootstrap();

      if (!isRequired) {
        setUser(
          bootstrap.user || {
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
          },
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
      setBootstrap(null);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  const login = useCallback(async (password, username) => {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername || !password) return false;

    try {
      const result = await loginApi(normalizedUsername, password);
      if (!result?.token) return false;
      setStoredAuth({ token: result.token });
      setUser(result.user || null);
      setIsAuthenticated(true);
      try {
        setBootstrap(await getBootstrapStatus());
      } catch {}
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    beginLogoutNavigation();
    try {
      await logoutApi();
    } catch {}
    clearAuthStorage();
    invalidateBootstrapCache();

    let proxyLogoutUrl = bootstrap?.proxyLogoutUrl;
    if (!proxyLogoutUrl && isProxyAuthActive()) {
      try {
        proxyLogoutUrl = (await getBootstrapStatus())?.proxyLogoutUrl;
      } catch {}
    }

    if (proxyLogoutUrl) {
      window.location.href = proxyLogoutUrl;
      return;
    }
    endLogoutNavigation();
    setIsAuthenticated(false);
    setUser(null);
  }, [bootstrap]);

  const hasPermission = useCallback((perm) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return !!user.permissions?.[perm];
  }, [user]);

  return (
    <AuthContext.Provider
      value={useMemo(() => ({
        isAuthenticated,
        isLoading,
        user,
        bootstrap,
        login,
        logout,
        authRequired,
        onboardingRequired,
        refreshAuth: checkAuthStatus,
        hasPermission,
      }), [isAuthenticated, isLoading, user, bootstrap, login, logout, authRequired, onboardingRequired, checkAuthStatus, hasPermission])}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
