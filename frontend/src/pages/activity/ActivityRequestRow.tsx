import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Info,
  Pause,
  Play,
  RotateCcw,
  X,
  XCircle,
} from "../../components/icons";
import TooltipButton from "../../components/TooltipButton";
import { DotLoader } from "../../components/DotLoader";
import { isCancelableDownload, type ActivityRequest } from "../../../../lib/activity.ts";
import {
  describeRequestCause,
  downloadClientLabel,
  formatReviewReasonSummary,
  formatTimelineTime,
} from "./activityListUtils";
import Tooltip from "../../components/Tooltip";
import RouteLink from "../../components/RouteLink";
import type { QueueEntry } from "../../utils/audioQueue.ts";

export type ActivityRowActionProps = {
  reviewingJobs: Record<string, "approve" | "deny">;
  controllingJobs: Record<string, "cancel" | "retry">;
  jobErrors: Record<string, string>;
  currentTrack: QueueEntry | null;
  isPlaying: boolean;
  onApprove: (jobId: string | null | undefined) => void;
  onDeny: (jobId: string | null | undefined) => void;
  onCancel: (jobId: string | null | undefined) => void;
  onRetry: (jobId: string | null | undefined) => void;
  onPreview: (request: ActivityRequest) => void;
  onInfo?: (request: ActivityRequest) => void;
};

export function getStatusMeta(request: ActivityRequest) {
  if (request.status === "completed" || request.status === "available") {
    return { icon: CheckCircle2, label: request.statusLabel || "Done", tone: "success" };
  }
  if (request.status === "unchanged") {
    return { icon: CheckCircle2, label: request.statusLabel || "Unchanged", tone: "muted" };
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
  if (request.status === "processing") {
    return { icon: null, label: request.statusLabel || "In progress", tone: "active" };
  }
  return { icon: Clock, label: request.statusLabel || "Requested", tone: "pending" };
}

export function getRequestTitle(request: ActivityRequest) {
  return (
    String(request.trackName || "").trim() ||
    String(request.albumName || "").trim() ||
    String(request.title || "").trim() ||
    "Activity"
  );
}

function getRequestMeta(request: ActivityRequest, title: string) {
  const artist = String(request.artistName || "").trim();
  const album = String(request.albumName || "").trim();
  const isTrack = Boolean(request.trackName);
  const values = [
    artist,
    describeRequestCause(request) ?? (isTrack && album !== title ? album : null),
  ].filter(Boolean);
  return values.join(" · ") || String(request.subtitle || "").trim() || "Aurral activity";
}

export const isBlockedTrack = (request: ActivityRequest) =>
  request.kind === "track_download" && request.status === "blocked" && !!request.jobId;

export function ActivityStatusIcon({ request }: { request: ActivityRequest }) {
  const status = getStatusMeta(request);
  const StatusIcon = status.icon;
  return (
    <Tooltip content={status.label}>
      <span
        className={`activity-row__status activity-row__status--${status.tone}`}
        aria-label={status.label}
      >
        {StatusIcon ? <StatusIcon aria-hidden="true" /> : <DotLoader size="sm" label={null} />}
      </span>
    </Tooltip>
  );
}

export function ActivityRowActions({
  request,
  reviewingJobs,
  controllingJobs,
  currentTrack,
  isPlaying,
  onApprove,
  onDeny,
  onCancel,
  onRetry,
  onPreview,
  onInfo,
}: Omit<ActivityRowActionProps, "jobErrors"> & { request: ActivityRequest }) {
  const blocked = isBlockedTrack(request);
  const trackName =
    String(request.trackName || "").trim() ||
    request.title?.replace(/^Review needed for /, "") ||
    "track";
  const reviewingJob = request.jobId ? reviewingJobs[request.jobId] : undefined;
  const isApproving = reviewingJob === "approve";
  const isDenying = reviewingJob === "deny";
  const activeControl = request.jobId ? controllingJobs[request.jobId] : undefined;
  const canCancel = isCancelableDownload(request);
  const canRetry =
    request.kind === "track_download" &&
    !!request.jobId &&
    ["pending", "processing", "failed", "cancelled"].includes(request.status) &&
    !blocked;
  const isThisPlaying = currentTrack?.id === String(request.jobId) && isPlaying;

  return (
    <div className="activity-row__actions">
      {blocked ? (
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
            {isApproving ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
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
      {canCancel ? (
        <TooltipButton
          className="native-library-icon-button activity-row__action--cancel"
          onClick={() => onCancel(request.jobId)}
          disabled={Boolean(activeControl)}
          aria-busy={activeControl === "cancel"}
          label={activeControl === "cancel" ? "Cancelling download" : "Cancel download"}
        >
          {activeControl === "cancel" ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <X aria-hidden="true" />
          )}
        </TooltipButton>
      ) : null}
      {canRetry ? (
        <TooltipButton
          className="native-library-icon-button"
          onClick={() => onRetry(request.jobId)}
          disabled={Boolean(activeControl)}
          aria-busy={activeControl === "retry"}
          label={
            activeControl === "retry"
              ? "Restarting download"
              : canCancel
                ? "Restart download"
                : "Retry download"
          }
        >
          {activeControl === "retry" ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <RotateCcw aria-hidden="true" />
          )}
        </TooltipButton>
      ) : null}
      <TooltipButton
        className="native-library-icon-button"
        onClick={() => onInfo?.(request)}
        label={`Show ${getRequestTitle(request)} details`}
      >
        <Info aria-hidden="true" />
      </TooltipButton>
    </div>
  );
}

export default function ActivityRequestRow({
  request,
  jobErrors,
  ...actions
}: ActivityRowActionProps & { request: ActivityRequest }) {
  const blocked = isBlockedTrack(request);
  const displayTitle = getRequestTitle(request);
  const displayMeta = getRequestMeta(request, displayTitle);
  const status = getStatusMeta(request);
  const timelineAt = request.completedAt || request.requestedAt;
  const jobError = request.jobId ? jobErrors[request.jobId] : undefined;
  const reviewReasonSummary = blocked ? formatReviewReasonSummary(request.subtitle) : null;
  const rowLabel = `${displayTitle}${displayMeta ? `, ${displayMeta}` : ""}`;
  const client = downloadClientLabel(request);

  return (
    <article className="activity-row">
      <ActivityStatusIcon request={request} />
      <div className="activity-row__details">
        <h2 className="activity-row__title">
          {request.href ? (
            <Tooltip content={displayTitle}>
              <RouteLink
                to={request.href}
                className="activity-row__title-button"
                aria-label={`Open ${rowLabel}`}
              >
                {displayTitle}
              </RouteLink>
            </Tooltip>
          ) : (
            displayTitle
          )}
        </h2>
        <Tooltip content={displayMeta}>
          <p className="activity-row__meta">{displayMeta}</p>
        </Tooltip>
        {reviewReasonSummary ? (
          <Tooltip content={request.subtitle || reviewReasonSummary}>
            <p className="activity-row__hint">{reviewReasonSummary}</p>
          </Tooltip>
        ) : null}
        {request.sourceFilename ? (
          <Tooltip content={request.sourceFilename}>
            <p className="activity-row__hint">{request.sourceFilename}</p>
          </Tooltip>
        ) : null}
        {jobError ? (
          <span className="activity-row__error" role="alert">
            {jobError}
          </span>
        ) : null}
      </div>
      {client ? (
        <Tooltip content={client}>
          <span className="activity-row__client">{client}</span>
        </Tooltip>
      ) : null}
      <span className={`activity-row__status-label activity-row__status-label--${status.tone}`}>
        {status.label}
      </span>
      <time className="activity-row__time" dateTime={timelineAt || undefined}>
        {formatTimelineTime(timelineAt)}
      </time>
      <ActivityRowActions request={request} {...actions} />
    </article>
  );
}
