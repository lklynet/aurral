import { useState, useMemo, useCallback, useEffect } from "react";
import {
  Loader2,
  Settings,
  Check,
  Clock,
  AlertCircle,
  Download,
  Sparkles,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import {
  updateFlowWorkerSettings,
  rotateFlowWorkerSoulseekCredentials,
  getFlowStatus,
} from "../utils/api";
import { useFlowStatus } from "./flows/useFlowStatus";
import {
  DEFAULT_WORKER_SETTINGS,
  getWorkerSettingsFromStatus,
  normalizeRetryCycleMinutes,
  normalizeExistingFileMode,
} from "./flows/flowWorkerSettings";
import { getCombinedActivityStats } from "./flows/flowStats";
import { FlowWorkerSettingsModal } from "./FlowPageComponents";

function getPlaylistName(playlistId, flows, sharedPlaylists) {
  const flow = flows.find((item) => item.id === playlistId);
  if (flow?.name) return flow.name;
  const playlist = sharedPlaylists.find((item) => item.id === playlistId);
  return playlist?.name || "Playlist";
}

function parseQueueOperation(operationQueue) {
  const label = String(operationQueue?.currentLabel || "").trim();
  if (!label) return null;
  const colonIndex = label.indexOf(":");
  const action = colonIndex >= 0 ? label.slice(0, colonIndex) : label;
  const targetId = colonIndex >= 0 ? label.slice(colonIndex + 1) : "";
  let verb = "Working";
  let icon = Sparkles;
  if (action === "enable" || action === "scheduled") {
    verb = "Generating playlist";
    icon = Sparkles;
  } else if (action === "disable" || action === "delete") {
    verb = "Cleaning up";
    icon = Trash2;
  } else if (action === "reset") {
    verb = "Resetting";
    icon = RotateCcw;
  }
  return { action, targetId, verb, icon };
}

function categorizeJobs(jobs) {
  const downloading = [];
  const pending = [];
  const recent = [];
  const failed = [];
  for (const job of jobs) {
    if (job.status === "downloading") downloading.push(job);
    else if (job.status === "pending") pending.push(job);
    else if (job.status === "done") recent.push(job);
    else if (job.status === "failed") failed.push(job);
  }
  recent.sort(
    (a, b) =>
      Number(b.completedAt || b.startedAt || 0) -
      Number(a.completedAt || a.startedAt || 0),
  );
  return {
    downloading,
    pending,
    recent: recent.slice(0, 25),
    failed,
  };
}

function WorkerStatusBar({ status, soulseekConnected }) {
  const workerRunning = status?.worker?.running === true;
  const queueProcessing = status?.operationQueue?.processing === true;
  const activityStats = getCombinedActivityStats(status);
  const pending = activityStats.pending;
  const downloading = activityStats.downloading;
  const done = activityStats.done;
  const failed = activityStats.failed;
  const total = pending + downloading + done;
  const progressPct =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const hintMessage = String(status?.hint?.message || "").trim();
  const hasCurrentJob =
    status?.worker?.currentJob?.artistName &&
    status?.worker?.currentJob?.trackName;

  let phaseLabel = "Idle";
  let badgeClass = "badge-neutral";
  if (workerRunning) {
    phaseLabel = "Running";
    badgeClass = "badge-success";
  } else if (queueProcessing) {
    phaseLabel = "Preparing";
    badgeClass = "badge-warning";
  }

  let summary = hintMessage || "No active work";
  if (hasCurrentJob && workerRunning) {
    summary = "Downloading tracks from Soulseek";
  } else if (queueProcessing && !hintMessage) {
    summary = "Preparing playlists";
  }

  return (
    <div className="downloads-page__status-bar">
      <div className="downloads-page__status-bar-top">
        <div className="downloads-page__status-bar-phase">
          {workerRunning ? (
            <Loader2 className="downloads-page__status-bar-icon downloads-page__status-bar-icon--active animate-spin" />
          ) : (
            <span
              className={`downloads-page__status-dot${workerRunning || queueProcessing ? " downloads-page__status-dot--active" : ""}`}
            />
          )}
          <span className={`badge ${badgeClass}`}>{phaseLabel}</span>
          <span className="downloads-page__status-bar-message">{summary}</span>
        </div>
        <div className="downloads-page__status-bar-meta">
          <span
            className={`downloads-page__soulseek${soulseekConnected ? " downloads-page__soulseek--connected" : ""}`}
          >
            <span className="downloads-page__soulseek-dot" />
            Soulseek {soulseekConnected ? "connected" : "offline"}
          </span>
        </div>
      </div>
      {total > 0 ? (
        <>
          <div className="flow-page__progress downloads-page__status-bar-progress">
            <div className="flow-page__progress-bar">
              <div
                className="flow-page__progress-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <div className="downloads-page__status-bar-stats">
            <span>
              Pending{" "}
              <strong className="downloads-page__stat-value">{pending}</strong>
            </span>
            <span className="downloads-page__stat-sep">·</span>
            <span>
              Downloading{" "}
              <strong className="downloads-page__stat-value">
                {downloading}
              </strong>
            </span>
            <span className="downloads-page__stat-sep">·</span>
            <span>
              Done{" "}
              <strong className="downloads-page__stat-value">{done}</strong>
            </span>
            {failed > 0 ? (
              <>
                <span className="downloads-page__stat-sep">·</span>
                <span className="downloads-page__stat-failed">
                  Stalled{" "}
                  <strong className="downloads-page__stat-value">
                    {failed}
                  </strong>
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function NowPanel({
  status,
  flows,
  sharedPlaylists,
}) {
  const operationQueue = status?.operationQueue;
  const queueOp = operationQueue?.processing
    ? parseQueueOperation(operationQueue)
    : null;
  const currentJob = status?.worker?.currentJob;
  const hasCurrentJob =
    currentJob?.artistName && currentJob?.trackName;
  const jobProgressPct = Math.max(
    0,
    Math.min(100, Math.round(Number(currentJob?.progressPct || 0))),
  );

  if (!queueOp && !hasCurrentJob) return null;

  return (
    <section className="artist-section downloads-page__section">
      <h2 className="artist-section-title">Now</h2>
      <div className="downloads-page__now-panel">
        {queueOp ? (
          <div className="downloads-page__now-item">
            <div className="downloads-page__now-icon-wrap">
              <queueOp.icon className="downloads-page__now-icon" />
            </div>
            <div className="downloads-page__now-copy">
              <span className="downloads-page__now-label">{queueOp.verb}</span>
              <span className="downloads-page__now-title">
                {getPlaylistName(queueOp.targetId, flows, sharedPlaylists)}
              </span>
            </div>
            <Loader2 className="downloads-page__now-spinner animate-spin" />
          </div>
        ) : null}
        {hasCurrentJob ? (
          <div className="downloads-page__now-item downloads-page__now-item--download">
            <div className="downloads-page__now-icon-wrap downloads-page__now-icon-wrap--download">
              <Download className="downloads-page__now-icon" />
            </div>
            <div className="downloads-page__now-copy">
              <span className="downloads-page__now-label">
                {currentJob.artistName}
              </span>
              <span className="downloads-page__now-title">
                {currentJob.trackName}
              </span>
              <span className="downloads-page__now-playlist">
                {getPlaylistName(
                  currentJob.playlistType,
                  flows,
                  sharedPlaylists,
                )}
              </span>
              <div className="flow-page__progress downloads-page__now-progress">
                <div className="flow-page__progress-bar">
                  <div
                    className="flow-page__progress-fill"
                    style={{ width: `${jobProgressPct}%` }}
                  />
                </div>
                <span className="downloads-page__now-progress-label">
                  {jobProgressPct}%
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function QueueTrackRow({
  job,
  playlistName,
  currentJob,
  variant,
  onOpenPlaylist,
}) {
  const isActive =
    variant === "downloading" &&
    currentJob?.id === job.id;
  const progressPct = isActive
    ? Math.max(
        0,
        Math.min(100, Math.round(Number(currentJob?.progressPct || 0))),
      )
    : 0;

  let StatusIcon = Clock;
  let statusClass = "downloads-page__queue-status--pending";
  if (variant === "downloading") {
    StatusIcon = Download;
    statusClass = "downloads-page__queue-status--downloading";
  } else if (variant === "done") {
    StatusIcon = Check;
    statusClass = "downloads-page__queue-status--done";
  } else if (variant === "failed") {
    StatusIcon = AlertCircle;
    statusClass = "downloads-page__queue-status--failed";
  }

  const canOpenPlaylist =
    variant === "done" && job.playlistType && onOpenPlaylist;
  const rowClassName = `downloads-page__queue-row${
    isActive ? " downloads-page__queue-row--active" : ""
  }${canOpenPlaylist ? " downloads-page__queue-row--clickable" : ""}`;
  const rowContent = (
    <>
      <div className={`downloads-page__queue-status ${statusClass}`}>
        <StatusIcon className="downloads-page__queue-status-icon" />
      </div>
      <div className="downloads-page__queue-track">
        <span className="downloads-page__queue-artist">{job.artistName}</span>
        <span className="downloads-page__queue-title">{job.trackName}</span>
      </div>
      <span className="downloads-page__queue-playlist">{playlistName}</span>
      {isActive ? (
        <div className="downloads-page__queue-progress">
          <div className="flow-page__progress-bar">
            <div
              className="flow-page__progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="downloads-page__queue-progress-label">
            {progressPct}%
          </span>
        </div>
      ) : null}
    </>
  );

  if (canOpenPlaylist) {
    return (
      <button
        type="button"
        className={rowClassName}
        onClick={() => onOpenPlaylist(job.playlistType)}
        aria-label={`Open ${playlistName} playlist for ${job.trackName}`}
      >
        {rowContent}
      </button>
    );
  }

  return <div className={rowClassName}>{rowContent}</div>;
}

function TrackQueueSection({
  jobs,
  currentJob,
  flows,
  sharedPlaylists,
  onOpenPlaylist,
}) {
  const { downloading, pending, recent, failed } = useMemo(
    () => categorizeJobs(jobs),
    [jobs],
  );
  const activeCount = downloading.length + pending.length;
  const hasQueue = activeCount > 0 || recent.length > 0 || failed.length > 0;

  if (!hasQueue) {
    return (
      <section className="artist-section downloads-page__section">
        <h2 className="artist-section-title">Queue</h2>
        <div className="artist-empty-panel">
          <p className="artist-empty-message">
            No tracks in the download queue. Tracks appear here when a flow or
            playlist is being filled.
          </p>
        </div>
      </section>
    );
  }

  const renderRows = (items, variant) =>
    items.map((job) => (
      <QueueTrackRow
        key={job.id}
        job={job}
        variant={variant}
        currentJob={currentJob}
        playlistName={getPlaylistName(
          job.playlistType,
          flows,
          sharedPlaylists,
        )}
        onOpenPlaylist={variant === "done" ? onOpenPlaylist : null}
      />
    ));

  return (
    <>
      {activeCount > 0 ? (
        <section className="artist-section downloads-page__section">
          <div className="downloads-page__section-header">
            <h2 className="artist-section-title">Active</h2>
            <span className="artist-count">
              {downloading.length} downloading · {pending.length} queued
            </span>
          </div>
          <div className="downloads-page__queue">
            {renderRows(downloading, "downloading")}
            {renderRows(pending.slice(0, 40), "pending")}
            {pending.length > 40 ? (
              <p className="artist-subtext downloads-page__queue-overflow">
                +{pending.length - 40} more queued
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="artist-section downloads-page__section">
          <div className="downloads-page__section-header">
            <h2 className="artist-section-title">Recent</h2>
            <span className="artist-count">Last {recent.length} completed</span>
          </div>
          <div className="downloads-page__queue downloads-page__queue--recent">
            {renderRows(recent, "done")}
          </div>
        </section>
      ) : null}

      {failed.length > 0 ? (
        <section className="artist-section downloads-page__section">
          <div className="downloads-page__section-header">
            <h2 className="artist-section-title">Stalled</h2>
            <span className="artist-count">{failed.length} tracks</span>
          </div>
          <div className="downloads-page__queue downloads-page__queue--failed">
            {renderRows(failed.slice(0, 20), "failed")}
          </div>
        </section>
      ) : null}
    </>
  );
}

function DownloadsPage() {
  useDocumentTitle("Activity");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, loading, fetchStatus, sharedPlaylists, flows } =
    useFlowStatus();

  const [jobs, setJobs] = useState([]);
  const [isWorkerSettingsOpen, setIsWorkerSettingsOpen] = useState(false);
  const [workerSettingsDraft, setWorkerSettingsDraft] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [workerSettingsBaseline, setWorkerSettingsBaseline] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [savingWorkerSettings, setSavingWorkerSettings] = useState(false);
  const [rotatingSoulseekCredential, setRotatingSoulseekCredential] =
    useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      const data = await getFlowStatus({ includeJobs: true, jobsLimit: 200 });
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    const workerRunning = status?.worker?.running === true;
    const queueProcessing = status?.operationQueue?.processing === true;
    const activityStats = getCombinedActivityStats(status);
    const hasActive =
      activityStats.pending > 0 || activityStats.downloading > 0;
    if (!workerRunning && !queueProcessing && !hasActive) return;
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [status, fetchJobs]);

  const soulseekConnected = status?.soulseek?.connected === true;

  const handleOpenPlaylist = useCallback(
    (playlistId) => {
      if (!playlistId) return;
      navigate("/playlists", { state: { selectedPlaylistId: playlistId } });
    },
    [navigate],
  );

  const handleOpenWorkerSettings = () => {
    if (user?.role !== "admin") return;
    const current = getWorkerSettingsFromStatus(status);
    setWorkerSettingsBaseline(current);
    setWorkerSettingsDraft(current);
    setIsWorkerSettingsOpen(true);
  };

  const handleSaveWorkerSettings = async () => {
    const safeConcurrency = Math.min(
      3,
      Math.max(
        1,
        Math.floor(
          Number(workerSettingsDraft.concurrency) ||
            DEFAULT_WORKER_SETTINGS.concurrency,
        ),
      ),
    );
    const safePreferredFormat =
      workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac";
    const safePreferredFormatStrict =
      workerSettingsDraft.preferredFormatStrict === true;
    const safeRetryCycleMinutes = normalizeRetryCycleMinutes(
      workerSettingsDraft.retryCycleMinutes,
    );
    const safeExistingFileMode = normalizeExistingFileMode(
      workerSettingsDraft.existingFileMode,
    );
    const current = workerSettingsBaseline;
    const hasChanges =
      safeConcurrency !== current.concurrency ||
      safePreferredFormat !== current.preferredFormat ||
      safePreferredFormatStrict !== current.preferredFormatStrict ||
      safeRetryCycleMinutes !== current.retryCycleMinutes ||
      safeExistingFileMode !== current.existingFileMode;
    if (!hasChanges || savingWorkerSettings) return;
    setSavingWorkerSettings(true);
    try {
      await updateFlowWorkerSettings({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        retryCycleMinutes: safeRetryCycleMinutes,
        existingFileMode: safeExistingFileMode,
      });
      setWorkerSettingsBaseline({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        retryCycleMinutes: safeRetryCycleMinutes,
        existingFileMode: safeExistingFileMode,
      });
      showSuccess("Flow worker settings updated");
      setIsWorkerSettingsOpen(false);
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update flow worker settings",
      );
    } finally {
      setSavingWorkerSettings(false);
    }
  };

  const handleRotateSoulseekCredential = async () => {
    if (rotatingSoulseekCredential) return;
    setRotatingSoulseekCredential(true);
    try {
      const result = await rotateFlowWorkerSoulseekCredentials();
      showSuccess(
        result?.username
          ? `Rotated Soulseek account to ${result.username}`
          : "Rotated Soulseek credentials",
      );
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to rotate Soulseek credentials",
      );
    } finally {
      setRotatingSoulseekCredential(false);
    }
  };

  const currentWorkerSettings = workerSettingsBaseline;
  const hasWorkerSettingsChanges =
    Number(workerSettingsDraft.concurrency) !==
      currentWorkerSettings.concurrency ||
    (workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac") !==
      currentWorkerSettings.preferredFormat ||
    (workerSettingsDraft.preferredFormatStrict === true) !==
      currentWorkerSettings.preferredFormatStrict ||
    normalizeRetryCycleMinutes(workerSettingsDraft.retryCycleMinutes) !==
      currentWorkerSettings.retryCycleMinutes ||
    normalizeExistingFileMode(workerSettingsDraft.existingFileMode) !==
      currentWorkerSettings.existingFileMode;

  if (loading && !status) {
    return (
      <div className="downloads-page">
        <header className="downloads-page__header">
          <h1 className="downloads-page__title">Activity</h1>
          <p className="downloads-page__subtitle">
            Background worker status for playlist generation and track
            downloads.
          </p>
        </header>
        <div className="artist-loading">
          <Loader2 className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="downloads-page">
      <header className="downloads-page__header">
        <div className="downloads-page__header-copy">
          <h1 className="downloads-page__title">Activity</h1>
          <p className="downloads-page__subtitle">
            Background worker status for playlist generation and track
            downloads.
          </p>
        </div>
        {user?.role === "admin" ? (
          <div className="downloads-page__header-actions">
            <button
              type="button"
              onClick={handleOpenWorkerSettings}
              className="btn btn-secondary btn-sm"
            >
              <Settings className="artist-icon-xs" />
              Worker settings
            </button>
          </div>
        ) : null}
      </header>

      <WorkerStatusBar
        status={status}
        soulseekConnected={soulseekConnected}
      />

      <NowPanel status={status} flows={flows} sharedPlaylists={sharedPlaylists} />

      <TrackQueueSection
        jobs={jobs}
        currentJob={status?.worker?.currentJob}
        flows={flows}
        sharedPlaylists={sharedPlaylists}
        onOpenPlaylist={handleOpenPlaylist}
      />

      {user?.role === "admin" && (
        <FlowWorkerSettingsModal
          isOpen={isWorkerSettingsOpen}
          settings={workerSettingsDraft}
          soulseekCredential={status?.soulseek?.credential || null}
          hasChanges={hasWorkerSettingsChanges}
          saving={savingWorkerSettings}
          rotatingSoulseekCredential={rotatingSoulseekCredential}
          onCancel={() => {
            if (savingWorkerSettings || rotatingSoulseekCredential) return;
            setIsWorkerSettingsOpen(false);
          }}
          onChange={setWorkerSettingsDraft}
          onRotateSoulseekCredential={handleRotateSoulseekCredential}
          onSave={handleSaveWorkerSettings}
        />
      )}
    </div>
  );
}

export default DownloadsPage;
