import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { getRequests, triggerAlbumSearch } from "../utils/api/endpoints/library.js";
import { approveBlockedJob, denyBlockedJob, getStagingStreamUrl } from "../utils/api/endpoints/playlists";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { useFlowWorkerActivity } from "./flows/useFlowWorkerActivity";
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
} from "./activity/activityListUtils";
import ActivityRequestRow from "./activity/ActivityRequestRow";

import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Loader, AlertCircle, Music } from "lucide-react";
const ACTIVITY_PAGE_SIZE = 25;

const QUEUE_EMPTY_STATE = {
  title: "Queue is empty",
  message: "Active album requests and downloads will appear here.",
};

const REVIEW_EMPTY_STATE = {
  title: "No tracks to review",
  message: "Downloaded tracks that need your approval will appear here.",
};

const HISTORY_EMPTY_STATE = {
  title: "No activity yet",
  message: "A chronological log of album requests, track downloads, and other activity will appear here.",
};

function ActivityPage() {
  const navigate = useNavigate();
  const { view: viewParam } = useParams();
  const { user } = useAuth();
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessFlow;
  const { hasReview: hasReviewAlert } = useFlowWorkerActivity({ enabled: hasFlowAccess });
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const [reSearchingAlbumIds, setReSearchingAlbumIds] = useState({});
  const [approvingJobId, setApprovingJobId] = useState(null);
  const [denyingJobId, setDenyingJobId] = useState(null);
  const [jobErrors, setJobErrors] = useState({});
  const fetchRequestsInFlightRef = useRef(false);

  const { playTrack, currentTrack, isPlaying, togglePlayPause } = useAudioQueue();

  const activeView = normalizeActivityView(viewParam);
  const isQueueView = activeView === "queue";
  const isReviewView = activeView === "review";
  const isHistoryView = activeView === "history";
  const isListLikeView = isQueueView || isReviewView;
  const shouldRedirectView = viewParam && normalizeActivityView(viewParam) !== viewParam;

  useDocumentTitle(
    isQueueView ? "Queue - Activity"
    : isReviewView ? "Review - Activity"
    : isHistoryView ? "History - Activity"
    : "Activity",
  );

  const filteredRequests = useMemo(
    () => requests.filter((request) => matchesActivityView(request, activeView)),
    [requests, activeView],
  );

  const sortedRequests = useMemo(
    () => [...filteredRequests].sort(compareActivityRequests),
    [filteredRequests],
  );

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
    if (fetchRequestsInFlightRef.current) return;
    fetchRequestsInFlightRef.current = true;
    if (!silent) {
      setLoading(true);
    }

    try {
      const data = await getRequests({ refresh: refresh || isListLikeView });
      setRequests((previous) => mergeActivityRequests(previous, data));
      setError(null);
    } catch {
      if (!silent) {
        setError("Failed to load activity.");
      }
    } finally {
      fetchRequestsInFlightRef.current = false;
      if (!silent) {
        setLoading(false);
      }
    }
  }, [isListLikeView]);

  const refreshFromStatusEvent = useCallback(() => {
    if (document.hidden) return;
    fetchRequests({ silent: true, refresh: true });
  }, [fetchRequests]);

  const { isConnected: downloadsWsConnected } = useWebSocketChannel(
    "downloads",
    (message) => {
      if (message?.type === "download_statuses") refreshFromStatusEvent();
    },
  );
  const { isConnected: playlistsWsConnected } = useWebSocketChannel(
    "weekly-flow",
    (message) => {
      if (message?.type === "playlist_status") refreshFromStatusEvent();
    },
    { enabled: hasFlowAccess },
  );
  const activityWsConnected = downloadsWsConnected && (!hasFlowAccess || playlistsWsConnected);

  useEffect(() => {
    fetchRequests();

    const handleFocus = () => {
      fetchRequests({ silent: true });
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchRequests({ silent: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRequests]);

  useEffect(() => {
    const intervalMs = getActivityPollIntervalMs({
      isConnected: activityWsConnected,
      isListLikeView,
    });
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchRequests({ silent: true });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [activityWsConnected, isListLikeView, fetchRequests]);

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
      await triggerAlbumSearch(albumId);
      setRequests((prev) =>
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
      setError("Failed to trigger album search.");
    } finally {
      setReSearchingAlbumIds(({ [albumId]: _, ...prev }) => prev);
    }
  };

  const handleApproveBlockedJob = async (jobId) => {
    if (!jobId || approvingJobId === jobId) return;
    setApprovingJobId(jobId);
    try {
      await approveBlockedJob(jobId);
      setRequests((prev) =>
        prev.map((r) =>
          r.jobId === jobId
            ? {
                ...r,
                status: "completed",
                statusLabel: "Downloaded",
                inQueue: false,
                title: `Downloaded ${r.title?.replace(/^Review needed for /, "") || "track"}`,
              }
            : r,
        ),
      );
      setApprovingJobId(null);
      setJobErrors((prev) => {
        const { [jobId]: _, ...rest } = prev;
        return rest;
      });
    } catch {
      setJobErrors((prev) => ({ ...prev, [jobId]: "Failed to approve" }));
      setApprovingJobId(null);
    }
  };

  const handleDenyBlockedJob = async (jobId) => {
    if (!jobId || denyingJobId === jobId) return;
    setDenyingJobId(jobId);
    try {
      await denyBlockedJob(jobId);
      setRequests((prev) =>
        prev.map((r) =>
          r.jobId === jobId
            ? {
                ...r,
                status: "failed",
                statusLabel: "Denied",
                inQueue: false,
                title: `Denied ${r.title?.replace(/^Review needed for /, "") || "track"}`,
              }
            : r,
        ),
      );
      setDenyingJobId(null);
      setJobErrors((prev) => {
        const { [jobId]: _, ...rest } = prev;
        return rest;
      });
    } catch {
      setJobErrors((prev) => ({ ...prev, [jobId]: "Failed to deny" }));
      setDenyingJobId(null);
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

  const emptyState = isQueueView
    ? QUEUE_EMPTY_STATE
    : isReviewView
      ? REVIEW_EMPTY_STATE
      : HISTORY_EMPTY_STATE;

  const activitySections = useMemo(
    () =>
      ACTIVITY_VIEWS.map((entry) => ({
        id: entry.id,
        label:
          entry.id === "review" && hasReviewAlert ? `${entry.label} (needs review)` : entry.label,
      })),
    [hasReviewAlert],
  );

  const pageHeader = (
    <>
      <header className="requests-page__header">
        <h1 className="page-title">Activity</h1>
      </header>
      <PageSectionMobileNav
        sections={activitySections}
        activeId={activeView}
        label="Activity"
        getSectionPath={buildActivityPath}
        selectId="activity-view-select"
      />
    </>
  );

  if (!viewParam) {
    return <Navigate to={buildActivityPath(DEFAULT_ACTIVITY_VIEW)} replace />;
  }

  if (shouldRedirectView) {
    return <Navigate to={buildActivityPath(activeView)} replace />;
  }

  if (loading) {
    return (
      <div className="requests-page">
        {pageHeader}
        <div className="artist-loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="requests-page">
      {pageHeader}

      {error && (
        <div className="artist-error-panel requests-page__error" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load activity</h2>
          <p className="artist-error-copy">{error}</p>
          <button
            type="button"
            onClick={() => fetchRequests()}
            className="btn btn-secondary btn--bold btn-min-h requests-page__retry-button"
          >
            Try Again
          </button>
        </div>
      )}

      {filteredRequests.length === 0 ? (
        !error && (
          <div className="search-empty-panel">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Music className="artist-icon-lg" />
            </div>
            <h2 className="search-empty-panel__title">{emptyState.title}</h2>
            <p className="search-empty-panel__message">{emptyState.message}</p>
            {isQueueView && (
              <button
                type="button"
                onClick={() => navigate("/")}
                className="btn btn-primary btn--bold btn-min-h requests-page__empty-action"
              >
                Start Discovering
              </button>
            )}
          </div>
        )
      ) : (
        <div className="requests-page__list">
          {(() => {
            let rowIndex = 0;
            return listEntries.map((entry) => {
              if (entry.type === "date") {
                return (
                  <div key={entry.key} className="requests-page__date-group">
                    {entry.label}
                  </div>
                );
              }
              const row = (
                <ActivityRequestRow
                  key={entry.key}
                  request={entry.request}
                  rowIndex={rowIndex}
                  reSearchingAlbumIds={reSearchingAlbumIds}
                  approvingJobId={approvingJobId}
                  denyingJobId={denyingJobId}
                  jobErrors={jobErrors}
                  currentTrack={currentTrack}
                  isPlaying={isPlaying}
                  onNavigate={handleRowNavigate}
                  onReSearch={handleReSearchAlbum}
                  onApprove={handleApproveBlockedJob}
                  onDeny={handleDenyBlockedJob}
                  onPreview={handleReviewPreview}
                />
              );
              rowIndex += 1;
              return row;
            });
          })()}
          {hasMoreItems && (
            <div className="requests-page__load-more">
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
    </div>
  );
}

export default ActivityPage;
