import { useId, useState } from "react";
import { Check, ChevronDown, ChevronRight, Info } from "../../components/icons";
import RouteLink from "../../components/RouteLink";
import Tooltip from "../../components/Tooltip";
import TooltipButton from "../../components/TooltipButton";
import {
  ActivityRowActions,
  ActivityStatusIcon,
  getRequestTitle,
  getStatusMeta,
  isBlockedTrack,
  type ActivityRowActionProps,
} from "./ActivityRequestRow";
import {
  downloadClientLabel,
  formatReviewReasonSummary,
  formatTimelineTime,
  type ActivityRequest,
  type AlbumActivityRequest,
} from "./activityListUtils";

type ActivityAlbumRowProps = ActivityRowActionProps & { request: AlbumActivityRequest };

function AlbumTrack({
  track,
  number,
  jobErrors,
  ...actions
}: ActivityRowActionProps & { track: ActivityRequest; number: string }) {
  const status = getStatusMeta(track);
  const done = status.tone === "success";
  const reviewReason = isBlockedTrack(track) ? formatReviewReasonSummary(track.subtitle) : null;
  const jobError = track.jobId ? jobErrors[track.jobId] : undefined;
  return (
    <article className="activity-row activity-album-track">
      <span className="activity-row__status activity-album-track__number">{number}</span>
      <div className="activity-row__details">
        <p className="activity-album-track__title">{getRequestTitle(track)}</p>
        {reviewReason ? (
          <Tooltip content={track.subtitle || reviewReason}>
            <p className="activity-row__hint">{reviewReason}</p>
          </Tooltip>
        ) : null}
        {jobError ? (
          <span className="activity-row__error" role="alert">
            {jobError}
          </span>
        ) : null}
      </div>
      <span className={`activity-row__status-label activity-row__status-label--${status.tone}`}>
        {done ? <Check role="img" aria-label={status.label} /> : status.label}
      </span>
      <ActivityRowActions request={track} {...actions} />
    </article>
  );
}

export default function ActivityAlbumRow({ request, ...actions }: ActivityAlbumRowProps) {
  const [expanded, setExpanded] = useState(false);
  const tracksId = useId();
  const status = getStatusMeta(request);
  const title = getRequestTitle(request);
  const total = request.albumGrab.memberJobIds.length;
  const missing = Math.max(0, total - request.children.length);
  const complete = request.status === "completed";
  const meta = [request.artistName, "Album", complete ? `${total} tracks` : request.progressLabel]
    .filter(Boolean)
    .join(" · ");
  const client = downloadClientLabel(request);
  const timelineAt = request.completedAt || request.requestedAt;
  const multiDisc = request.children.some((track) => Number(track.discNumber || 1) > 1);
  const { onInfo } = actions;
  const toggle = () => setExpanded((value) => !value);

  return (
    <section className="activity-album" aria-label={`${title}, ${request.artistName}`}>
      <article
        className="activity-row"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a, button")) return;
          toggle();
        }}
      >
        <ActivityStatusIcon request={request} />
        <div className="activity-row__details">
          <h2 className="activity-row__title">
            {request.href ? (
              <Tooltip content={title}>
                <RouteLink to={request.href} className="activity-row__title-button">
                  {title}
                </RouteLink>
              </Tooltip>
            ) : (
              title
            )}
          </h2>
          <Tooltip content={meta}>
            <p className="activity-row__meta">{meta}</p>
          </Tooltip>
          {complete ? null : (
            <span className="activity-album__progress" aria-hidden="true">
              {request.children.map((track) => (
                <span
                  key={track.id}
                  className={`activity-album__segment activity-album__segment--${getStatusMeta(track).tone}`}
                />
              ))}
              {Array.from({ length: missing }, (_, index) => (
                <span key={`missing-${index}`} className="activity-album__segment" />
              ))}
            </span>
          )}
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
        <div className="activity-row__actions">
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => onInfo?.(request)}
            label={`Show ${title} details`}
          >
            <Info aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            className="native-library-icon-button"
            onClick={toggle}
            label={expanded ? "Hide tracks" : "Show tracks"}
            aria-expanded={expanded}
            aria-controls={tracksId}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </TooltipButton>
        </div>
      </article>
      {expanded ? (
        <div id={tracksId} className="activity-album__tracks" role="group" aria-label="Tracks">
          {request.albumGrab.fallbackReason ? (
            <p className="activity-album__notice">{request.albumGrab.fallbackReason}</p>
          ) : null}
          {request.children.map((track, index) => {
            const trackNumber = String(track.trackNumber || index + 1);
            return (
              <AlbumTrack
                key={track.id}
                track={track}
                number={multiDisc ? `${track.discNumber || 1}-${trackNumber}` : trackNumber}
                {...actions}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
