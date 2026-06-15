import { memo } from "react";
import PropTypes from "prop-types";
import { Clock, MapPin, Music } from "lucide-react";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const parseShowDate = (value) => {
  if (!value) return null;
  const raw = String(value);
  const dateOnlyMatch = raw.match(DATE_ONLY_PATTERN);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatShowTime = (value) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return value;
  const [, hour, minute] = match;
  const parsed = new Date(2000, 0, 1, Number(hour), Number(minute));
  return parsed.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatShowDate = (show) => {
  if (!show?.date && !show?.dateTime) return null;
  const parsed = parseShowDate(show.date) || parseShowDate(show.dateTime);
  if (!parsed) {
    return show.date || null;
  }
  const dateLabel = parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = formatShowTime(show.time);
  if (timeLabel) {
    return `${dateLabel} at ${timeLabel}`;
  }
  return dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

const formatDistance = (distance) => {
  if (distance == null || distance === "") return null;
  const numericDistance = Number(distance);
  return Number.isFinite(numericDistance)
    ? `${Math.round(numericDistance)} mi`
    : null;
};

const getEventUrl = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : "";
  } catch {
    return "";
  }
};

function ShowImage({
  show,
  eventLabel,
  distanceLabel,
  variant,
  overlay = false,
  children = null,
}) {
  return (
    <div
      className={`artist-show-card__image-wrap--discover artist-show-card__image-wrap--discover-${variant}`}
    >
      {show.image ? (
        <img
          src={show.image}
          alt={eventLabel}
          className="artist-show-card__image--discover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="artist-media-placeholder--discover">
          <Music className="artist-media-placeholder--discover-icon" />
        </div>
      )}
      {overlay && <div className="artist-show-card__image--discover-overlay" />}
      {distanceLabel && (
        <div className="artist-show-card__distance--discover">
          <span className="artist-show-card__distance-badge--discover">
            {distanceLabel}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

function ShowMetaDetails({ showDate, showLocation, variant }) {
  const baseClass =
    variant === "body"
      ? "artist-show-card__body-detail--discover"
      : "artist-show-card__detail--discover";
  const iconClass =
    variant === "body"
      ? "artist-show-card__body-detail-icon--discover"
      : "artist-show-card__detail-icon--discover";
  const textClass =
    variant === "body"
      ? "artist-truncate"
      : "artist-show-card__detail-text--discover";

  return (
    <>
      {showDate && (
        <p className={baseClass}>
          <Clock className={iconClass} aria-hidden="true" />
          <span className={textClass}>{showDate}</span>
        </p>
      )}
      {showLocation && (
        <p className={`${baseClass} ${baseClass}-location`}>
          <MapPin
            className={`${iconClass} ${iconClass}-location`}
            aria-hidden="true"
          />
          <span
            className={
              variant === "body"
                ? "artist-clamp-2"
                : "artist-show-card__detail-text--discover"
            }
          >
            {showLocation}
          </span>
        </p>
      )}
    </>
  );
}

const ShowCard = memo(({ show }) => {
  const artistLabel = show.artistName || "Matched artist";
  const eventLabel = show.eventName || artistLabel || "Upcoming show";
  const eventUrl = getEventUrl(show.url);
  const distanceLabel = formatDistance(show.distance);
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);

  const mobileContent = (
    <ShowImage
      show={show}
      eventLabel={eventLabel}
      distanceLabel={distanceLabel}
      variant="mobile"
      overlay
    >
      <div className="artist-show-card__image--discover-content">
        <div />
        <div className="artist-show-card__image--discover-bottom">
          <p className="artist-show-card__artist--discover artist-truncate">
            {artistLabel}
          </p>
          <h3 className="artist-show-card__title--discover artist-truncate">
            {eventLabel}
          </h3>
          <div className="artist-show-card__details--discover">
            <ShowMetaDetails
              showDate={showDate}
              showLocation={showLocation}
              variant="image"
            />
          </div>
        </div>
      </div>
    </ShowImage>
  );

  return (
    <>
      {eventUrl ? (
        <a
          href={eventUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="artist-show-card--discover-mobile"
          aria-label={`Open tickets for ${eventLabel}`}
        >
          {mobileContent}
        </a>
      ) : (
        <article className="artist-show-card--discover-mobile is-disabled">
          {mobileContent}
        </article>
      )}

      <article
        className={`artist-show-card--discover-desktop${eventUrl ? "" : " is-disabled"}`}
      >
        {eventUrl ? (
          <a
            href={eventUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="artist-show-card__image-link--discover"
            aria-label={`Open tickets for ${eventLabel}`}
          >
            <ShowImage
              show={show}
              eventLabel={eventLabel}
              distanceLabel={distanceLabel}
              variant="desktop"
            />
          </a>
        ) : (
          <ShowImage
            show={show}
            eventLabel={eventLabel}
            distanceLabel={distanceLabel}
            variant="desktop"
          />
        )}
        <div className="artist-show-card__body--discover">
          <div className="artist-show-card__body-heading">
            <p className="artist-show-card__body-artist--discover artist-truncate">
              {artistLabel}
            </p>
            <h3 className="artist-show-card__body-title--discover">
              {eventUrl ? (
                <a
                  href={eventUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="artist-show-card__body-title-link--discover artist-truncate"
                  title={eventLabel}
                >
                  {eventLabel}
                </a>
              ) : (
                <span
                  className="artist-show-card__body-title-text--discover artist-truncate"
                  title={eventLabel}
                >
                  {eventLabel}
                </span>
              )}
            </h3>
          </div>
          <div className="artist-show-card__body-details--discover">
            <ShowMetaDetails
              showDate={showDate}
              showLocation={showLocation}
              variant="body"
            />
          </div>
        </div>
      </article>
    </>
  );
});

ShowCard.displayName = "ShowCard";

ShowCard.propTypes = {
  show: PropTypes.shape({
    id: PropTypes.string,
    artistName: PropTypes.string,
    matchType: PropTypes.string,
    sourceType: PropTypes.string,
    eventName: PropTypes.string,
    image: PropTypes.string,
    url: PropTypes.string,
    date: PropTypes.string,
    time: PropTypes.string,
    dateTime: PropTypes.string,
    venueName: PropTypes.string,
    city: PropTypes.string,
    region: PropTypes.string,
    distance: PropTypes.number,
  }).isRequired,
};

export default ShowCard;
