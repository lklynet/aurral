import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiError } from "../../utils/api/core.ts";
import { getApiErrorMessage, getApiErrorText } from "../onboardingUtils.tsx";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Info,
  ListFilter,
  RotateCcw,
  Search,
} from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { SkeletonActivityList, SkeletonStatus } from "../../components/Skeletons";
import TooltipButton from "../../components/TooltipButton";
import { useToast } from "../../contexts/ToastContext";
import { formatDateTime } from "../../utils/dateTime.ts";
import { useSearchParams } from "react-router";
import { PageSectionMobileNav } from "../../components/PageSectionMobileNav";
import { parseResponse } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { playlistJobsClient } from "../../utils/api/clients/playlistJobs.ts";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import { withAuthenticatedTrackArtwork } from "../../utils/api/playlistUrls.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { usePlaylistStatusQuery } from "../playlists/usePlaylistStatusQuery.ts";
import { buildWantedPath, WANTED_VIEWS } from "../../navigation/activityNavConfig";
import ActivityToolbar from "./ActivityToolbar";
import ActivityInfoModal from "./ActivityInfoModal";
import ManualMissingSearchModal from "./ManualMissingSearchModal";
import {
  getMissingJobKey,
  isCutoffUnmetAurralJob,
  isMissingAurralJob,
  sortMissingJobs,
  type MissingJob,
} from "./activityMissingUtils.ts";
import Tooltip from "../../components/Tooltip";
import type { PlaylistStatus } from "../playlists/playlistStats.ts";

const WANTED_PAGE_SIZE = 25;

type MissingActionState = "working" | "queued";

type MissingPageJob = MissingJob & {
  id: string;
  status: string;
  playlistType: string;
  artistName?: string | null;
  albumName?: string | null;
  error?: string | null;
  qualityLabel?: string | null;
  upgradeQueued?: boolean;
};

type MissingInfoJob = MissingPageJob & { playlistName: string };

const toPlaylistInfo = (status: PlaylistStatus | undefined) => {
  const entries = [
    ...(Array.isArray(status?.flows) ? status.flows : []).map((entry) => ({
      ...entry,
      kind: "flow",
    })),
    ...(Array.isArray(status?.sharedPlaylists) ? status.sharedPlaylists : []).map((entry) => ({
      ...entry,
      kind: "playlist",
    })),
  ];
  return new Map(entries.map((entry) => [String(entry.id), entry]));
};

type JobDateInput = string | number | null | undefined;

type PlaylistInfo =
  ReturnType<typeof toPlaylistInfo> extends Map<string, infer Entry> ? Entry : never;

const toJobDate = (value: JobDateInput) => {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const numericValue = Number(value);
  const date = new Date(Number.isFinite(numericValue) ? numericValue : value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatJobDate = (value: JobDateInput) => {
  const date = toJobDate(value);
  if (!date) return "";
  return formatDateTime(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

function MissingJobRow({
  job,
  playlist,
  actionState,
  onAction,
  onInfo,
  onManualSearch,
}: {
  job: MissingPageJob;
  playlist: PlaylistInfo | undefined;
  actionState: MissingActionState | "";
  onAction: (job: MissingPageJob) => void;
  onInfo: (job: MissingInfoJob) => void;
  onManualSearch: (job: MissingPageJob) => void;
}) {
  const isMissing = isMissingAurralJob(job);
  const isWorking = actionState === "working";
  const isQueued = actionState === "queued";
  const operationLabel = playlist?.name || "Aurral operation";
  const meta = [job.artistName, job.albumName].filter(Boolean).join(" · ") || operationLabel;
  const hint = isWorking
    ? isMissing
      ? "Adding re-search to Queue"
      : "Adding upgrade search to Queue"
    : isQueued
      ? "Upgrade search is in Queue"
      : isMissing
        ? job.error || operationLabel
        : `${job.qualityLabel || "Unknown quality"} · ${
            job.qualityState === "below-floor" ? "Below cutoff" : "Upgrade available"
          }`;
  const statusLabel = isWorking
    ? isMissing
      ? "Re-searching"
      : "Queuing upgrade"
    : isMissing
      ? "Missing"
      : isQueued
        ? "Upgrade queued"
        : "Cutoff unmet";
  const StatusIcon = isMissing ? AlertCircle : ArrowUpCircle;

  return (
    <article className="activity-row">
      <Tooltip content={statusLabel}>
        <span
          className={`activity-row__status activity-row__status--${isMissing ? "failed" : "pending"}`}
          aria-label={statusLabel}
        >
          <StatusIcon aria-hidden="true" />
        </span>
      </Tooltip>
      <div className="activity-row__details">
        <Tooltip content={job.trackName || "Unknown track"}>
          <h2 className="activity-row__title">{job.trackName || "Unknown track"}</h2>
        </Tooltip>
        <Tooltip content={meta}>
          <p className="activity-row__meta">{meta}</p>
        </Tooltip>
        <Tooltip content={job.error || hint}>
          <p className="activity-row__hint">{hint}</p>
        </Tooltip>
      </div>
      <span
        className={`activity-row__status-label activity-row__status-label--${isMissing ? "failed" : "pending"}`}
      >
        {statusLabel}
      </span>
      <time className="activity-row__time" dateTime={toJobDate(job.createdAt)?.toISOString()}>
        {formatJobDate(job.createdAt)}
      </time>
      <div className="activity-row__actions">
        {isMissing ? (
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => onManualSearch(job)}
            disabled={isWorking}
            label="Choose a download manually"
          >
            <ListFilter aria-hidden="true" />
          </TooltipButton>
        ) : null}
        <TooltipButton
          className="native-library-icon-button"
          onClick={() => onAction(job)}
          disabled={isWorking || isQueued}
          label={
            isWorking
              ? "Queuing search"
              : isMissing
                ? "Re-search track"
                : isQueued
                  ? "Upgrade queued"
                  : "Search for upgrade"
          }
        >
          {isWorking ? (
            <DotLoader size="sm" label={null} />
          ) : isMissing ? (
            <RotateCcw aria-hidden="true" />
          ) : (
            <Search aria-hidden="true" />
          )}
        </TooltipButton>
        <TooltipButton
          className="native-library-icon-button"
          onClick={() => onInfo({ ...job, playlistName: operationLabel })}
          label={`Show ${job.trackName || "track"} details`}
        >
          <Info aria-hidden="true" />
        </TooltipButton>
      </div>
    </article>
  );
}

export default function ActivityMissingPage() {
  const [searchParams] = useSearchParams();
  const { showError, showSuccess } = useToast();
  const [infoJob, setInfoJob] = useState<MissingInfoJob | null>(null);
  const [manualSearchJob, setManualSearchJob] = useState<MissingPageJob | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, MissingActionState>>({});
  const [filterValue, setFilterValue] = useState("");
  const [searchingAll, setSearchingAll] = useState(false);
  const [visibleCount, setVisibleCount] = useState(WANTED_PAGE_SIZE);
  const jobsQueryKey = queryKeys.playlistJobs();
  const jobsQuery = useQuery<unknown, ApiError>({
    queryKey: jobsQueryKey,
    queryFn: ({ signal }) =>
      parseResponse(playlistJobsClient.jobs.$get({ query: {} }, { init: { signal } })).then(
        (jobs) => jobs.map(withAuthenticatedTrackArtwork),
      ),
    staleTime: 15_000,
  });
  const statusQuery = usePlaylistStatusQuery();
  const allJobs: MissingPageJob[] = useMemo(
    () => (Array.isArray(jobsQuery.data) ? jobsQuery.data : []),
    [jobsQuery.data],
  );
  const playlistInfo = useMemo(() => toPlaylistInfo(statusQuery.data), [statusQuery.data]);
  const jobs = useMemo(() => {
    const upgradeJobIds = new Set(
      allJobs
        .filter((job) => job?.upgradeForJobId && ["pending", "downloading"].includes(job.status))
        .map((job) => String(job.upgradeForJobId)),
    );
    return allJobs
      .filter((job) => isMissingAurralJob(job) || isCutoffUnmetAurralJob(job))
      .map((job) => ({ ...job, upgradeQueued: upgradeJobIds.has(String(job.id)) }))
      .sort(sortMissingJobs);
  }, [allJobs]);
  const loading = jobsQuery.isPending || statusQuery.isPending;
  const error =
    getApiErrorText(jobsQuery.error, "message") ||
    getApiErrorText(statusQuery.error, "message") ||
    jobsQuery.error?.message ||
    statusQuery.error?.message ||
    "";
  const activeTab = searchParams.get("tab") === "cutoff" ? "cutoff" : "missing";
  const showingCutoff = activeTab === "cutoff";
  const filterPlaceholder = showingCutoff ? "Filter cutoff unmet" : "Filter missing tracks";
  const hasFilter = filterValue.trim().length > 0;
  const wantedMobileNav = (
    <PageSectionMobileNav
      sections={WANTED_VIEWS}
      activeId={activeTab}
      label="Wanted"
      getSectionPath={buildWantedPath}
      selectId="wanted-view-select"
    />
  );

  useEffect(() => {
    setVisibleCount(WANTED_PAGE_SIZE);
  }, [activeTab]);

  useEffect(() => {
    const jobsByKey = new Map(jobs.map((job) => [getMissingJobKey(job), job]));
    setActionStates((current) => {
      const next: Record<string, MissingActionState> = {};
      for (const [id, state] of Object.entries(current)) {
        if (state === "working") next[id] = state;
        else if (jobsByKey.get(id)?.upgradeQueued) next[id] = "queued";
      }
      for (const job of jobs) {
        if (job.upgradeQueued) next[getMissingJobKey(job)] = "queued";
      }
      return next;
    });
  }, [jobs]);

  const loadJobs = useCallback(async () => {
    await Promise.all([jobsQuery.refetch(), statusQuery.fetchStatus()]);
  }, [jobsQuery, statusQuery]);

  const visibleJobs = useMemo(() => {
    const query = filterValue.trim().toLocaleLowerCase();
    return jobs.filter((job) => {
      if (showingCutoff ? !isCutoffUnmetAurralJob(job) : !isMissingAurralJob(job)) return false;
      if (!query) return true;
      return [job.trackName, job.artistName, job.albumName, job.error]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [filterValue, jobs, showingCutoff]);
  const pagedJobs = visibleJobs.slice(0, visibleCount);
  const hasMoreJobs = visibleCount < visibleJobs.length;
  const hasWantedJobs = jobs.some((job) =>
    showingCutoff ? isCutoffUnmetAurralJob(job) : isMissingAurralJob(job),
  );
  const actionableJobs = jobs.filter((job) =>
    showingCutoff ? isCutoffUnmetAurralJob(job) && !job.upgradeQueued : isMissingAurralJob(job),
  );
  const hasActionableJobs = actionableJobs.length > 0;
  const allUpgradesQueued = showingCutoff && hasWantedJobs && !hasActionableJobs;

  const handleAction = async (job: MissingPageJob) => {
    const id = getMissingJobKey(job);
    if (!id || actionStates[id]) return;
    const isMissing = isMissingAurralJob(job);
    setActionStates((current) => ({ ...current, [id]: "working" }));
    try {
      if (isMissing) {
        const playlist = playlistInfo.get(String(job.playlistType));
        const playlistId = encodeURIComponent(job.playlistType);
        const jobId = encodeURIComponent(job.id);
        await parseResponse(
          playlist?.kind === "playlist"
            ? staticPlaylistsClient["shared-playlists"][":playlistId"].tracks[
                ":jobId"
              ].research.$post({ param: { playlistId, jobId } })
            : flowsClient.flows[":flowId"].tracks[":jobId"].research.$post({
                param: { flowId: playlistId, jobId },
              }),
        );
        queryClient.setQueryData(jobsQueryKey, (current) =>
          (Array.isArray(current) ? current : []).filter((entry) => getMissingJobKey(entry) !== id),
        );
        setActionStates((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        showSuccess(`Re-searching ${job.trackName || "track"}`);
      } else {
        await parseResponse(
          playlistJobsClient["quality-upgrades"][":playlistId"][":jobId"].$post({
            param: {
              playlistId: encodeURIComponent(job.playlistType),
              jobId: encodeURIComponent(job.id),
            },
          }),
        );
        setActionStates((current) => ({ ...current, [id]: "queued" }));
        showSuccess(`Upgrade search queued for ${job.trackName || "track"}`);
      }
    } catch (requestError) {
      setActionStates((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      showError(
        getApiErrorMessage(
          requestError,
          isMissing ? "Failed to re-search track" : "Failed to search for an upgrade",
        ),
      );
    }
  };

  const handleSearchAll = useCallback(async () => {
    if (searchingAll || !hasActionableJobs) return;
    setSearchingAll(true);
    setActionStates((current) =>
      Object.fromEntries([
        ...Object.entries(current),
        ...actionableJobs.map((job) => [getMissingJobKey(job), "working"]),
      ]),
    );
    try {
      if (showingCutoff) {
        const { queued } = await parseResponse(playlistJobsClient["quality-upgrades"].$post());
        setActionStates((current) => ({
          ...current,
          ...Object.fromEntries(actionableJobs.map((job) => [getMissingJobKey(job), "queued"])),
        }));
        showSuccess(
          queued > 0
            ? `${queued} upgrade search${queued === 1 ? "" : "es"} queued`
            : "No new upgrade searches were queued",
        );
      } else {
        const { requeued } = await parseResponse(playlistJobsClient["research-missing"].$post());
        setActionStates((current) => {
          const next = { ...current };
          for (const job of actionableJobs) delete next[getMissingJobKey(job)];
          return next;
        });
        showSuccess(
          requeued > 0
            ? `Re-searching ${requeued} missing track${requeued === 1 ? "" : "s"}`
            : "No missing tracks to re-search",
        );
      }
      await loadJobs();
      await queryClient.invalidateQueries({ queryKey: ["activity", "requests"] });
    } catch (requestError) {
      setActionStates((current) => {
        const next = { ...current };
        for (const job of actionableJobs) {
          const id = getMissingJobKey(job);
          if (next[id] === "working") delete next[id];
        }
        return next;
      });
      showError(
        getApiErrorMessage(
          requestError,
          showingCutoff ? "Failed to search for upgrades" : "Failed to re-search missing tracks",
        ),
      );
    } finally {
      setSearchingAll(false);
    }
  }, [
    actionableJobs,
    hasActionableJobs,
    loadJobs,
    searchingAll,
    showingCutoff,
    showError,
    showSuccess,
  ]);

  const searchAllButton = (
    <button
      type="button"
      className="btn btn-secondary activity-toolbar__action"
      onClick={handleSearchAll}
      disabled={searchingAll || !hasActionableJobs}
      aria-busy={searchingAll}
    >
      {searchingAll ? (
        <DotLoader size="sm" label={null} />
      ) : showingCutoff ? (
        <ArrowUpCircle aria-hidden="true" />
      ) : (
        <RotateCcw aria-hidden="true" />
      )}
      <span>
        {searchingAll
          ? showingCutoff
            ? "Queuing upgrades"
            : "Re-searching all"
          : allUpgradesQueued
            ? "Upgrades queued"
            : "Search all"}
      </span>
    </button>
  );

  if (loading) {
    return (
      <section className="activity-page__missing" aria-label="Wanted tracks">
        {wantedMobileNav}
        <ActivityToolbar
          filterValue={filterValue}
          onFilterChange={setFilterValue}
          action={searchAllButton}
          placeholder={filterPlaceholder}
        />
        <SkeletonStatus label="Loading wanted tracks">
          <SkeletonActivityList count={8} hint actions={3} />
        </SkeletonStatus>
      </section>
    );
  }

  return (
    <section className="activity-page__missing" aria-label="Wanted tracks">
      {wantedMobileNav}
      <ActivityToolbar
        filterValue={filterValue}
        onFilterChange={setFilterValue}
        action={searchAllButton}
        placeholder={filterPlaceholder}
      />
      {error ? (
        <div className="search-empty-panel" role="alert">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <AlertCircle />
          </div>
          <h2 className="search-empty-panel__title">Couldn’t load wanted tracks</h2>
          <p className="search-empty-panel__message">{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => loadJobs()}>
            Try again
          </button>
        </div>
      ) : null}

      {!error && visibleJobs.length === 0 ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <CheckCircle2 className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">
            {hasFilter
              ? "No tracks match your filter"
              : showingCutoff
                ? "No cutoff gaps"
                : "No missing tracks"}
          </h2>
          <p className="search-empty-panel__message">
            {hasFilter
              ? `${showingCutoff ? "No cutoff-unmet" : "No missing"} tracks match your filter.`
              : showingCutoff
                ? "All Aurral tracks meet the quality cutoff."
                : "Every requested track is available or in progress."}
          </p>
        </div>
      ) : null}

      {!error && visibleJobs.length > 0 ? (
        <div className="activity-list">
          {pagedJobs.map((job) => (
            <MissingJobRow
              key={getMissingJobKey(job)}
              job={job}
              playlist={playlistInfo.get(String(job.playlistType))}
              actionState={
                actionStates[getMissingJobKey(job)] || (job.upgradeQueued ? "queued" : "")
              }
              onAction={handleAction}
              onInfo={setInfoJob}
              onManualSearch={setManualSearchJob}
            />
          ))}
          {hasMoreJobs ? (
            <div className="activity-list__load-more">
              <button
                type="button"
                className="btn btn-secondary btn-min-h"
                onClick={() => setVisibleCount((count) => count + WANTED_PAGE_SIZE)}
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ActivityInfoModal item={infoJob} onClose={() => setInfoJob(null)} />
      <ManualMissingSearchModal
        job={manualSearchJob}
        onClose={() => setManualSearchJob(null)}
        onQueued={(job) => {
          const id = getMissingJobKey(job);
          queryClient.setQueryData(jobsQueryKey, (current) =>
            (Array.isArray(current) ? current : []).filter(
              (entry) => getMissingJobKey(entry) !== id,
            ),
          );
          showSuccess(`Downloading ${job.trackName || "selected track"}`);
        }}
      />
    </section>
  );
}
