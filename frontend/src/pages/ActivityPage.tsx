import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { requestsClient } from "../utils/api/clients/requests.ts";
import { playlistJobsClient } from "../utils/api/clients/playlistJobs.ts";
import { triggerAlbumSearch } from "../utils/api/endpoints/library.ts";
import { getStagingStreamUrl } from "../utils/api/playlistUrls.ts";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { getActivityPollIntervalMs } from "../utils/requestScheduling.ts";
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
  isAlbumActivityRequest,
  matchesActivitySearch,
  type ActivityListEntry,
} from "./activity/activityListUtils";
import ActivityRequestRow from "./activity/ActivityRequestRow";
import ActivityAlbumRow from "./activity/ActivityAlbumRow";
import ActivityToolbar from "./activity/ActivityToolbar";
import ActivityMissingPage from "./activity/ActivityMissingPage";
import ActivityInfoModal from "./activity/ActivityInfoModal";
import { getApiErrorText } from "./onboardingUtils.tsx";

import { Navigate, useLocation, useParams } from "react-router";
import RouteLink from "../components/RouteLink";
import { AlertCircle, Music } from "../components/icons";
import { SkeletonActivityList, SkeletonStatus } from "../components/Skeletons";
import { queryClient, queryKeys } from "../queryClient.ts";
import type { ActivityRequest } from "./activity/activityListUtils.ts";

const loadRequests = (refresh: boolean, signal: AbortSignal): Promise<ActivityRequest[]> =>
  parseResponse(
    requestsClient.$get({ query: { refresh: refresh ? "1" : undefined } }, { init: { signal } }),
  );

const ACTIVITY_PAGE_SIZE = 25;

const QUEUE_EMPTY_STATE = {
  title: "Nothing queued",
};

const HISTORY_EMPTY_STATE = {
  title: "No activity yet",
};

function ActivityPage() {
  const location = useLocation();
  const { view: viewParam } = useParams();
  const { user } = useAuth();
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessFlow;
  const lidarrConnected = useLibraryDestination().primary === "lidarr";
  const [localError, setLocalError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const [reSearchingAlbumIds, setReSearchingAlbumIds] = useState<Record<string, boolean>>({});
  const [reviewingJobs, setReviewingJobs] = useState<Record<string, "approve" | "deny">>({});
  const [controllingJobs, setControllingJobs] = useState<Record<string, "cancel" | "retry">>({});
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  const [filterValue, setFilterValue] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [infoRequest, setInfoRequest] = useState<ActivityRequest | null>(null);

  const { playTrack, currentTrack, isPlaying, togglePlayPause } = useAudioQueue();

  const activeView = normalizeActivityView(viewParam);
  const isQueueView = activeView === "queue";
  const isHistoryView = activeView === "history";
  const isMissingView = activeView === "missing";
  const isCutoffView = new URLSearchParams(location.search).get("tab") === "cutoff";
  const isListLikeView = isQueueView;
  const shouldRedirectView = viewParam && normalizeActivityView(viewParam) !== viewParam;
  const activeViewLabel = isMissingView
    ? isCutoffView
      ? "Cutoff unmet"
      : "Missing"
    : ACTIVITY_VIEWS.find((entry) => entry.id === activeView)?.label || "Activity";
  useDocumentTitle(
    isQueueView
      ? "Queued - Activity"
      : isHistoryView
        ? "History - Activity"
        : isMissingView
          ? `${isCutoffView ? "Cutoff unmet" : "Missing"} - Wanted`
          : "Activity",
  );

  const activityQueryKey = useMemo(() => queryKeys.activityRequests(user?.id), [user?.id]);
  const refreshFromStatusEvent = useCallback(() => {
    if (document.hidden) return;
    queryClient.refetchQueries({
      queryKey: isMissingView ? queryKeys.playlistJobs() : activityQueryKey,
      type: "active",
    });
  }, [activityQueryKey, isMissingView]);
  const { isConnected: downloadsWsConnected } = useWebSocketChannel("downloads", (message) => {
    if (message?.type === "download_statuses") refreshFromStatusEvent();
  });
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
    queryFn: ({ signal }) => loadRequests(isListLikeView, signal),
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
  const error =
    localError || getApiErrorText(activityQuery.error, "message") || activityQuery.error?.message;

  const filteredRequests = useMemo(() => {
    const query = filterValue.trim().toLocaleLowerCase();
    return requests.filter((request) => {
      if (!matchesActivityView(request, activeView)) return false;
      return matchesActivitySearch(request, query);
    });
  }, [activeView, filterValue, requests]);

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
      return visibleRequests.map((request): ActivityListEntry => ({
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

  const fetchRequests = useCallback(
    async ({ silent = false, refresh = false } = {}) => {
      try {
        const result = await queryClient.fetchQuery({
          queryKey: activityQueryKey,
          queryFn: ({ signal }) => loadRequests(refresh || isListLikeView, signal),
          staleTime: refresh ? 0 : isListLikeView ? 0 : 30_000,
        });
        setLocalError(null);
        return result;
      } catch (requestError) {
        if (!silent) {
          setLocalError(getApiErrorText(requestError, "message") || "Failed to load activity.");
        }
        return null;
      }
    },
    [activityQueryKey, isListLikeView],
  );

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

  const updateRequests = useCallback(
    (updater: (prev: ActivityRequest[]) => ActivityRequest[]) => {
      queryClient.setQueryData<ActivityRequest[]>(activityQueryKey, (current) => {
        const next = Array.isArray(current) ? current : [];
        return updater(next);
      });
    },
    [activityQueryKey],
  );
  const settleReviewedJob = useCallback(
    async (jobId: string, changes: Partial<ActivityRequest>) => {
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
    },
    [activityQueryKey, updateRequests],
  );
  const reSearchMutation = useMutation({
    mutationFn: ({ albumId }: { albumId: string }) => triggerAlbumSearch(albumId),
  });
  const approveMutation = useMutation({
    mutationFn: (jobId: string) =>
      parseResponse(
        playlistJobsClient.jobs[":jobId"].approve.$post({
          param: { jobId: encodeURIComponent(jobId) },
        }),
      ),
  });
  const denyMutation = useMutation({
    mutationFn: (jobId: string) =>
      parseResponse(
        playlistJobsClient.jobs[":jobId"].deny.$post({
          param: { jobId: encodeURIComponent(jobId) },
        }),
      ),
  });

  const handleReSearchAlbum = async (request: ActivityRequest) => {
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

  const reviewBlockedJob = async (jobId: string | null | undefined, action: "approve" | "deny") => {
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

  const controlDownloadJob = async (
    jobId: string | null | undefined,
    action: "cancel" | "retry",
  ) => {
    if (!jobId || controllingJobs[jobId]) return;
    setControllingJobs((prev) => ({ ...prev, [jobId]: action }));
    try {
      const param = { jobId: encodeURIComponent(jobId) };
      const result =
        action === "cancel"
          ? await parseResponse(playlistJobsClient.jobs[":jobId"].cancel.$post({ param }))
          : await parseResponse(playlistJobsClient.jobs[":jobId"].retry.$post({ param }));
      const cancelling = action === "cancel" && result?.status === "cancel_requested";
      updateRequests((prev) =>
        prev.map((item) =>
          item.jobId === jobId
            ? {
                ...item,
                status: action === "retry" || cancelling ? "processing" : "cancelled",
                statusLabel:
                  action === "retry" ? "Searching" : cancelling ? "Cancelling" : "Cancelled",
                title:
                  action === "retry"
                    ? `Searching for ${item.trackName || "track"}`
                    : cancelling
                      ? `Cancelling ${item.trackName || "track"}`
                      : `Cancelled ${item.trackName || "track"}`,
                inQueue: action === "retry" || cancelling,
                requestedAt: action === "retry" ? new Date().toISOString() : item.requestedAt,
              }
            : item,
        ),
      );
      setJobErrors(({ [jobId]: _, ...rest }) => rest);
      void queryClient.invalidateQueries({ queryKey: activityQueryKey });
    } catch (jobError) {
      setJobErrors((prev) => ({
        ...prev,
        [jobId]:
          getApiErrorText(jobError, "message") ||
          getApiErrorText(jobError, "error") ||
          (action === "cancel" ? "Failed to cancel" : "Failed to retry"),
      }));
    } finally {
      setControllingJobs(({ [jobId]: _, ...rest }) => rest);
    }
  };

  const handleReviewPreview = useCallback(
    ({ jobId, trackName, artistName, albumName, albumMbid }: ActivityRequest) => {
      const trackId = String(jobId);
      if (currentTrack?.id === trackId) {
        togglePlayPause();
        return;
      }
      playTrack({
        id: trackId,
        src: getStagingStreamUrl(trackId),
        title: trackName || "Track",
        artist: artistName || "Artist",
        album: albumName || "",
        albumMbid,
      });
    },
    [currentTrack?.id, playTrack, togglePlayPause],
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
        <SkeletonStatus label="Loading activity">
          <SkeletonActivityList count={8} dateGroup={isHistoryView} />
        </SkeletonStatus>
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
          <h2 className="artist-error-title">Could not load activity.</h2>
          {error !== "Failed to load activity." ? (
            <p className="artist-error-copy">{error}</p>
          ) : null}
          <button
            type="button"
            onClick={() => fetchRequests()}
            className="btn btn-secondary btn--bold btn-min-h"
          >
            Try again
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
            {hasActivityFilter ? (
              <p className="search-empty-panel__message">No activity matches the current filter.</p>
            ) : null}
            {isQueueView && !hasActivityFilter && (
              <RouteLink to="/" className="btn btn-primary btn--bold btn-min-h">
                Start discovering
              </RouteLink>
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
              const rowProps = {
                reSearchingAlbumIds,
                reviewingJobs,
                controllingJobs,
                jobErrors,
                currentTrack,
                isPlaying,
                onReSearch: lidarrConnected ? handleReSearchAlbum : undefined,
                onApprove: (jobId: string | null | undefined) => reviewBlockedJob(jobId, "approve"),
                onDeny: (jobId: string | null | undefined) => reviewBlockedJob(jobId, "deny"),
                onCancel: (jobId: string | null | undefined) => controlDownloadJob(jobId, "cancel"),
                onRetry: (jobId: string | null | undefined) => controlDownloadJob(jobId, "retry"),
                onPreview: handleReviewPreview,
                onInfo: setInfoRequest,
              };
              return isAlbumActivityRequest(entry.request) ? (
                <ActivityAlbumRow
                  key={entry.key}
                  request={entry.request}
                  filterValue={filterValue}
                  {...rowProps}
                />
              ) : (
                <ActivityRequestRow key={entry.key} request={entry.request} {...rowProps} />
              );
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
