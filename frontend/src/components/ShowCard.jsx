import { memo } from "react";
import PropTypes from "prop-types";
import { Clock, MapPin, Music } from "lucide-react";

const formatShowDate = (show) => {
  if (!show?.date && !show?.dateTime) return null;
  const raw = show.dateTime || show.date;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return show.date || null;
  }
  const dateLabel = parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (show.time) {
    return `${dateLabel} at ${show.time}`;
  }
  return dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

const ShowCard = memo(({ show }) => {
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);

  return (
    <>
      <a
        href={show.url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="artist-show-card--discover-mobile"
      >
        <div className="artist-show-card__image-wrap--discover artist-show-card__image-wrap--discover-mobile">
          {show.image ? (
            <img
              src={show.image}
              alt={show.eventName || show.artistName}
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
          <div className="artist-show-card__distance--discover">
            {Number.isFinite(show.distance) && (
              <span className="artist-show-card__distance-badge--discover">
                {Math.round(show.distance)} mi
              </span>
            )}
          </div>
          <div className="artist-show-card__image--discover-content">
            <div />
            <div className="artist-show-card__image--discover-bottom">
              <p className="artist-show-card__artist--discover artist-truncate">
                {show.artistName}
              </p>
              <h3 className="artist-show-card__title--discover artist-truncate">
                {show.eventName}
              </h3>
              <div className="artist-show-card__details--discover">
                {showDate && (
                  <p className="artist-show-card__detail--discover">
                    <Clock className="artist-show-card__detail-icon--discover" />
                    <span className="artist-show-card__detail-text--discover">
                      {showDate}
                    </span>
                  </p>
                )}
                {showLocation && (
                  <p className="artist-show-card__detail--discover artist-show-card__detail--discover-location">
                    <MapPin className="artist-show-card__detail-icon--discover artist-show-card__detail-icon--discover-location" />
                    <span className="artist-show-card__detail-text--discover">
                      {showLocation}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </a>

      <article className="artist-show-card--discover-desktop">
        <a href={show.url || "#"} target="_blank" rel="noopener noreferrer">
          <div className="artist-show-card__image-wrap--discover artist-show-card__image-wrap--discover-desktop">
            {show.image ? (
              <img
                src={show.image}
                alt={show.eventName || show.artistName}
                className="artist-show-card__image--discover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="artist-media-placeholder--discover">
                <Music className="artist-media-placeholder--discover-icon" />
              </div>
            )}
            <div className="artist-show-card__distance--discover">
              {Number.isFinite(show.distance) && (
                <span className="artist-show-card__distance-badge--discover">
                  {Math.round(show.distance)} mi
                </span>
              )}
            </div>
          </div>
        </a>
        <div className="artist-show-card__body--discover">
          <div className="artist-show-card__body-heading">
            <p className="artist-show-card__body-artist--discover artist-truncate">
              {show.artistName}
            </p>
            <h3 className="artist-show-card__body-title--discover">
              <a
                href={show.url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="artist-show-card__body-title-link--discover artist-truncate"
              >
                {show.eventName}
              </a>
            </h3>
          </div>
          <div className="artist-show-card__body-details--discover">
            {showDate && (
              <p className="artist-show-card__body-detail--discover">
                <Clock className="artist-show-card__body-detail-icon--discover" />
                <span className="artist-truncate">{showDate}</span>
              </p>
            )}
            {showLocation && (
              <p className="artist-show-card__body-detail--discover artist-show-card__body-detail--discover-location">
                <MapPin className="artist-show-card__body-detail-icon--discover artist-show-card__body-detail-icon--discover-location" />
                <span className="artist-clamp-2">{showLocation}</span>
              </p>
            )}
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
