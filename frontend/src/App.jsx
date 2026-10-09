import { PlaylistBulkActionsProvider } from "./pages/playlists/usePlaylistBulkActions.js";
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from "react-router";
import { useState, useEffect, Suspense, lazy, useRef } from "react";
import Layout from "./components/Layout";
import { checkHealthLive, getBootstrapStatus } from "./utils/api/endpoints/auth.js";
import { getAppBasePath } from "./utils/basePath.js";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "./utils/discoverRecentNavigation.js";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { DiscoverRecentProvider } from "./contexts/DiscoverRecentProvider";
import { AudioQueueProvider } from "./contexts/AudioQueueProvider";
import { AlertTriangle, XCircle } from "lucide-react";
import ReloadPrompt from "./components/ReloadPrompt";
import ThemeSync from "./components/ThemeSync";
import UpdateIndicator from "./components/UpdateIndicator";
import SpotifyReconnectNotice from "./components/SpotifyReconnectNotice";
import { DotLoader } from "./components/DotLoader";
import { SkeletonCardGrid, SkeletonPageHeader, SkeletonStatus } from "./components/Skeletons";
import { useDiscoveryStatus } from "./hooks/useDiscoveryStatus";
import { buildActivityPath, DEFAULT_ACTIVITY_VIEW } from "./navigation/activityNavConfig";
import { routeModules } from "./navigation/routeModules.js";
import { getBootstrapPollIntervalMs } from "./utils/requestScheduling.js";

function LegacyHistoryRedirect() {
  return <Navigate to="/activity/history" replace />;
}

function ActivitySourceRedirect() {
  const { view } = useParams();
  return <Navigate to={buildActivityPath(view)} replace />;
}

function ActivityRootRedirect() {
  return <Navigate to={buildActivityPath(DEFAULT_ACTIVITY_VIEW)} replace />;
}

const Login = lazy(() => import("./pages/Login"));
const SsoComplete = lazy(() => import("./pages/SsoComplete"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const SearchResultsPage = lazy(routeModules.search);
const DiscoverPage = lazy(routeModules.discover);
const ShowsPage = lazy(routeModules.shows);
const LibraryPage = lazy(routeModules.library);
const SettingsPage = lazy(routeModules.settings);
const ProfilePage = lazy(routeModules.profile);
const BlocklistPage = lazy(routeModules.blocklist);
const ArtistDetailsPage = lazy(routeModules.artist);
const ArtistReleaseListPage = lazy(routeModules.artistReleases);
const ReleasePage = lazy(routeModules.release);
const ActivityPage = lazy(routeModules.activity);
const PlaylistsPage = lazy(routeModules.playlists);
const PlaylistDetailPage = lazy(routeModules.playlist);
const FlowsPage = lazy(routeModules.flows);
const FlowDetailPage = lazy(routeModules.flow);
const PlaylistRedirect = lazy(routeModules.playlistRedirect);
const DiscoverPlaylistsPage = lazy(routeModules.discoverPlaylists);
const EditorialPlaylistDetailPage = lazy(routeModules.editorialPlaylist);
const NewsPage = lazy(routeModules.news);

const PageLoader = () => (
  <SkeletonStatus label="Loading page">
    <SkeletonPageHeader />
    <SkeletonCardGrid square />
  </SkeletonStatus>
);

const ScreenLoader = () => (
  <div className="app-loading app-loading--screen">
    <DotLoader size="2xl" />
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading, authRequired, onboardingRequired } = useAuth();

  if (isLoading) {
    return <ScreenLoader />;
  }

  if (onboardingRequired) {
    return (
      <Suspense fallback={<ScreenLoader />}>
        <Onboarding />
      </Suspense>
    );
  }

  if (authRequired && !isAuthenticated) {
    return (
      <Suspense fallback={<ScreenLoader />}>
        <Login />
      </Suspense>
    );
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

function AppContent() {
  const basePath = getAppBasePath();
  const [isHealthy, setIsHealthy] = useState(null);
  const [healthIssue, setHealthIssue] = useState(null);
  const [rootFolderConfigured, setRootFolderConfigured] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const healthCheckInFlightRef = useRef(false);
  const { isAuthenticated, user, bootstrap, refreshAuth } = useAuth();
  const { showSuccess, showError } = useToast();

  const { status: discoveryStatus, isConnected: appSocketConnected } = useDiscoveryStatus({
    enabled: isAuthenticated,
  });

  useEffect(() => {
    if (!discoveryStatus || discoveryStatus.isUpdating) return;
    if (localStorage.getItem(DISCOVERY_MANUAL_REFRESH_KEY) !== "1") return;
    localStorage.removeItem(DISCOVERY_MANUAL_REFRESH_KEY);
    if (discoveryStatus.error) {
      showError(`Discovery refresh failed: ${discoveryStatus.error}`);
    } else {
      showSuccess("Discovery refresh completed. Recommendations are now updated.");
    }
  }, [discoveryStatus, showError, showSuccess]);

  const applyBootstrapHealth = (payload) => {
    setIsHealthy(payload.status === "ok");
    setRootFolderConfigured(payload.rootFolderConfigured || false);
    setAppVersion(payload.appVersion || null);
    setHealthIssue(payload.lidarr?.circuitOpen ? "lidarr" : null);
  };

  useEffect(() => {
    if (!bootstrap) return;
    applyBootstrapHealth(bootstrap);
  }, [bootstrap]);

  useEffect(() => {
    const checkApiHealth = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      if (healthCheckInFlightRef.current) return;
      healthCheckInFlightRef.current = true;
      try {
        applyBootstrapHealth(await getBootstrapStatus());
      } catch {
        try {
          await checkHealthLive();
          setIsHealthy(true);
          setHealthIssue("degraded");
          setAppVersion(null);
        } catch {
          setIsHealthy(false);
          setHealthIssue("backend");
          setAppVersion(null);
        }
        refreshAuth();
      } finally {
        healthCheckInFlightRef.current = false;
      }
    };

    checkApiHealth();
    const interval = setInterval(
      checkApiHealth,
      getBootstrapPollIntervalMs({ isConnected: appSocketConnected }),
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkApiHealth();
      }
    };
    const handleFocus = () => {
      checkApiHealth();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [appSocketConnected, isAuthenticated, refreshAuth]);

  return (
    <Router basename={basePath}>
      <Routes>
        <Route
          path="/sso/complete"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <SsoComplete />
            </Suspense>
          }
        />
        <Route
          path="/*"
          element={
            <DiscoverRecentProvider>
              <ProtectedRoute>
                <PlaylistBulkActionsProvider>
                <Layout
                  headerActions={
                    <UpdateIndicator
                      currentVersion={appVersion}
                      visible={!user || user.role === "admin"}
                    />
                  }
                >
                  <SpotifyReconnectNotice />
                  {healthIssue === "lidarr" && isHealthy && (
                    <div className="app-status-banner app-status-banner--warning">
                      <AlertTriangle className="app-status-banner__icon app-status-banner__icon--warning" />
                      <p className="app-status-banner__text app-status-banner__text--warning">
                        Lidarr is busy. Library data may be stale until it catches up.
                      </p>
                    </div>
                  )}

                  {healthIssue === "degraded" && (
                    <div className="app-status-banner app-status-banner--warning">
                      <AlertTriangle className="app-status-banner__icon app-status-banner__icon--warning" />
                      <p className="app-status-banner__text app-status-banner__text--warning">
                        Aurral is responding slowly.{" "}
                        {bootstrap?.lidarrConfigured ? "Lidarr may be busy. Try again in a minute." : "Try again in a minute."}
                      </p>
                    </div>
                  )}

                  {healthIssue === "backend" && isHealthy === false && (
                    <div className="app-status-banner app-status-banner--error">
                      <XCircle className="app-status-banner__icon app-status-banner__icon--error" />
                      <p className="app-status-banner__text app-status-banner__text--error">
                        Unable to connect to the Aurral backend. Please check your configuration.
                      </p>
                    </div>
                  )}

                  {isHealthy && !rootFolderConfigured && (
                    <div className="app-status-banner app-status-banner--warning">
                      <AlertTriangle className="app-status-banner__icon app-status-banner__icon--warning" />
                      <p className="app-status-banner__text app-status-banner__text--warning">
                        The Downloads Folder is not set. Choose one in Settings → Download clients.
                      </p>
                    </div>
                  )}
                  <Suspense fallback={<PageLoader />}>
                    <Routes>
                      <Route path="/" element={<DiscoverPage />} />
                      <Route path="/shows" element={<Navigate to="/shows/all" replace />} />
                      <Route path="/shows/:filter" element={<ShowsPage />} />
                      <Route path="/search" element={<SearchResultsPage />} />
                      <Route path="/discover" element={<Navigate to="/" replace />} />
                      <Route path="/discover/playlists/deezer/:playlistId" element={<EditorialPlaylistDetailPage />} />
                      <Route path="/discover/playlists" element={<DiscoverPlaylistsPage />} />
                      <Route path="/discover/news" element={<NewsPage />} />
                      <Route
                        path="/library/playlists"
                        element={
                          <PermissionRoute permission="accessFlow">
                            <PlaylistsPage />
                          </PermissionRoute>
                        }
                      />
                      <Route
                        path="/library/playlists/:playlistId"
                        element={
                          <PermissionRoute permission="accessFlow">
                            <PlaylistDetailPage />
                          </PermissionRoute>
                        }
                      />
                      <Route path="/library/album/:albumId" element={<LibraryPage />} />
                      <Route path="/library/artist/:artistId" element={<LibraryPage />} />
                      <Route path="/library/:section?" element={<LibraryPage />} />
                      <Route
                        path="/flows"
                        element={
                          <PermissionRoute permission="accessFlow">
                            <FlowsPage />
                          </PermissionRoute>
                        }
                      />
                      <Route
                        path="/flows/:flowId"
                        element={
                          <PermissionRoute permission="accessFlow">
                            <FlowDetailPage />
                          </PermissionRoute>
                        }
                      />
                      <Route
                        path="/playlists"
                        element={
                          <PermissionRoute permission="accessFlow">
                            <PlaylistRedirect />
                          </PermissionRoute>
                        }
                      />
                      <Route path="/flow" element={<Navigate to="/flows" replace />} />
                      <Route path="/downloads" element={<Navigate to="/activity/queue" replace />} />
                      <Route path="/requests" element={<Navigate to="/activity/queue" replace />} />
                      <Route path="/history" element={<Navigate to="/activity/history" replace />} />
                      <Route path="/history/:legacyTab" element={<LegacyHistoryRedirect />} />
                      <Route path="/activity" element={<ActivityRootRedirect />} />
                      <Route path="/activity/:view" element={<ActivityPage />} />
                      <Route path="/activity/:view/:source" element={<ActivitySourceRedirect />} />
                      <Route
                        path="/artist/:mbid/albums"
                        element={<ArtistReleaseListPage mode="releases" />}
                      />
                      <Route path="/artist/:mbid/release/:releaseMbid" element={<ReleasePage />} />
                      <Route
                        path="/artist/:mbid/appears-on"
                        element={<ArtistReleaseListPage mode="appearsOn" />}
                      />
                      <Route path="/artist/:mbid" element={<ArtistDetailsPage />} />
                      <Route
                        path="/settings/:tab?"
                        element={
                          <PermissionRoute permission="accessSettings">
                            <SettingsPage />
                          </PermissionRoute>
                        }
                      />
                      <Route path="/profile" element={<ProfilePage />} />
                      <Route path="/blocklist" element={<BlocklistPage />} />
                    </Routes>
                  </Suspense>
                </Layout>
                </PlaylistBulkActionsProvider>
              </ProtectedRoute>
            </DiscoverRecentProvider>
          }
        />
      </Routes>
    </Router>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <AudioQueueProvider>
            <AppContent />
            <ThemeSync />
            <ReloadPrompt />
          </AudioQueueProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
