import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { requestsClient } from "../utils/api/clients/requests.ts";
import { playlistJobsClient } from "../utils/api/clients/playlistJobs.ts";
import { getStagingStreamUrl } from "../utils/api/playlistUrls.ts";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { getActivityPollIntervalMs } from "../utils/requestScheduling.ts";
import { PageSectionMobileNav } from "../components/PageSectionMobileNav";
import {
  ACTIVITY_VIEWS,
  DEFAULT_ACTIVITY_VIEW,
  buildActivityPath,
  normalizeActivityView,
} from "../navigation/activityNavConfig";
import {
  buildHistoryListEntries,
  isAlbumActivityRequest,
  type ActivityListEntry,
} from "./activity/activityListUtils";
import ActivityRequestRow from "./activity/ActivityRequestRow";
import ActivityAlbumRow from "./activity/ActivityAlbumRow";
import ActivityStatusTabs from "./activity/ActivityStatusTabs";
import ActivityMissingPage from "./activity/ActivityMissingPage";
import ActivityInfoModal from "./activity/ActivityInfoModal";
import { getApiErrorText } from "../utils/api/errors.ts";

import { Navigate, useParams, useSearchParams } from "react-router";
import RouteLink from "../components/RouteLink";
import { AlertCircle, Music, X } from "../components/icons";
import { SkeletonActivityList, SkeletonStatus } from "../components/Skeletons";
import { queryClient, queryKeys } from "../queryClient.ts";
import {
  normalizeActivityStatus,
  type ActivityRequest,
  type ActivityStatus,
} from "../../../lib/activity.ts";
import StatePanel from "../components/StatePanel";
import { ConfirmModal } from "../components/ConfirmModal";
import Pagination from "../components/Pagination";
import { useClampPage, usePageParam } from "../hooks/usePageParam.ts";

type ActivityPageData = Omit<InferResponseType<typeof requestsClient.page.$get, 200>, "items"> & {
  items: ActivityRequest[];
};

const loadActivityPage = (
  {
    view,
    status,
    offset,
    refresh,
  }: { view: "queue" | "history"; status: ActivityStatus | null; offset: number; refresh: boolean },
  signal: AbortSignal,
): Promise<ActivityPageData> =>
  parseResponse(
    requestsClient.page.$get(
      {
        query: {
          view,
          status: status ?? undefined,
          offset: String(offset),
          limit: String(ACTIVITY_PAGE_SIZE),
          refresh: refresh ? "1" : undefined,
        },
      },
      { init: { signal } },
    ),
  );

const ACTIVITY_PAGE_SIZE = 25;

const QUEUE_EMPTY_STATE = {
  title: "Nothing queued",
};

const HISTORY_EMPTY_STATE = {
  title: "No activity yet",
};

function ActivityPage() {
  const { view: viewParam } = useParams();
  const { user } = useAuth();
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessPlaylists;
  const [localError, setLocalError] = useState<string | null>(null);
  const [reviewingJobs, setReviewingJobs] = useState<Record<string, "approve" | "deny">>({});
  const [controllingJobs, setControllingJobs] = useState<Record<string, "cancel" | "retry">>({});
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  const [infoRequest, setInfoRequest] = useState<ActivityRequest | null>(null);
  const [confirmingCancelAll, setConfirmingCancelAll] = useState(false);

  const { playTrack, currentTrack, isPlaying, togglePlayPause } = useAudioQueue();

  const activeView = normalizeActivityView(viewParam);
  const [searchParams, setSearchParams] = useSearchParams();
  const [pageIndex, setPageIndex] = usePageParam();
  const activeStatus = normalizeActivityStatus(activeView, searchParams.get("status"));
  const isQueueView = activeView === "queue";
  const isHistoryView = activeView === "history";
  const isMissingView = activeView === "missing";
  const isCutoffView = searchParams.get("tab") === "cutoff";
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
  const { isConnected: activityWsConnected } = useWebSocketChannel(
    "playlists",
    (message) => {
      if (message?.type === "playlist_status") refreshFromStatusEvent();
    },
    { enabled: hasFlowAccess },
  );
  useEffect(() => {
    if (activityWsConnected) refreshFromStatusEvent();
  }, [activityWsConnected, refreshFromStatusEvent]);
  const pageView = isHistoryView ? "history" : "queue";
  const pageQueryKey = useMemo(
    () => [...activityQueryKey, pageView, activeStatus, pageIndex],
    [activityQueryKey, pageView, activeStatus, pageIndex],
  );
  const activityQuery = useQuery({
    queryKey: pageQueryKey,
    queryFn: ({ signal }) =>
      loadActivityPage(
        {
          view: pageView,
          status: activeStatus,
          offset: (pageIndex - 1) * ACTIVITY_PAGE_SIZE,
          refresh: isListLikeView,
        },
        signal,
      ),
    enabled: !isMissingView,
    placeholderData: (previous) => (previous?.view === pageView ? previous : undefined),
    staleTime: isListLikeView ? 0 : 30_000,
    refetchInterval: isMissingView
      ? false
      : getActivityPollIntervalMs({ isConnected: activityWsConnected, isListLikeView }),
    refetchIntervalInBackground: false,
  });
  const page = activityQuery.data;
  const cancelableCount = page?.cancelable ?? 0;
  const loading = activityQuery.isPending;
  const error =
    localError || getApiErrorText(activityQuery.error, "message") || activityQuery.error?.message;

  const visibleRequests = page?.items;
  const pageCount = Math.ceil((page?.matching ?? 0) / ACTIVITY_PAGE_SIZE);
  useClampPage(
    pageIndex,
    page && !activityQuery.isPlaceholderData ? Math.max(pageCount, 1) : undefined,
    setPageIndex,
  );

  const listEntries = useMemo(() => {
    if (!visibleRequests) return [];
    if (isListLikeView) {
      return visibleRequests.map((request): ActivityListEntry => ({
        type: "item",
        request,
        key: request.id,
      }));
    }
    return buildHistoryListEntries(visibleRequests);
  }, [isListLikeView, visibleRequests]);

  const setActiveStatus = (status: string | null) =>
    setSearchParams(status ? { status } : {}, { replace: true });

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
      queryClient.setQueryData<ActivityPageData>(pageQueryKey, (current) =>
        current ? { ...current, items: updater(current.items) } : current,
      );
    },
    [pageQueryKey],
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

  const cancelAllMutation = useMutation({
    mutationFn: () => parseResponse(playlistJobsClient.jobs.cancel.$post()),
    onError: () => setLocalError("Failed to cancel downloads."),
    onSettled: () => {
      setConfirmingCancelAll(false);
      void queryClient.invalidateQueries({ queryKey: activityQueryKey });
    },
  });

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
    } catch (jobError) {
      setJobErrors((prev) => ({
        ...prev,
        [jobId]:
          getApiErrorText(jobError, "message") ||
          getApiErrorText(jobError, "error") ||
          (action === "approve" ? "Failed to approve" : "Failed to deny"),
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
        <ActivityStatusTabs
          total={null}
          filters={[]}
          active={activeStatus}
          onChange={setActiveStatus}
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
      <ActivityStatusTabs
        total={page?.total ?? 0}
        filters={page?.filters ?? []}
        active={activeStatus}
        onChange={setActiveStatus}
        action={
          isQueueView && cancelableCount > 0 ? (
            <button
              type="button"
              className="btn btn-secondary activity-toolbar__action"
              onClick={() => setConfirmingCancelAll(true)}
            >
              <X aria-hidden="true" />
              <span>Cancel all</span>
            </button>
          ) : null
        }
      />

      {error && (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load activity"
          message={error !== "Failed to load activity." ? error : null}
          onRetry={() => {
            setLocalError(null);
            void activityQuery.refetch();
          }}
        />
      )}

      {listEntries.length === 0 ? (
        !error && (
          <StatePanel
            icon={<Music className="artist-icon-lg" />}
            title={activeStatus ? "No matches" : emptyState.title}
          >
            {isQueueView && !activeStatus && (
              <RouteLink to="/" className="btn btn-primary">
                Start discovering
              </RouteLink>
            )}
          </StatePanel>
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
                reviewingJobs,
                controllingJobs,
                jobErrors,
                currentTrack,
                isPlaying,
                onApprove: (jobId: string | null | undefined) => reviewBlockedJob(jobId, "approve"),
                onDeny: (jobId: string | null | undefined) => reviewBlockedJob(jobId, "deny"),
                onCancel: (jobId: string | null | undefined) => controlDownloadJob(jobId, "cancel"),
                onRetry: (jobId: string | null | undefined) => controlDownloadJob(jobId, "retry"),
                onPreview: handleReviewPreview,
                onInfo: setInfoRequest,
              };
              return isAlbumActivityRequest(entry.request) ? (
                <ActivityAlbumRow key={entry.key} request={entry.request} {...rowProps} />
              ) : (
                <ActivityRequestRow key={entry.key} request={entry.request} {...rowProps} />
              );
            });
          })()}
          <Pagination
            page={pageIndex}
            pageCount={pageCount}
            label={`${activeViewLabel} pages`}
            onChange={setPageIndex}
          />
        </div>
      )}
      <ActivityInfoModal item={infoRequest} onClose={() => setInfoRequest(null)} />
      <ConfirmModal
        open={confirmingCancelAll}
        title="Cancel all downloads?"
        body={`${cancelableCount} ${cancelableCount === 1 ? "download" : "downloads"} will stop. You can retry each one from History.`}
        confirmLabel="Cancel all"
        cancelLabel="Keep"
        busyLabel="Cancelling"
        busy={cancelAllMutation.isPending}
        onCancel={() => setConfirmingCancelAll(false)}
        onConfirm={() => cancelAllMutation.mutate()}
      />
    </div>
  );
}

export default ActivityPage;
