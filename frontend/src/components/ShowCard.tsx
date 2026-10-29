import { memo } from "react";
import { Clock, MapPin, Music } from "./icons";
import {
  formatDistance,
  formatShowDate,
  formatShowLocation,
  getEventUrl,
  titleNamesArtists,
  type NearbyShow,
} from "../utils/shows.ts";
import Tooltip from "./Tooltip";

interface ShowMetaProps {
  showDate: string | null;
  showLocation: string;
  className: string;
}

function ShowMeta({ showDate, showLocation, className }: ShowMetaProps) {
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

interface ShowCardProps {
  show: NearbyShow;
}

const ShowCard = memo(({ show }: ShowCardProps) => {
  const artistNames = (show.artistNames || []).filter(Boolean);
  const artistLabel = artistNames.join(", ") || "Matched artist";
  const eventLabel = show.eventName || artistLabel || "Upcoming show";
  const showArtistLine = !titleNamesArtists(eventLabel, artistNames);
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
    <Tag {...linkProps} className={`artist-show-card--discover${eventUrl ? "" : " is-disabled"}`}>
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
            <Music className="artist-media-placeholder--discover-icon" aria-hidden="true" />
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
            {showArtistLine ? (
              <p className="artist-show-card__artist--discover artist-truncate">{artistLabel}</p>
            ) : null}
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
          {showArtistLine ? (
            <p className="artist-show-card__body-artist--discover artist-truncate">{artistLabel}</p>
          ) : null}
          <h3 className="artist-show-card__body-title--discover">
            <Tooltip content={eventLabel}>
              <span className="artist-show-card__body-title-text--discover artist-truncate">
                {eventLabel}
              </span>
            </Tooltip>
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
