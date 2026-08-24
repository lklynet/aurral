import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Info,
  RotateCcw,
  Search,
} from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import { useToast } from "../../contexts/ToastContext";
import { formatDateTime } from "../../utils/dateTime.js";
import { useSearchParams } from "react-router-dom";
import { PageSectionMobileNav } from "../../components/PageSectionMobileNav";
import {
  getAllFlowJobs,
  reSearchFlowTrack,
  reSearchAllMissingTracks,
  reSearchSharedPlaylistTrack,
  searchTrackUpgrade,
  searchAllUpgrades,
} from "../../utils/api/endpoints/playlists.js";
import { queryClient, queryKeys } from "../../queryClient.js";
import { usePlaylistStatusQuery } from "../flows/usePlaylistStatusQuery.js";
import { buildWantedPath, WANTED_VIEWS } from "../../navigation/activityNavConfig";
import ActivityToolbar from "./ActivityToolbar";
import ActivityInfoModal from "./ActivityInfoModal";
import {
  getMissingJobKey,
  isCutoffUnmetAurralJob,
  isMissingAurralJob,
  sortMissingJobs,
} from "./activityMissingUtils.js";

const WANTED_PAGE_SIZE = 25;

const toPlaylistInfo = (status) => {
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

const toJobDate = (value) => {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const numericValue = Number(value);
  const date = new Date(Number.isFinite(numericValue) ? numericValue : value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatJobDate = (value) => {
  const date = toJobDate(value);
  if (!date) return "";
  return formatDateTime(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

function MissingJobRow({ job, playlist, actionState, onAction, onInfo }) {
  const isMissing = isMissingAurralJob(job);
  const isWorking = actionState === "working";
  const isQueued = actionState === "queued";
  const operationLabel = playlist?.name || "Aurral operation";
  const meta = [job.artistName, job.albumName].filter(Boolean).join(" · ") || operationLabel;
  const hint = isMissing
    ? job.error || operationLabel
    : `${job.qualityLabel || "Unknown quality"} · ${
        job.qualityState === "below-floor" ? "Below cutoff" : "Upgrade available"
      }`;
  const statusLabel = isMissing ? "Missing" : isQueued ? "Upgrade queued" : "Cutoff unmet";
  const StatusIcon = isMissing ? AlertCircle : ArrowUpCircle;

  return (
    <article className="activity-row">
      <span
        className={`activity-row__status activity-row__status--${isMissing ? "failed" : "pending"}`}
        title={statusLabel}
        aria-label={statusLabel}
      >
        <StatusIcon aria-hidden="true" />
      </span>
      <div className="activity-row__details">
        <h2 className="activity-row__title" title={job.trackName || "Unknown track"}>
          {job.trackName || "Unknown track"}
        </h2>
        <p className="activity-row__meta" title={meta}>
          {meta}
        </p>
        <p className="activity-row__hint" title={job.error || hint}>
          {hint}
        </p>
      </div>
      <span className={`activity-row__status-label activity-row__status-label--${isMissing ? "failed" : "pending"}`}>
        {statusLabel}
      </span>
      <time className="activity-row__time" dateTime={toJobDate(job.createdAt)?.toISOString()}>
        {formatJobDate(job.createdAt)}
      </time>
      <div className="activity-row__actions">
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
  const [infoJob, setInfoJob] = useState(null);
  const [actionStates, setActionStates] = useState({});
  const [filterValue, setFilterValue] = useState("");
  const [searchingAll, setSearchingAll] = useState(false);
  const [visibleCount, setVisibleCount] = useState(WANTED_PAGE_SIZE);
  const jobsQueryKey = queryKeys.playlistJobs();
  const jobsQuery = useQuery({
    queryKey: jobsQueryKey,
    queryFn: ({ signal }) => getAllFlowJobs({ signal }),
    staleTime: 15_000,
  });
  const statusQuery = usePlaylistStatusQuery();
  const allJobs = useMemo(
    () => Array.isArray(jobsQuery.data) ? jobsQuery.data : [],
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
  const error = jobsQuery.error?.response?.data?.message ||
    statusQuery.error?.response?.data?.message ||
    jobsQuery.error?.message || statusQuery.error?.message || "";
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
      const next = {};
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

  const handleAction = async (job) => {
    const id = getMissingJobKey(job);
    if (!id || actionStates[id]) return;
    const isMissing = isMissingAurralJob(job);
    setActionStates((current) => ({ ...current, [id]: "working" }));
    try {
      if (isMissing) {
        const playlist = playlistInfo.get(String(job.playlistType));
        const reSearch = playlist?.kind === "playlist"
          ? reSearchSharedPlaylistTrack
          : reSearchFlowTrack;
        await reSearch(job.playlistType, job.id);
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
        await searchTrackUpgrade(job.playlistType, job.id);
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
        requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          (isMissing ? "Failed to re-search track" : "Failed to search for an upgrade"),
      );
    }
  };

  const handleSearchAll = useCallback(async () => {
    if (searchingAll || !hasWantedJobs) return;
    setSearchingAll(true);
    try {
      const result = showingCutoff
        ? await searchAllUpgrades()
        : await reSearchAllMissingTracks();
      if (showingCutoff) {
        showSuccess("Cutoff upgrade search queued");
      } else {
        const requeued = Number(result?.requeued || 0);
        showSuccess(
          requeued > 0
            ? `Re-searching ${requeued} missing track${requeued === 1 ? "" : "s"}`
            : "No missing tracks to re-search",
        );
      }
      await loadJobs();
    } catch (requestError) {
      showError(
        requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          (showingCutoff
            ? "Failed to search for upgrades"
            : "Failed to re-search missing tracks"),
      );
    } finally {
      setSearchingAll(false);
    }
  }, [hasWantedJobs, loadJobs, searchingAll, showingCutoff, showError, showSuccess]);

  const searchAllButton = (
    <button
      type="button"
      className="btn btn-secondary activity-toolbar__action"
      onClick={handleSearchAll}
      disabled={searchingAll || !hasWantedJobs}
      aria-busy={searchingAll}
    >
      {searchingAll ? (
        <DotLoader size="sm" label={null} />
      ) : showingCutoff ? (
        <ArrowUpCircle aria-hidden="true" />
      ) : (
        <RotateCcw aria-hidden="true" />
      )}
      <span>{searchingAll ? "Searching…" : showingCutoff ? "Search all upgrades" : "Re-search all"}</span>
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
        <div className="activity-page__loading" role="status" aria-label="Loading wanted tracks">
          <DotLoader size="2xl" label={null} />
        </div>
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
        <div className="artist-error-panel activity-page__error" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load wanted tracks</h2>
          <p className="artist-error-copy">{error}</p>
          <button type="button" className="btn btn-secondary btn--bold" onClick={() => loadJobs()}>
            Try again
          </button>
        </div>
      ) : null}

      {!error && visibleJobs.length === 0 ? (
        <div className="search-empty-panel activity-page__empty">
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
                ? "Every Aurral-owned file currently meets the configured quality cutoff."
                : "Every Aurral operation currently has a track available or in progress."}
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
              actionState={actionStates[getMissingJobKey(job)] || (job.upgradeQueued ? "queued" : "")}
              onAction={handleAction}
              onInfo={setInfoJob}
            />
          ))}
          {hasMoreJobs ? (
            <div className="activity-list__load-more">
              <button
                type="button"
                className="btn btn-secondary btn--bold btn-min-h"
                onClick={() => setVisibleCount((count) => count + WANTED_PAGE_SIZE)}
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ActivityInfoModal item={infoJob} onClose={() => setInfoJob(null)} />
    </section>
  );
}
