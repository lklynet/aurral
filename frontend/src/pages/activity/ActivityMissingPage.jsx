import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Info,
  Loader,
  RotateCcw,
  Search,
} from "lucide-react";
import TooltipButton from "../../components/TooltipButton";
import { useToast } from "../../contexts/ToastContext";
import { formatDateTime } from "../../utils/dateTime.js";
import { useSearchParams } from "react-router-dom";
import {
  getAllFlowJobs,
  getFlowStatus,
  reSearchFlowTrack,
  reSearchSharedPlaylistTrack,
  searchTrackUpgrade,
} from "../../utils/api/endpoints/playlists.js";
import ActivityToolbar from "./ActivityToolbar";
import ActivityInfoModal from "./ActivityInfoModal";
import {
  getMissingJobKey,
  isCutoffUnmetAurralJob,
  isMissingAurralJob,
  sortMissingJobs,
} from "./activityMissingUtils.js";

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

const formatJobDate = (value) => {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
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
      <span className="activity-row__status-label">{statusLabel}</span>
      <time className="activity-row__time" dateTime={job.createdAt ? new Date(Number(job.createdAt)).toISOString() : undefined}>
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
            <Loader className="animate-spin" aria-hidden="true" />
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
  const [jobs, setJobs] = useState([]);
  const [playlistInfo, setPlaylistInfo] = useState(new Map());
  const [infoJob, setInfoJob] = useState(null);
  const [actionStates, setActionStates] = useState({});
  const [filterValue, setFilterValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const activeTab = searchParams.get("tab") === "cutoff" ? "cutoff" : "missing";
  const showingCutoff = activeTab === "cutoff";
  const filterPlaceholder = showingCutoff ? "Filter cutoff unmet" : "Filter missing tracks";

  const loadJobs = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const [allJobs, status] = await Promise.all([getAllFlowJobs(), getFlowStatus()]);
      const upgradeJobIds = new Set(
        (Array.isArray(allJobs) ? allJobs : [])
          .filter((job) => job?.upgradeForJobId && ["pending", "downloading"].includes(job.status))
          .map((job) => String(job.upgradeForJobId)),
      );
      setJobs(
        (Array.isArray(allJobs) ? allJobs : [])
          .filter((job) => isMissingAurralJob(job) || isCutoffUnmetAurralJob(job))
          .map((job) => ({ ...job, upgradeQueued: upgradeJobIds.has(String(job.id)) }))
          .sort(sortMissingJobs),
      );
      setActionStates({});
      setPlaylistInfo(toPlaylistInfo(status));
    } catch (requestError) {
      setError(
          requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          "Failed to load wanted tracks",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

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
        setJobs((current) => current.filter((entry) => getMissingJobKey(entry) !== id));
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

  if (loading) {
    return (
      <div>
        <ActivityToolbar
          filterValue={filterValue}
          onFilterChange={setFilterValue}
          onRefresh={() => loadJobs({ silent: true })}
          refreshing={refreshing}
          placeholder={filterPlaceholder}
        />
        <div className="activity-page__loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <section className="activity-page__missing" aria-label="Wanted tracks">
      <ActivityToolbar
        filterValue={filterValue}
        onFilterChange={setFilterValue}
        onRefresh={() => loadJobs({ silent: true })}
        refreshing={refreshing}
        placeholder={filterPlaceholder}
      />
      {error ? (
        <div className="artist-error-panel" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load wanted tracks</h2>
          <p className="artist-error-copy">{error}</p>
          <button type="button" className="btn btn-secondary btn--bold" onClick={() => loadJobs()}>
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
            {showingCutoff ? "No cutoff gaps" : "No missing tracks"}
          </h2>
          <p className="search-empty-panel__message">
            {showingCutoff
              ? "Every Aurral-owned file currently meets the configured quality cutoff."
              : "Every Aurral operation currently has a track available or in progress."}
          </p>
        </div>
      ) : null}

      {!error && visibleJobs.length > 0 ? (
        <div className="activity-list">
          {visibleJobs.map((job) => (
            <MissingJobRow
              key={getMissingJobKey(job)}
              job={job}
              playlist={playlistInfo.get(String(job.playlistType))}
              actionState={actionStates[getMissingJobKey(job)] || (job.upgradeQueued ? "queued" : "")}
              onAction={handleAction}
              onInfo={setInfoJob}
            />
          ))}
        </div>
      ) : null}
      <ActivityInfoModal item={infoJob} onClose={() => setInfoJob(null)} />
    </section>
  );
}
