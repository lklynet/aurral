import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Info,
  Pause,
  Play,
  RotateCcw,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import TooltipButton from "../../components/TooltipButton";
import { DotLoader } from "../../components/DotLoader";
import { formatReviewReasonSummary, formatTimelineTime } from "./activityListUtils";
import Tooltip from "../../components/Tooltip";

function getStatusMeta(request) {
  if (request.status === "completed" || request.status === "available") {
    return { icon: CheckCircle2, label: request.statusLabel || "Done", tone: "success" };
  }
  if (request.status === "failed") {
    return { icon: AlertCircle, label: request.statusLabel || "Failed", tone: "failed" };
  }
  if (request.status === "cancelled") {
    return { icon: XCircle, label: request.statusLabel || "Cancelled", tone: "pending" };
  }
  if (request.status === "blocked") {
    return { icon: Eye, label: request.statusLabel || "Needs review", tone: "review" };
  }
  if (request.status === "processing" || request.status === "pending") {
    return {
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
  reviewingJobs,
  jobErrors,
  currentTrack,
  isPlaying,
  onNavigate,
  onReSearch,
  onApprove,
  onDeny,
  onPreview,
  onInfo,
  onToggle,
  expanded,
  tracksId,
}) {
  const isSlskd = request.source === "slskd";
  const isUsenet = request.source === "nzbget" || request.source === "sabnzbd";
  const isYtdlp = request.source === "ytdlp";
  const isDeemix = request.source === "deemix";
  const isTrackDownload =
    isSlskd || isUsenet || isYtdlp || isDeemix || request.kind === "track_download";
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
    ((isSlskd || isUsenet || isYtdlp || isDeemix) && request.playlistId) ||
    ((isAurral || isActivity) && request.href) ||
    (artistMbid && artistMbid !== "null" && artistMbid !== "undefined");
  const status = getStatusMeta(request);
  const StatusIcon = status.icon;
  const timelineAt = request.completedAt || request.requestedAt;
  const timelineTime = formatTimelineTime(timelineAt);
  const canReSearch =
    Boolean(onReSearch) &&
    request.canReSearch === true &&
    request.albumId &&
    !reSearchingAlbumIds[request.albumId];
  const isReSearching = Boolean(request.albumId && reSearchingAlbumIds[request.albumId]);
  const isApproving = reviewingJobs[request.jobId] === "approve";
  const isDenying = reviewingJobs[request.jobId] === "deny";
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
    <article className="activity-row">
      <Tooltip content={status.label}>
        <span
          className={`activity-row__status activity-row__status--${status.tone}`}
          aria-label={status.label}
        >
          {status.spinning ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <StatusIcon aria-hidden="true" />
          )}
        </span>
      </Tooltip>
      <div className="activity-row__details">
        <h2 className="activity-row__title">
          {onToggle ? (
            <button
              type="button"
              className="activity-row__title-button activity-album__toggle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${displayTitle}`}
              aria-expanded={expanded}
              aria-controls={tracksId}
              onClick={onToggle}
            >
              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              <span>{displayTitle}</span>
            </button>
          ) : canNavigate ? (
            <Tooltip content={displayTitle}>
              <button
                type="button"
                className="activity-row__title-button"
                aria-label={`Open ${rowLabel}`}
                onClick={navigate}
              >
                {displayTitle}
              </button>
            </Tooltip>
          ) : (
            displayTitle
          )}
        </h2>
        <Tooltip content={displayMeta}>
          <p className="activity-row__meta" >
            {displayMeta}
          </p>
        </Tooltip>
        {request.progressLabel ? (
          <p className="activity-row__hint">
            {request.statusLabel} · {request.progressLabel}
            {request.activeStatusLabel ? ` · ${request.activeStatusLabel}` : ""}
          </p>
        ) : null}
        {request.albumGrab && request.kind === "track_download" && !isBlockedTrack ? (
          <p className="activity-row__hint">{request.statusLabel}</p>
        ) : null}
        {reviewReasonSummary ? (
          <Tooltip content={request.subtitle || reviewReasonSummary}>
            <p className="activity-row__hint" >
              {reviewReasonSummary}
            </p>
          </Tooltip>
        ) : null}
        {request.sourceFilename ? (
          <Tooltip content={request.sourceFilename}>
            <p className="activity-row__hint" >
              {request.sourceFilename}
            </p>
          </Tooltip>
        ) : null}
        {jobError ? <span className="activity-row__error" role="alert">{jobError}</span> : null}
      </div>
      <span className={`activity-row__status-label activity-row__status-label--${status.tone}`}>
        {status.label}
      </span>
      <time className="activity-row__time" dateTime={timelineAt || undefined}>
        {timelineTime}
      </time>
      <div className="activity-row__actions" onClick={(event) => event.stopPropagation()}>
        {isBlockedTrack ? (
          <>
            <TooltipButton
              className="native-library-icon-button"
              onClick={() => onPreview({ ...request, trackName })}
              label={isThisPlaying ? "Pause preview" : "Preview track"}
            >
              {isThisPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="native-library-icon-button activity-row__action--approve"
              onClick={() => onApprove(request.jobId)}
              disabled={isApproving || isDenying}
              aria-busy={isApproving}
              label="Approve track"
            >
              {isApproving ? <DotLoader size="sm" label={null} /> : <CheckCircle2 aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="native-library-icon-button activity-row__action--deny"
              onClick={() => onDeny(request.jobId)}
              disabled={isApproving || isDenying}
              aria-busy={isDenying}
              label="Deny track"
            >
              {isDenying ? <DotLoader size="sm" label={null} /> : <XCircle aria-hidden="true" />}
            </TooltipButton>
          </>
        ) : null}
        {canReSearch ? (
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => onReSearch(request)}
            disabled={isReSearching}
            label={isReSearching ? "Re-searching" : "Re-search"}
          >
            {isReSearching ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
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
