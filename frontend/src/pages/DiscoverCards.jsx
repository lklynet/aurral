import { memo, useCallback } from "react";
import PropTypes from "prop-types";
import { Music } from "lucide-react";
import ArtistImage from "../components/ArtistImage";
import AddAlbumButton from "../components/AddAlbumButton";
import { ArtistContextMenu } from "../components/ArtistContextMenu";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import { getReleaseNavigationTarget } from "../utils/searchNavigation";

const parseCalendarDate = (value) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
};

const formatReleaseStatus = (releaseDate) => {
  const date = parseCalendarDate(releaseDate);
  if (!date) return null;
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const formattedDate = date.toLocaleDateString();
  if (date.getTime() === todayStart.getTime()) {
    return "Released today";
  }
  if (date < todayStart) {
    return `Released ${formattedDate}`;
  }
  return `Releasing ${formattedDate}`;
};

const getRecommendationReason = (artist) => {
  if (artist?.metaText !== undefined) return artist.metaText;
  const seedNames = Array.isArray(artist?.supportingSeeds)
    ? artist.supportingSeeds
        .map((seed) => seed?.artistName)
        .filter(Boolean)
        .slice(0, 2)
    : [];
  const matchedTags = Array.isArray(artist?.matchedTags)
    ? artist.matchedTags.filter(Boolean).slice(0, 2)
    : [];
  if (matchedTags.length >= 2) {
    return `${matchedTags[0]} + ${matchedTags[1]}`;
  }
  if (matchedTags.length === 1) {
    return matchedTags[0];
  }
  if (seedNames.length >= 2) {
    return `Because you listen to ${seedNames[0]} and ${seedNames[1]}`;
  }
  if (seedNames.length === 1) {
    return `Because you listen to ${seedNames[0]}`;
  }
  if (artist?.sourceArtist) {
    return `Similar to ${artist.sourceArtist}`;
  }
  return artist?.discoveryTier === "deeper"
    ? "A deeper discovery pick"
    : "Picked for your profile";
};

export const ArtistCard = memo(
  ({
    artist,
    isInLibrary,
    canAddArtist,
    onNavigate,
    onAddToLibrary,
    onFeedback,
    feedbackUsed = {},
  }) => {
    const navigateTo = artist.navigateTo || artist.id;
    const hasValidMbid =
      navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
    const artistMetaText = getRecommendationReason(artist);
    const handleClick = useCallback(() => {
      if (hasValidMbid) {
        onNavigate(`/artist/${navigateTo}`, {
          state: {
            artistName: artist.name,
            inLibrary: isInLibrary,
          },
        });
      }
    }, [navigateTo, hasValidMbid, artist.name, isInLibrary, onNavigate]);

    return (
      <div className="artist-discover-card artist-discover-card--artist">
        <button
          type="button"
          onClick={handleClick}
          className={`artist-discover-card__cover${hasValidMbid ? "" : " is-disabled"}`}
          disabled={!hasValidMbid}
          aria-label={`Open ${artist.name}`}
        >
          <ArtistImage
            src={artist.image || artist.imageUrl}
            mbid={artist.id}
            artistName={artist.name}
            alt={artist.name}
            className="artist-discover-card__image"
            showLoading={false}
          />
        </button>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <button
                type="button"
                onClick={handleClick}
                className={`artist-card-title--discover${hasValidMbid ? "" : " is-disabled"}`}
                title={artist.name}
                disabled={!hasValidMbid}
              >
                {artist.name}
              </button>
              {isInLibrary && <SearchLibraryCheck size="discover" />}
            </div>
            {artistMetaText ? (
              <p
                className="artist-card-meta--discover"
                title={artistMetaText || undefined}
              >
                {artistMetaText}
              </p>
            ) : null}
            {artist.subtitle && (
              <p className="artist-card-meta--discover" title={artist.subtitle}>
                {artist.subtitle}
              </p>
            )}
          </div>
          <ArtistContextMenu
            artist={artist}
            isInLibrary={isInLibrary}
            canAddArtist={canAddArtist}
            onAddToLibrary={onAddToLibrary}
            onFeedback={onFeedback}
            feedbackUsed={feedbackUsed}
          />
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.artist.id === nextProps.artist.id &&
      prevProps.artist.image === nextProps.artist.image &&
      prevProps.artist.imageUrl === nextProps.artist.imageUrl &&
      prevProps.artist.name === nextProps.artist.name &&
      prevProps.artist.navigateTo === nextProps.artist.navigateTo &&
      prevProps.artist.subtitle === nextProps.artist.subtitle &&
      getRecommendationReason(prevProps.artist) ===
        getRecommendationReason(nextProps.artist) &&
      prevProps.status === nextProps.status &&
      prevProps.isInLibrary === nextProps.isInLibrary &&
      prevProps.canAddArtist === nextProps.canAddArtist &&
      prevProps.feedbackUsed?.more_like_this ===
        nextProps.feedbackUsed?.more_like_this &&
      prevProps.feedbackUsed?.less_like_this ===
        nextProps.feedbackUsed?.less_like_this &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.onAddToLibrary === nextProps.onAddToLibrary &&
      prevProps.onFeedback === nextProps.onFeedback
    );
  },
);

ArtistCard.displayName = "ArtistCard";
ArtistCard.propTypes = {
  artist: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string.isRequired,
    image: PropTypes.string,
    imageUrl: PropTypes.string,
    type: PropTypes.string,
    sourceArtist: PropTypes.string,
    metaText: PropTypes.string,
    subtitle: PropTypes.string,
    navigateTo: PropTypes.string,
    matchedTags: PropTypes.arrayOf(PropTypes.string),
    reasonCodes: PropTypes.arrayOf(PropTypes.string),
    discoveryTier: PropTypes.string,
    supportingSeeds: PropTypes.arrayOf(
      PropTypes.shape({
        artistName: PropTypes.string,
      }),
    ),
  }).isRequired,
  status: PropTypes.string,
  isInLibrary: PropTypes.bool,
  canAddArtist: PropTypes.bool,
  onNavigate: PropTypes.func.isRequired,
  onAddToLibrary: PropTypes.func,
  onFeedback: PropTypes.func,
  feedbackUsed: PropTypes.shape({
    more_like_this: PropTypes.bool,
    less_like_this: PropTypes.bool,
  }),
};

export const AlbumCard = memo(
  ({
    album,
    releaseCovers,
    artistCovers,
    onNavigate,
    canAddAlbum = false,
    isPending = false,
    onAlbumAction,
  }) => {
    const releaseGroupMbid = album.mbid || album.foreignAlbumId;
    const artistMbid = album.artistMbid || album.foreignArtistId;
    const coverId = releaseGroupMbid;
    const releaseCover = coverId ? releaseCovers[coverId] : null;
    const artistCover = artistMbid ? artistCovers[artistMbid] : null;
    const coverUrl = album.coverUrl || releaseCover || artistCover;
    const albumArtistText = album.artistName || "Unknown Artist";
    const albumReleaseText = formatReleaseStatus(album.releaseDate);
    const isComplete = (album.statistics?.percentOfTracks || 0) > 0;
    const handleClick = useCallback(() => {
      const target = getReleaseNavigationTarget({
        type: "album",
        id: releaseGroupMbid,
        artistMbid,
        artistName: album.artistName,
        title: album.albumName,
        releaseDate: album.releaseDate,
        coverUrl,
      });
      if (target) {
        onNavigate(target.pathname, { state: target.state });
      }
    }, [
      album.albumName,
      album.artistName,
      album.releaseDate,
      artistMbid,
      coverUrl,
      onNavigate,
      releaseGroupMbid,
    ]);

    const canOpen = Boolean(releaseGroupMbid && artistMbid);

    return (
      <div className="artist-discover-card artist-discover-card--album">
        <div className="artist-discover-card__cover-wrap">
          <button
            type="button"
            onClick={handleClick}
            className={`artist-discover-card__cover${canOpen ? "" : " is-disabled"}`}
            disabled={!canOpen}
            aria-label={`Open ${album.albumName}`}
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={album.albumName}
                className="artist-discover-card__image"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="artist-media-placeholder--discover">
                <Music className="artist-icon-lg" />
              </div>
            )}
          </button>
          {isComplete ? (
            <div className="artist-discover-card__action">
              <span className="artist-release-card__status" title="In library">
                <SearchLibraryCheck size="overlay" />
                <span className="sr-only">In library</span>
              </span>
            </div>
          ) : canAddAlbum && typeof onAlbumAction === "function" ? (
            <div
              className="artist-discover-card__action"
              onClick={(event) => event.stopPropagation()}
            >
              <AddAlbumButton
                onClick={(event) => {
                  event.stopPropagation();
                  onAlbumAction(album);
                }}
                isLoading={isPending}
                disabled={isPending}
              />
            </div>
          ) : null}
        </div>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <button
                type="button"
                onClick={handleClick}
                className={`artist-card-title--discover${canOpen ? "" : " is-disabled"}`}
                title={album.albumName}
                disabled={!canOpen}
              >
                {album.albumName}
              </button>
            </div>
            <p className="artist-card-meta--discover" title={albumArtistText}>
              {albumArtistText}
            </p>
            {albumReleaseText && (
              <p
                className="artist-card-meta--discover"
                title={albumReleaseText}
              >
                {albumReleaseText}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevId = prevProps.album.mbid || prevProps.album.foreignAlbumId;
    const nextId = nextProps.album.mbid || nextProps.album.foreignAlbumId;
    return (
      prevId === nextId &&
      prevProps.album.albumName === nextProps.album.albumName &&
      prevProps.album.artistName === nextProps.album.artistName &&
      prevProps.album.coverUrl === nextProps.album.coverUrl &&
      prevProps.album.releaseDate === nextProps.album.releaseDate &&
      prevProps.album.statistics?.percentOfTracks ===
        nextProps.album.statistics?.percentOfTracks &&
      prevProps.canAddAlbum === nextProps.canAddAlbum &&
      prevProps.isPending === nextProps.isPending &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.onAlbumAction === nextProps.onAlbumAction &&
      prevProps.releaseCovers === nextProps.releaseCovers &&
      prevProps.artistCovers === nextProps.artistCovers
    );
  },
);

AlbumCard.displayName = "AlbumCard";
AlbumCard.propTypes = {
  album: PropTypes.shape({
    id: PropTypes.string,
    mbid: PropTypes.string,
    foreignAlbumId: PropTypes.string,
    albumName: PropTypes.string.isRequired,
    artistName: PropTypes.string,
    artistMbid: PropTypes.string,
    foreignArtistId: PropTypes.string,
    releaseDate: PropTypes.string,
    coverUrl: PropTypes.string,
  }).isRequired,
  releaseCovers: PropTypes.object.isRequired,
  artistCovers: PropTypes.object.isRequired,
  onNavigate: PropTypes.func.isRequired,
  canAddAlbum: PropTypes.bool,
  isPending: PropTypes.bool,
  onAlbumAction: PropTypes.func,
};

export const ViewAllCard = memo(({ onClick, label = "View All" }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="artist-view-all-card--discover"
    >
      <div className="artist-media-cell">
        <span className="artist-card-title">{label}</span>
      </div>
    </button>
  );
});

ViewAllCard.displayName = "ViewAllCard";
ViewAllCard.propTypes = {
  onClick: PropTypes.func.isRequired,
  label: PropTypes.string,
};
