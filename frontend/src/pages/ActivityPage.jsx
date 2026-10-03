import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRequests, triggerAlbumSearch } from "../utils/api/endpoints/library.js";
import { approveBlockedJob, denyBlockedJob, getStagingStreamUrl } from "../utils/api/endpoints/playlists";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { getActivityPollIntervalMs } from "../utils/requestScheduling.js";
import { PageSectionMobileNav } from "../components/PageSectionMobileNav";
import {
  ACTIVITY_VIEWS,
  DEFAULT_ACTIVITY_VIEW,
  buildActivityPath,
  matchesActivityView,
  normalizeActivityView,
} from "../navigation/activityNavConfig";
import {
  buildHistoryListEntries,
  compareActivityRequests,
  mergeActivityRequests,
  groupAlbumGrabRequests,
  matchesActivitySearch,
} from "./activity/activityListUtils";
import ActivityRequestRow from "./activity/ActivityRequestRow";
import ActivityAlbumRow from "./activity/ActivityAlbumRow";
import ActivityToolbar from "./activity/ActivityToolbar";
import ActivityMissingPage from "./activity/ActivityMissingPage";
import ActivityInfoModal from "./activity/ActivityInfoModal";

import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { AlertCircle, Music } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { queryClient, queryKeys } from "../queryClient.js";
const ACTIVITY_PAGE_SIZE = 25;

const QUEUE_EMPTY_STATE = {
  title: "Nothing queued",
  message: "Active requests, downloads, and tracks waiting for review will appear here.",
};

const HISTORY_EMPTY_STATE = {
  title: "No activity yet",
  message: "A chronological log of album requests, track downloads, and other activity will appear here.",
};

function ActivityPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { view: viewParam } = useParams();
  const { user } = useAuth();
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessFlow;
  const [localError, setLocalError] = useState(null);
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const [reSearchingAlbumIds, setReSearchingAlbumIds] = useState({});
  const [reviewingJobs, setReviewingJobs] = useState({});
  const [jobErrors, setJobErrors] = useState({});
  const [filterValue, setFilterValue] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [infoRequest, setInfoRequest] = useState(null);

  const { playTrack, currentTrack, isPlaying, togglePlayPause } = useAudioQueue();

  const activeView = normalizeActivityView(viewParam);
  const isQueueView = activeView === "queue";
  const isHistoryView = activeView === "history";
  const isMissingView = activeView === "missing";
  const isCutoffView = new URLSearchParams(location.search).get("tab") === "cutoff";
  const isListLikeView = isQueueView;
  const shouldRedirectView = viewParam && normalizeActivityView(viewParam) !== viewParam;
  const activeViewLabel = isMissingView
    ? isCutoffView ? "Cutoff unmet" : "Missing"
    : ACTIVITY_VIEWS.find((entry) => entry.id === activeView)?.label || "Activity";
  useDocumentTitle(
    isQueueView ? "Queued - Activity"
    : isHistoryView ? "History - Activity"
    : isMissingView ? `${isCutoffView ? "Cutoff unmet" : "Missing"} - Wanted`
    : "Activity",
  );

  const activityQueryKey = useMemo(
    () => queryKeys.activityRequests(user?.id),
    [user?.id],
  );
  const refreshFromStatusEvent = useCallback(() => {
    if (document.hidden) return;
    queryClient.refetchQueries({
      queryKey: isMissingView ? queryKeys.playlistJobs() : activityQueryKey,
      type: "active",
    });
  }, [activityQueryKey, isMissingView]);
  const { isConnected: downloadsWsConnected } = useWebSocketChannel(
    "downloads",
    (message) => {
      if (message?.type === "download_statuses") refreshFromStatusEvent();
    },
  );
  const { isConnected: playlistsWsConnected } = useWebSocketChannel(
    "playlists",
    (message) => {
      if (message?.type === "playlist_status") refreshFromStatusEvent();
    },
    { enabled: hasFlowAccess },
  );
  const activityWsConnected = downloadsWsConnected && (!hasFlowAccess || playlistsWsConnected);
  useEffect(() => {
    if (activityWsConnected) refreshFromStatusEvent();
  }, [activityWsConnected, refreshFromStatusEvent]);
  const activityQuery = useQuery({
    queryKey: activityQueryKey,
    queryFn: ({ signal }) => getRequests({ refresh: isListLikeView, signal }),
    enabled: !isMissingView,
    staleTime: isListLikeView ? 0 : 30_000,
    refetchInterval: isMissingView
      ? false
      : getActivityPollIntervalMs({ isConnected: activityWsConnected, isListLikeView }),
    refetchIntervalInBackground: false,
  });
  const requests = useMemo(
    () => groupAlbumGrabRequests(mergeActivityRequests([], activityQuery.data)),
    [activityQuery.data],
  );
  const loading = activityQuery.isPending;
  const error = localError || activityQuery.error?.response?.data?.message || activityQuery.error?.message;

  const filteredRequests = useMemo(
    () => {
      const query = filterValue.trim().toLocaleLowerCase();
      return requests.filter((request) => {
        if (!matchesActivityView(request, activeView)) return false;
        return matchesActivitySearch(request, query);
      });
    },
    [activeView, filterValue, requests],
  );

  const sortedRequests = useMemo(
    () => [...filteredRequests].sort(compareActivityRequests),
    [filteredRequests],
  );
  const hasActivityFilter = filterValue.trim().length > 0;

  const visibleRequests = useMemo(
    () => sortedRequests.slice(0, visibleCount),
    [sortedRequests, visibleCount],
  );

  const hasMoreItems = visibleCount < sortedRequests.length;

  const listEntries = useMemo(() => {
    if (isListLikeView) {
      return visibleRequests.map((request) => ({
        type: "item",
        request,
        key: request.id || request.mbid,
      }));
    }
    return buildHistoryListEntries(visibleRequests);
  }, [isListLikeView, visibleRequests]);

  useEffect(() => {
    setVisibleCount(ACTIVITY_PAGE_SIZE);
  }, [activeView]);

  const fetchRequests = useCallback(async ({ silent = false, refresh = false } = {}) => {
    try {
      const result = await queryClient.fetchQuery({
        queryKey: activityQueryKey,
        queryFn: ({ signal }) => getRequests({ refresh: refresh || isListLikeView, signal }),
        staleTime: refresh ? 0 : isListLikeView ? 0 : 30_000,
      });
      setLocalError(null);
      return result;
    } catch (requestError) {
      if (!silent) {
        setLocalError(requestError?.response?.data?.message || "Failed to load activity.");
      }
      return null;
    }
  }, [activityQueryKey, isListLikeView]);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchRequests({ silent: true, refresh: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchRequests]);

  useEffect(() => {
    if (isMissingView) return undefined;

    const handleFocus = () => {
      queryClient.refetchQueries({ queryKey: activityQueryKey, type: "active" });
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        queryClient.refetchQueries({ queryKey: activityQueryKey, type: "active" });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activityQueryKey, isMissingView]);

  const updateRequests = useCallback((updater) => {
    queryClient.setQueryData(activityQueryKey, (current) => {
      const next = Array.isArray(current) ? current : [];
      return updater(next);
    });
  }, [activityQueryKey]);
  const settleReviewedJob = useCallback(async (jobId, changes) => {
    await queryClient.cancelQueries({ queryKey: activityQueryKey });
    updateRequests((prev) =>
      prev.map((r) =>
        r.jobId === jobId
          ? {
              ...r,
              ...changes,
              inQueue: false,
              title: `${changes.statusLabel} ${r.title?.replace(/^Review needed for /, "") || "track"}`,
            }
          : r,
      ),
    );
    void queryClient.invalidateQueries({ queryKey: activityQueryKey });
  }, [activityQueryKey, updateRequests]);
  const reSearchMutation = useMutation({
    mutationFn: ({ albumId }) => triggerAlbumSearch(albumId),
  });
  const approveMutation = useMutation({
    mutationFn: approveBlockedJob,
  });
  const denyMutation = useMutation({
    mutationFn: denyBlockedJob,
  });

  const navigateToArtist = useCallback(
    (request, isAlbum, artistMbid, artistName, displayName) => {
      if (!artistMbid || artistMbid === "null" || artistMbid === "undefined") {
        return;
      }
      navigate(isAlbum ? `/artist/${artistMbid}` : `/artist/${request.mbid}`, {
        state: {
          artistName: isAlbum ? artistName : displayName,
        },
      });
    },
    [navigate],
  );

  const handleReSearchAlbum = async (request) => {
    const albumId = request.albumId;
    if (!albumId || reSearchingAlbumIds[albumId]) return;
    setReSearchingAlbumIds((prev) => ({ ...prev, [albumId]: true }));
    try {
      await reSearchMutation.mutateAsync({ albumId });
      updateRequests((prev) =>
        prev.map((item) =>
          String(item.albumId) === String(albumId)
            ? {
                ...item,
                requestedAt: new Date().toISOString(),
                status: "processing",
                statusLabel: "Searching",
                title: item.albumName
                  ? `Searching Lidarr for ${item.albumName}`
                  : item.title?.replace(/^No results for /, "Searching Lidarr for ") || item.title,
                canReSearch: false,
              }
            : item,
        ),
      );
    } catch {
      setLocalError("Failed to trigger album search.");
    } finally {
      setReSearchingAlbumIds(({ [albumId]: _, ...prev }) => prev);
    }
  };

  const reviewBlockedJob = async (jobId, action) => {
    if (!jobId || reviewingJobs[jobId]) return;
    setReviewingJobs((prev) => ({ ...prev, [jobId]: action }));
    try {
      if (action === "approve") {
        await approveMutation.mutateAsync(jobId);
        await settleReviewedJob(jobId, { status: "completed", statusLabel: "Downloaded" });
      } else {
        await denyMutation.mutateAsync(jobId);
        await settleReviewedJob(jobId, { status: "failed", statusLabel: "Denied" });
      }
      setJobErrors(({ [jobId]: _, ...rest }) => rest);
    } catch {
      setJobErrors((prev) => ({
        ...prev,
        [jobId]: action === "approve" ? "Failed to approve" : "Failed to deny",
      }));
    } finally {
      setReviewingJobs(({ [jobId]: _, ...rest }) => rest);
    }
  };

  const handleReviewPreview = useCallback(
    (jobId, trackName, artistName) => {
      const trackId = String(jobId);
      if (currentTrack?.id === trackId) {
        togglePlayPause();
        return;
      }
      playTrack({
        id: trackId,
        src: getStagingStreamUrl(jobId),
        title: trackName || "Track",
        artist: artistName || "Artist",
      });
    },
    [currentTrack?.id, playTrack, togglePlayPause],
  );

  const handleRowNavigate = useCallback(
    (request, { isSlskd, isUsenet, isAurral, isAlbum, artistMbid, artistName, displayName }) => {
      if ((isSlskd || isUsenet) && request.playlistId) {
        navigate(`/playlists?selected=${encodeURIComponent(request.playlistId)}`);
        return;
      }
      if (request.href && (isAurral || request.type === "activity")) {
        navigate(request.href);
        return;
      }
      navigateToArtist(request, isAlbum, artistMbid, artistName, displayName);
    },
    [navigate, navigateToArtist],
  );

  const emptyState = isQueueView ? QUEUE_EMPTY_STATE : HISTORY_EMPTY_STATE;

  const activitySections = ACTIVITY_VIEWS;

  const pageHeader = (
    <>
      <header className="activity-page__header">
        <h1 className="page-title">{activeViewLabel}</h1>
      </header>
      {!isMissingView ? (
        <PageSectionMobileNav
          sections={activitySections.filter((entry) => entry.id !== "missing")}
          activeId={activeView}
          label="Activity"
          getSectionPath={buildActivityPath}
          selectId="activity-view-select"
        />
      ) : null}
    </>
  );

  if (!viewParam) {
    return <Navigate to={buildActivityPath(DEFAULT_ACTIVITY_VIEW)} replace />;
  }

  if (shouldRedirectView) {
    return <Navigate to={buildActivityPath(activeView)} replace />;
  }

  if (isMissingView) {
    return (
      <div className="activity-page">
        {pageHeader}
        <ActivityMissingPage />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="activity-page">
        {pageHeader}
        <ActivityToolbar
          filterValue={filterValue}
          onFilterChange={setFilterValue}
          onRefresh={handleManualRefresh}
          refreshing={refreshing}
        />
        <div className="activity-page__loading" role="status" aria-label="Loading activity">
          <DotLoader size="2xl" label={null} />
        </div>
      </div>
    );
  }

  return (
    <div className="activity-page">
      {pageHeader}
      <ActivityToolbar
        filterValue={filterValue}
        onFilterChange={setFilterValue}
        onRefresh={handleManualRefresh}
        refreshing={refreshing}
      />

      {error && (
        <div className="artist-error-panel activity-page__error" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load activity</h2>
          <p className="artist-error-copy">{error}</p>
          <button
            type="button"
            onClick={() => fetchRequests()}
            className="btn btn-secondary btn--bold btn-min-h"
          >
            Try Again
          </button>
        </div>
      )}

      {filteredRequests.length === 0 ? (
        !error && (
          <div className="search-empty-panel activity-page__empty">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Music className="artist-icon-lg" />
            </div>
            <h2 className="search-empty-panel__title">
              {hasActivityFilter ? "No matches" : emptyState.title}
            </h2>
            <p className="search-empty-panel__message">
              {hasActivityFilter
                ? "No activity matches the current filter."
                : emptyState.message}
            </p>
            {isQueueView && !hasActivityFilter && (
              <button
                type="button"
                onClick={() => navigate("/")}
                className="btn btn-primary btn--bold btn-min-h"
              >
                Start Discovering
              </button>
            )}
          </div>
        )
      ) : (
        <div className="activity-list">
          {(() => {
            return listEntries.map((entry) => {
              if (entry.type === "date") {
                return (
                  <div key={entry.key} className="activity-list__date-group">
                    {entry.label}
                  </div>
                );
              }
              const RowComponent = entry.request.kind === "album_download" ? ActivityAlbumRow : ActivityRequestRow;
              const row = (
                <RowComponent
                  key={entry.key}
                  request={entry.request}
                  reSearchingAlbumIds={reSearchingAlbumIds}
                  reviewingJobs={reviewingJobs}
                  jobErrors={jobErrors}
                  currentTrack={currentTrack}
                  isPlaying={isPlaying}
                  onNavigate={handleRowNavigate}
                  onReSearch={handleReSearchAlbum}
                  onApprove={(jobId) => reviewBlockedJob(jobId, "approve")}
                  onDeny={(jobId) => reviewBlockedJob(jobId, "deny")}
                  onPreview={handleReviewPreview}
                  onInfo={setInfoRequest}
                  filterValue={filterValue}
                />
              );
              return row;
            });
          })()}
          {hasMoreItems && (
            <div className="activity-list__load-more">
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + ACTIVITY_PAGE_SIZE)}
                className="btn btn-secondary btn--bold btn-min-h"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}
      <ActivityInfoModal item={infoRequest} onClose={() => setInfoRequest(null)} />
    </div>
  );
}

export default ActivityPage;
