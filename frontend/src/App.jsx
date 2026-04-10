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
import { checkHealth } from "./utils/api";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import ReloadPrompt from "./components/ReloadPrompt";
import UpdateBanner from "./components/UpdateBanner";
import { useWebSocketChannel } from "./hooks/useWebSocket";

const SearchResultsPage = lazy(() => import("./pages/SearchResultsPage"));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage"));
const ShowsPage = lazy(() => import("./pages/ShowsPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ArtistDetailsPage = lazy(() => import("./pages/ArtistDetailsPage"));
const RequestsPage = lazy(() => import("./pages/RequestsPage"));
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
  <div className="flex items-center justify-center min-h-[200px]">
    <div
      className="animate-spin h-8 w-8"
      style={{ borderBottom: "2px solid #707e61" }}
    ></div>
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading, authRequired, onboardingRequired } =
    useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div
          className="animate-spin h-12 w-12"
          style={{ borderBottom: "2px solid #707e61" }}
        ></div>
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
    import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL
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
      showSuccess("Discovery refresh completed. Recommendations are now updated.");
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
        const health = await checkHealth();
        setIsHealthy(health.status === "ok");
        setRootFolderConfigured(health.rootFolderConfigured || false);
        setAppVersion(health.appVersion || null);
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
    <Router basename={basePath}>
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
            <div className="mb-6 bg-red-500/20 border border-red-500/30 p-4">
              <div className="flex items-center">
                <svg
                  className="w-5 h-5 text-red-400 mr-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-red-400 font-medium">
                  Unable to connect to the backend API. Please check your
                  configuration.
                </p>
              </div>
            </div>
          )}

          {isHealthy && !rootFolderConfigured && (
            <div className="mb-6 bg-yellow-500/20 p-4">
              <div className="flex items-center">
                <svg
                  className="w-5 h-5 text-yellow-400 mr-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-yellow-400 font-medium">
                  Root folder is not configured. Please configure your music
                  library root folder in settings.
                </p>
              </div>
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
                path="/flow"
                element={
                  <PermissionRoute permission="accessFlow">
                    <FlowPage />
                  </PermissionRoute>
                }
              />
              <Route path="/requests" element={<RequestsPage />} />
              <Route path="/artist/:mbid" element={<ArtistDetailsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
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
          <AppContent />
          <ReloadPrompt />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
