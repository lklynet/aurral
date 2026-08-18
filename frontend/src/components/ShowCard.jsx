import { memo } from "react";
import { Clock, MapPin, Music } from "lucide-react";
import { formatDate, formatTime } from "../utils/dateTime.js";

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
  return formatTime(parsed, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatShowDate = (show) => {
  if (!show?.date && !show?.dateTime) return null;
  const parsed = parseShowDate(show.date) || parseShowDate(show.dateTime);
  if (!parsed) return show.date || null;
  const dateLabel = formatDate(parsed, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = formatShowTime(show.time);
  return timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

const formatDistance = (distance) => {
  if (distance == null || distance === "") return null;
  const numericDistance = Number(distance);
  return Number.isFinite(numericDistance) ? `${Math.round(numericDistance)} mi` : null;
};

const getEventUrl = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
};

function ShowMeta({ showDate, showLocation, className }) {
  return (
    <div className={className}>
      {showDate && (
        <p className="artist-show-card__detail--discover">
          <Clock className="artist-show-card__detail-icon--discover" aria-hidden="true" />
          <span className="artist-show-card__detail-text--discover">{showDate}</span>
        </p>
      )}
      {showLocation && (
        <p className="artist-show-card__detail--discover artist-show-card__detail--discover-location">
          <MapPin
            className="artist-show-card__detail-icon--discover artist-show-card__detail-icon--discover-location"
            aria-hidden="true"
          />
          <span className="artist-show-card__detail-text--discover">{showLocation}</span>
        </p>
      )}
    </div>
  );
}

const ShowCard = memo(({ show }) => {
  const artistNames = (Array.isArray(show.artistNames) ? show.artistNames : [show.artistName])
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim());
  const artistLabel = artistNames.join(", ") || "Matched artist";
  const eventLabel = show.eventName || artistLabel || "Upcoming show";
  const eventUrl = getEventUrl(show.url);
  const distanceLabel = formatDistance(show.distance);
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);
  const Tag = eventUrl ? "a" : "article";
  const linkProps = eventUrl
    ? {
        href: eventUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `Open tickets for ${eventLabel}`,
      }
    : {};

  return (
    <Tag
      {...linkProps}
      className={`artist-show-card--discover${eventUrl ? "" : " is-disabled"}`}
    >
      <div className="artist-show-card__image-wrap--discover">
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
        <div className="artist-show-card__image--discover-overlay" />
        {distanceLabel && (
          <div className="artist-show-card__distance--discover">
            <span className="artist-show-card__distance-badge--discover">{distanceLabel}</span>
          </div>
        )}
        <div className="artist-show-card__image--discover-content">
          <div />
          <div className="artist-show-card__image--discover-bottom">
            <p className="artist-show-card__artist--discover artist-truncate">{artistLabel}</p>
            <h3 className="artist-show-card__title--discover artist-truncate">{eventLabel}</h3>
            <ShowMeta
              showDate={showDate}
              showLocation={showLocation}
              className="artist-show-card__details--discover"
            />
          </div>
        </div>
      </div>
      <div className="artist-show-card__body--discover">
        <div className="artist-show-card__body-heading">
          <p className="artist-show-card__body-artist--discover artist-truncate">{artistLabel}</p>
          <h3 className="artist-show-card__body-title--discover">
            <span
              className="artist-show-card__body-title-text--discover artist-truncate"
              title={eventLabel}
            >
              {eventLabel}
            </span>
          </h3>
        </div>
        <ShowMeta
          showDate={showDate}
          showLocation={showLocation}
          className="artist-show-card__body-details--discover"
        />
      </div>
    </Tag>
  );
});

ShowCard.displayName = "ShowCard";

export default ShowCard;
