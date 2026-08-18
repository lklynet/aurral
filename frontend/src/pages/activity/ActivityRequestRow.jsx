import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Info,
  Loader,
  Pause,
  Play,
  RotateCcw,
  XCircle,
} from "lucide-react";
import TooltipButton from "../../components/TooltipButton";
import { formatReviewReasonSummary, formatTimelineTime } from "./activityListUtils";

function getStatusMeta(request) {
  if (request.status === "completed" || request.status === "available") {
    return { icon: CheckCircle2, label: request.statusLabel || "Done", tone: "success" };
  }
  if (request.status === "failed") {
    return { icon: AlertCircle, label: request.statusLabel || "Failed", tone: "failed" };
  }
  if (request.status === "blocked") {
    return { icon: Eye, label: request.statusLabel || "Needs review", tone: "review" };
  }
  if (request.status === "processing" || request.status === "pending") {
    return {
      icon: Loader,
      label: request.statusLabel || "In progress",
      tone: "active",
      spinning: true,
    };
  }
  return { icon: Clock, label: request.statusLabel || "Requested", tone: "pending" };
}

function getRequestTitle(request) {
  return (
    String(request.trackName || "").trim() ||
    String(request.albumName || "").trim() ||
    String(request.name || "").trim() ||
    String(request.title || "").trim() ||
    "Activity"
  );
}

function getRequestMeta(request, title) {
  const artist = String(request.artistName || "").trim();
  const album = String(request.albumName || "").trim();
  const isTrack = Boolean(request.trackName);
  const values = [artist, isTrack && album !== title ? album : null].filter(Boolean);
  return values.join(" · ") || String(request.subtitle || "").trim() || "Aurral activity";
}

export default function ActivityRequestRow({
  request,
  reSearchingAlbumIds,
  approvingJobId,
  denyingJobId,
  jobErrors,
  currentTrack,
  isPlaying,
  onNavigate,
  onReSearch,
  onApprove,
  onDeny,
  onPreview,
  onInfo,
}) {
  const isSlskd = request.source === "slskd";
  const isUsenet = request.source === "nzbget" || request.source === "sabnzbd";
  const isYtdlp = request.source === "ytdlp";
  const isTrackDownload =
    isSlskd || isUsenet || isYtdlp || request.kind === "track_download";
  const isAurral = request.source === "aurral" && !isTrackDownload;
  const isActivity = request.type === "activity";
  const isAlbum = request.type === "album";
  const isBlockedTrack =
    request.kind === "track_download" && request.status === "blocked" && !!request.jobId;
  const trackName =
    String(request.trackName || "").trim() ||
    request.title?.replace(/^Review needed for /, "") ||
    "track";
  const displayTitle = getRequestTitle(request);
  const displayMeta = getRequestMeta(request, displayTitle);
  const artistMbid = isAlbum ? request.artistMbid : request.mbid;
  const canNavigate =
    ((isSlskd || isUsenet || isYtdlp) && request.playlistId) ||
    ((isAurral || isActivity) && request.href) ||
    (artistMbid && artistMbid !== "null" && artistMbid !== "undefined");
  const status = getStatusMeta(request);
  const StatusIcon = status.icon;
  const timelineTime = formatTimelineTime(request.requestedAt);
  const canReSearch =
    request.canReSearch === true && request.albumId && !reSearchingAlbumIds[request.albumId];
  const isReSearching = Boolean(request.albumId && reSearchingAlbumIds[request.albumId]);
  const isApproving = approvingJobId === request.jobId;
  const isDenying = denyingJobId === request.jobId;
  const isThisPlaying = currentTrack?.id === String(request.jobId) && isPlaying;
  const jobError = jobErrors[request.jobId];
  const reviewReasonSummary = isBlockedTrack
    ? formatReviewReasonSummary(request.subtitle)
    : null;
  const rowLabel = `${displayTitle}${displayMeta ? `, ${displayMeta}` : ""}`;

  const navigate = () => {
    if (!canNavigate) return;
    onNavigate(request, {
      isSlskd,
      isUsenet,
      isAurral,
      isAlbum,
      artistMbid,
      artistName: request.artistName || null,
      displayName: displayTitle,
    });
  };

  return (
    <article
      className={`activity-row${canNavigate ? " is-clickable" : ""}`}
      onClick={navigate}
      onKeyDown={(event) => {
        if (canNavigate && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          navigate();
        }
      }}
      tabIndex={canNavigate ? 0 : undefined}
      aria-label={canNavigate ? `Open ${rowLabel}` : undefined}
    >
      <span
        className={`activity-row__status activity-row__status--${status.tone}`}
        title={status.label}
        aria-label={status.label}
      >
        <StatusIcon className={status.spinning ? "animate-spin" : ""} aria-hidden="true" />
      </span>
      <div className="activity-row__details">
        <h2 className="activity-row__title" title={displayTitle}>
          {displayTitle}
        </h2>
        <p className="activity-row__meta" title={displayMeta}>
          {displayMeta}
        </p>
        {reviewReasonSummary ? (
          <p className="activity-row__hint" title={request.subtitle || reviewReasonSummary}>
            {reviewReasonSummary}
          </p>
        ) : null}
        {request.sourceFilename ? (
          <p className="activity-row__hint" title={request.sourceFilename}>
            {request.sourceFilename}
          </p>
        ) : null}
      </div>
      <span className="activity-row__status-label">{status.label}</span>
      <time className="activity-row__time" dateTime={request.requestedAt || undefined}>
        {timelineTime}
      </time>
      <div className="activity-row__actions" onClick={(event) => event.stopPropagation()}>
        {isBlockedTrack ? (
          <>
            <TooltipButton
              className="native-library-icon-button"
              onClick={() => onPreview(request.jobId, trackName, request.artistName)}
              label={isThisPlaying ? "Pause preview" : "Preview track"}
            >
              {isThisPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="native-library-icon-button"
              onClick={() => onApprove(request.jobId)}
              disabled={isApproving || isDenying}
              label="Approve track"
            >
              {isApproving ? <Loader className="animate-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="native-library-icon-button"
              onClick={() => onDeny(request.jobId)}
              disabled={isApproving || isDenying}
              label="Deny track"
            >
              {isDenying ? <Loader className="animate-spin" aria-hidden="true" /> : <XCircle aria-hidden="true" />}
            </TooltipButton>
          </>
        ) : null}
        {jobError ? <span className="activity-row__error" role="alert">{jobError}</span> : null}
        {canReSearch ? (
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => onReSearch(request)}
            disabled={isReSearching}
            label={isReSearching ? "Re-searching" : "Re-search"}
          >
            <RotateCcw className={isReSearching ? "animate-spin" : ""} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        <TooltipButton
          className="native-library-icon-button"
          onClick={() => onInfo?.(request)}
          label={`Show ${displayTitle} details`}
        >
          <Info aria-hidden="true" />
        </TooltipButton>
      </div>
    </article>
  );
}
