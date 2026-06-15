import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { useState, useEffect, Suspense, lazy, useRef } from "react";
import PropTypes from "prop-types";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import { getBootstrapStatus } from "./utils/api";
import { AudioPlayerProvider } from "react-use-audio-player";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AudioQueueProvider } from "./contexts/AudioQueueProvider";
import ReloadPrompt from "./components/ReloadPrompt";
import UpdateBanner from "./components/UpdateBanner";
import { useWebSocketChannel } from "./hooks/useWebSocket";

const SearchResultsPage = lazy(() => import("./pages/SearchResultsPage"));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage"));
const ShowsPage = lazy(() => import("./pages/ShowsPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const SettingsPage = lazy(() => import("./pages/Settings/SettingsPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const MetadataProvidersPage = lazy(
  () => import("./pages/Settings/MetadataProvidersPage"),
);
const ArtistDetailsPage = lazy(
  () => import("./pages/ArtistDetails/ArtistDetailsPage"),
);
const ArtistAlbumsPage = lazy(
  () => import("./pages/ArtistDetails/ArtistAlbumsPage"),
);
const ReleasePage = lazy(() => import("./pages/ArtistDetails/ReleasePage"));
const ArtistAppearsOnPage = lazy(
  () => import("./pages/ArtistDetails/ArtistAppearsOnPage"),
);
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const FlowPage = lazy(() => import("./pages/FlowPage"));
const DISCOVERY_MANUAL_REFRESH_KEY = "aurral.discovery.manualRefreshPending";

const normalizeBasePath = (baseUrl) => {
  const raw = (baseUrl || "/").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
};

const PageLoader = () => (
  <div className="app-loading">
    <div className="app-loading__spinner" />
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading, authRequired, onboardingRequired } =
    useAuth();

  if (isLoading) {
    return (
      <div className="app-loading app-loading--screen">
        <div className="app-loading__spinner app-loading__spinner--lg" />
      </div>
    );
  }

  if (onboardingRequired) {
    return <Onboarding />;
  }

  if (authRequired && !isAuthenticated) {
    return <Login />;
  }

  return children;
};

const PermissionRoute = ({ children, permission }) => {
  const { hasPermission } = useAuth();
  if (permission && !hasPermission(permission)) {
    return <Navigate to="/" replace />;
  }
  return children;
};

PermissionRoute.propTypes = {
  children: PropTypes.node.isRequired,
  permission: PropTypes.string,
};

ProtectedRoute.propTypes = {
  children: PropTypes.node.isRequired,
};

function AppContent() {
  const basePath = normalizeBasePath(
    import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL,
  );
  const [isHealthy, setIsHealthy] = useState(null);
  const [rootFolderConfigured, setRootFolderConfigured] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const discoveryToastShownRef = useRef(false);
  const { isAuthenticated, user } = useAuth();
  const { showSuccess, showError } = useToast();

  useWebSocketChannel("discovery", (msg) => {
    if (msg.type !== "discovery_update") return;

    const hasPendingManualRefresh =
      localStorage.getItem(DISCOVERY_MANUAL_REFRESH_KEY) === "1";
    if (!hasPendingManualRefresh) return;

    if (msg.phase === "error") {
      localStorage.removeItem(DISCOVERY_MANUAL_REFRESH_KEY);
      discoveryToastShownRef.current = false;
      showError(
        msg.error
          ? `Discovery refresh failed: ${msg.error}`
          : "Discovery refresh failed",
      );
      return;
    }

    if (msg.phase === "completed" || Array.isArray(msg.recommendations)) {
      if (discoveryToastShownRef.current) return;
      discoveryToastShownRef.current = true;
      localStorage.removeItem(DISCOVERY_MANUAL_REFRESH_KEY);
      showSuccess(
        "Discovery refresh completed. Recommendations are now updated.",
      );
      setTimeout(() => {
        discoveryToastShownRef.current = false;
      }, 1000);
    }
  });

  useEffect(() => {
    const checkApiHealth = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      try {
        const bootstrap = await getBootstrapStatus();
        setIsHealthy(bootstrap.status === "ok");
        setRootFolderConfigured(bootstrap.rootFolderConfigured || false);
        setAppVersion(bootstrap.appVersion || null);
      } catch {
        setIsHealthy(false);
        setAppVersion(null);
      }
    };

    checkApiHealth();
    const interval = setInterval(checkApiHealth, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkApiHealth();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated]);

  return (
    <Router
      basename={basePath}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <ProtectedRoute>
        <Layout
          isHealthy={isHealthy}
          rootFolderConfigured={rootFolderConfigured}
          appVersion={appVersion}
        >
          <UpdateBanner
            currentVersion={appVersion}
            visible={!user || user.role === "admin"}
          />
          {isHealthy === false && (
            <div className="app-status-banner app-status-banner--error">
              <svg
                className="app-status-banner__icon app-status-banner__icon--error"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="app-status-banner__text app-status-banner__text--error">
                Unable to connect to the backend API. Please check your
                configuration.
              </p>
            </div>
          )}

          {isHealthy && !rootFolderConfigured && (
            <div className="app-status-banner app-status-banner--warning">
              <svg
                className="app-status-banner__icon app-status-banner__icon--warning"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="app-status-banner__text app-status-banner__text--warning">
                Root folder is not configured. Please configure your music
                library root folder in settings.
              </p>
            </div>
          )}

          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<DiscoverPage />} />
              <Route path="/shows" element={<ShowsPage />} />
              <Route path="/search" element={<SearchResultsPage />} />
              <Route path="/discover" element={<Navigate to="/" replace />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route
                path="/playlists"
                element={
                  <PermissionRoute permission="accessFlow">
                    <FlowPage />
                  </PermissionRoute>
                }
              />
              <Route path="/flow" element={<Navigate to="/playlists" replace />} />
              <Route path="/downloads" element={<Navigate to="/history" replace />} />
              <Route path="/requests" element={<Navigate to="/history" replace />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route
                path="/artist/:mbid/albums"
                element={<ArtistAlbumsPage />}
              />
              <Route
                path="/artist/:mbid/release/:releaseMbid"
                element={<ReleasePage />}
              />
              <Route
                path="/artist/:mbid/appears-on"
                element={<ArtistAppearsOnPage />}
              />
              <Route path="/artist/:mbid" element={<ArtistDetailsPage />} />
              <Route
                path="/settings"
                element={
                  <PermissionRoute permission="accessSettings">
                    <SettingsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="/settings/metadata"
                element={
                  <PermissionRoute permission="accessSettings">
                    <MetadataProvidersPage />
                  </PermissionRoute>
                }
              />
              <Route path="/profile" element={<ProfilePage />} />
            </Routes>
          </Suspense>
        </Layout>
      </ProtectedRoute>
    </Router>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AudioPlayerProvider>
            <AudioQueueProvider>
              <AppContent />
              <ReloadPrompt />
            </AudioQueueProvider>
          </AudioPlayerProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
