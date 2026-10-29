import { PlaylistBulkActionsProvider } from "./pages/playlists/usePlaylistBulkActions.ts";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  useOutletContext,
} from "react-router";
import { RouterProvider } from "react-router/dom";
import { useState, useEffect, Suspense, lazy, useRef, type ReactNode } from "react";
import Layout from "./components/Layout";
import { parseResponse } from "hono/client";
import { healthClient } from "./utils/api/clients/health.ts";
import { getBootstrapStatus, type BootstrapPayload } from "./utils/appHealth.ts";
import { getAppBasePath } from "./utils/basePath.ts";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "./utils/discoverRecentNavigation.ts";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { DiscoverRecentProvider } from "./contexts/DiscoverRecentProvider";
import { AudioQueueProvider } from "./contexts/AudioQueueProvider";
import { ShareProvider } from "./contexts/ShareContext";
import { AlertTriangle, XCircle } from "./components/icons";
import ReloadPrompt from "./components/ReloadPrompt";
import ThemeSync from "./components/ThemeSync";
import UpdateIndicator from "./components/UpdateIndicator";
import SpotifyReconnectNotice from "./components/SpotifyReconnectNotice";
import { DotLoader } from "./components/DotLoader";
import { SkeletonPageTitle } from "./components/Skeletons";
import { useDiscoveryStatus } from "./hooks/useDiscoveryStatus";
import { buildActivityPath, DEFAULT_ACTIVITY_VIEW } from "./navigation/activityNavConfig";
import { routeModules } from "./navigation/routeModules.ts";
import { getBootstrapPollIntervalMs } from "./utils/requestScheduling.ts";

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
const RecommendedPage = lazy(routeModules.recommended);
const TrendingPage = lazy(routeModules.trending);
const TrendingGenrePage = lazy(routeModules.trendingGenre);
const EditorialPlaylistDetailPage = lazy(routeModules.editorialPlaylist);
const NewsPage = lazy(routeModules.news);
const ResolveLinkPage = lazy(routeModules.resolveLink);
const ShareImportPage = lazy(routeModules.shareImport);

const PageLoader = () => <SkeletonPageTitle label="Loading page" />;

const ScreenLoader = () => (
  <div className="app-loading app-loading--screen">
    <DotLoader size="2xl" />
  </div>
);

const ProtectedRoute = ({ children }: { children: ReactNode }) => {
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

const PermissionRoute = ({ children, permission }: { children: ReactNode; permission: string }) => {
  const { hasPermission } = useAuth();
  if (permission && !hasPermission(permission)) {
    return <Navigate to="/" replace />;
  }
  return children;
};

type HealthIssue = "lidarr" | "degraded" | "backend";

type AppOutletContext = {
  appVersion: string | null;
  healthIssue: HealthIssue | null;
  isHealthy: boolean | null;
  rootFolderConfigured: boolean;
};

function AppContent() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [healthIssue, setHealthIssue] = useState<HealthIssue | null>(null);
  const [rootFolderConfigured, setRootFolderConfigured] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const healthCheckInFlightRef = useRef(false);
  const { isAuthenticated, bootstrap, refreshAuth } = useAuth();
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
      showSuccess("Recommendations updated.");
    }
  }, [discoveryStatus, showError, showSuccess]);

  const applyBootstrapHealth = (payload: BootstrapPayload) => {
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
          await parseResponse(
            healthClient.live.$get({}, { init: { signal: AbortSignal.timeout(5000) } }),
          );
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

  return <Outlet context={{ appVersion, healthIssue, isHealthy, rootFolderConfigured }} />;
}

function ProtectedLayout() {
  const { appVersion, healthIssue, isHealthy, rootFolderConfigured } =
    useOutletContext<AppOutletContext>();
  const { user, bootstrap } = useAuth();

  return (
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
                  Lidarr is busy. Library updates may be delayed.
                </p>
              </div>
            )}

            {healthIssue === "degraded" && (
              <div className="app-status-banner app-status-banner--warning">
                <AlertTriangle className="app-status-banner__icon app-status-banner__icon--warning" />
                <p className="app-status-banner__text app-status-banner__text--warning">
                  Aurral is responding slowly.{" "}
                  {bootstrap?.lidarrConfigured
                    ? "Lidarr may be busy. Try again in a minute."
                    : "Try again in a minute."}
                </p>
              </div>
            )}

            {healthIssue === "backend" && isHealthy === false && (
              <div className="app-status-banner app-status-banner--error">
                <XCircle className="app-status-banner__icon app-status-banner__icon--error" />
                <p className="app-status-banner__text app-status-banner__text--error">
                  Cannot reach Aurral. Check the server connection.
                </p>
              </div>
            )}

            {isHealthy && !rootFolderConfigured && (
              <div className="app-status-banner app-status-banner--warning">
                <AlertTriangle className="app-status-banner__icon app-status-banner__icon--warning" />
                <p className="app-status-banner__text app-status-banner__text--warning">
                  Choose a Downloads Folder in Settings → Library.
                </p>
              </div>
            )}
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </Layout>
        </PlaylistBulkActionsProvider>
      </ProtectedRoute>
    </DiscoverRecentProvider>
  );
}

const appRoutes = createRoutesFromElements(
  <Route element={<AppContent />}>
    <Route
      path="/sso/complete"
      element={
        <Suspense fallback={<ScreenLoader />}>
          <SsoComplete />
        </Suspense>
      }
    />
    <Route element={<ProtectedLayout />}>
      <Route path="/" element={<DiscoverPage />} />
      <Route path="/shows" element={<Navigate to="/shows/all" replace />} />
      <Route path="/shows/:filter" element={<ShowsPage />} />
      <Route path="/search" element={<SearchResultsPage />} />
      <Route
        path="/discover/playlists/deezer/:playlistId"
        element={<EditorialPlaylistDetailPage />}
      />
      <Route path="/discover/playlists" element={<DiscoverPlaylistsPage />} />
      <Route path="/discover/news" element={<NewsPage />} />
      <Route path="/discover/recommended/:view?" element={<RecommendedPage />} />
      <Route path="/discover/trending" element={<TrendingPage />} />
      <Route path="/discover/trending/genres/:genreId" element={<TrendingGenrePage />} />
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
      <Route path="/activity" element={<ActivityRootRedirect />} />
      <Route path="/activity/:view" element={<ActivityPage />} />
      <Route path="/artist/:mbid/albums" element={<ArtistReleaseListPage mode="releases" />} />
      <Route path="/artist/:mbid/release/:releaseMbid" element={<ReleasePage />} />
      <Route path="/artist/:mbid/appears-on" element={<ArtistReleaseListPage mode="appearsOn" />} />
      <Route path="/artist/:mbid" element={<ArtistDetailsPage />} />
      <Route path="/blocklist" element={<BlocklistPage />} />
      <Route path="/go/:kind" element={<ResolveLinkPage />} />
      <Route path="/share/import" element={<ShareImportPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Route>,
);

let appRouter = null;

function AppRouter() {
  appRouter ??= createBrowserRouter(appRoutes, {
    basename: getAppBasePath(),
  });
  return <RouterProvider router={appRouter} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <AudioQueueProvider>
            <ShareProvider>
              <AppRouter />
              <ThemeSync />
              <ReloadPrompt />
            </ShareProvider>
          </AudioQueueProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
