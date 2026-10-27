import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { asApiError, clearAuthStorage, getStoredAuth, setStoredAuth } from "../utils/api/core.ts";
import { parseResponse } from "hono/client";
import { authClient } from "../utils/api/clients/auth.ts";
import {
  getBootstrapStatus,
  invalidateBootstrapCache,
  type BootstrapPayload,
} from "../utils/appHealth.ts";
import { logIn, logOut } from "../utils/session.ts";
import { clearLibraryFavoritesCache } from "../utils/api/endpoints/library.ts";
import { setDateTimeFormat } from "../utils/dateTime.ts";
import { queryClient } from "../queryClient.ts";
import type { ReactNode } from "react";

type AuthUser = {
  id?: number;
  username?: string;
  role: string;
  permissions: Record<string, unknown>;
};
type LoginResult = { ok: boolean; status?: number };
type AuthContextValue = {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  bootstrap: BootstrapPayload | null;
  login: (password: string, username: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  canLogOut: boolean;
  authRequired: boolean;
  onboardingRequired: boolean;
  refreshAuth: () => Promise<boolean>;
  hasPermission: (perm: string) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const authResolvedRef = useRef(false);

  const checkAuthStatus = useCallback(async () => {
    try {
      const bootstrap = await getBootstrapStatus();
      authResolvedRef.current = true;
      setDateTimeFormat(bootstrap.dateTimeFormat);
      setBootstrap(bootstrap);
      if (bootstrap.token) setStoredAuth({ token: bootstrap.token });
      const isOnboarding = !!bootstrap.onboardingRequired;
      setOnboardingRequired(isOnboarding);

      if (isOnboarding) {
        setIsAuthenticated(false);
        setUser(null);
        setIsLoading(false);
        return true;
      }

      const isRequired = bootstrap.authRequired;
      setAuthRequired(isRequired);

      if (isRequired && bootstrap.user) {
        setUser(bootstrap.user);
        setIsAuthenticated(true);
        setIsLoading(false);
        return true;
      }

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
              deleteTrack: true,
            },
          },
        );
        setIsAuthenticated(true);
        setIsLoading(false);
        return true;
      }

      const { token } = getStoredAuth();
      if (token) {
        try {
          const me = await parseResponse(authClient.me.$get());
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
      return true;
    } catch {
      if (!authResolvedRef.current) {
        setBootstrap(null);
        setUser(null);
        setIsAuthenticated(false);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  const login = useCallback(async (password: string, username: string) => {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername || !password) return { ok: false };

    try {
      const result = await logIn(normalizedUsername, password);
      if (!result?.token) return { ok: false };
      authResolvedRef.current = true;
      clearLibraryFavoritesCache();
      queryClient.clear();
      setStoredAuth({ token: result.token });
      setUser(result.user || null);
      setIsAuthenticated(true);
      try {
        const bootstrap = await getBootstrapStatus();
        setDateTimeFormat(bootstrap.dateTimeFormat);
        setBootstrap(bootstrap);
      } catch {}
      return { ok: true };
    } catch (error) {
      return { ok: false, status: asApiError(error)?.response?.status };
    }
  }, []);

  const logout = useCallback(async () => {
    const externalLogoutUrl = bootstrap?.oidcLogoutUrl || bootstrap?.proxyLogoutUrl;
    if (externalLogoutUrl) {
      void logOut().catch(() => {});
      clearAuthStorage();
      clearLibraryFavoritesCache();
      queryClient.clear();
      invalidateBootstrapCache();
      window.location.href = externalLogoutUrl;
      return;
    }

    try {
      await logOut();
    } catch {}
    clearAuthStorage();
    clearLibraryFavoritesCache();
    queryClient.clear();
    invalidateBootstrapCache();
    setIsAuthenticated(false);
    setUser(null);
  }, [bootstrap]);

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return !!user.permissions?.[perm];
    },
    [user],
  );

  const canLogOut = !bootstrap?.proxyAuthEnabled || !!bootstrap?.proxyLogoutUrl;

  return (
    <AuthContext.Provider
      value={useMemo(
        () => ({
          isAuthenticated,
          isLoading,
          user,
          bootstrap,
          login,
          logout,
          canLogOut,
          authRequired,
          onboardingRequired,
          refreshAuth: checkAuthStatus,
          hasPermission,
        }),
        [
          isAuthenticated,
          isLoading,
          user,
          bootstrap,
          login,
          logout,
          canLogOut,
          authRequired,
          onboardingRequired,
          checkAuthStatus,
          hasPermission,
        ],
      )}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export const useOptionalAuth = () => useContext(AuthContext);
