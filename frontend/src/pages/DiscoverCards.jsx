import { memo, useCallback, useState, useEffect } from "react";
import { getReleaseGroupCover, getArtistCover } from "../utils/api/endpoints/artists.js";

import { Library, Music } from "lucide-react";
import ArtistImage from "../components/ArtistImage";
import AddActionButton from "../components/AddActionButton";
import { ArtistContextMenu } from "../components/ArtistContextMenu";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import { getReleaseNavigationTarget } from "../utils/searchNavigation";
import { formatDate } from "../utils/dateTime.js";
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
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const formattedDate = formatDate(date);
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
  return artist?.discoveryTier === "deeper" ? "A deeper discovery pick" : "Picked for your profile";
};

const handleCoverKeyDown = (event, onClick) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onClick();
};

export const ArtistCard = memo(
  ({
    artist,
    isInLibrary,
    canAddArtist,
    onNavigate,
    onOpenInLibrary,
    onAddToLibrary,
    onFeedback,
    feedbackUsed = {},
  }) => {
    const navigateTo = artist.navigateTo || artist.id;
    const hasValidMbid = navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
    const artistMetaText = getRecommendationReason(artist);
    const [openingInLibrary, setOpeningInLibrary] = useState(false);
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
    const handleOpenInLibrary = useCallback(
      async (event) => {
        event.stopPropagation();
        if (!onOpenInLibrary || openingInLibrary) return;
        setOpeningInLibrary(true);
        try {
          await onOpenInLibrary(artist);
        } finally {
          setOpeningInLibrary(false);
        }
      },
      [artist, onOpenInLibrary, openingInLibrary],
    );

    return (
      <div
        role="button"
        tabIndex={hasValidMbid ? 0 : -1}
        onClick={handleClick}
        onKeyDown={(event) => handleCoverKeyDown(event, handleClick)}
        className={`artist-discover-card artist-discover-card--artist${hasValidMbid ? "" : " is-disabled"}`}
        aria-label={`Open ${artist.name}`}
        aria-disabled={!hasValidMbid}
      >
        <div className="artist-discover-card__cover">
          <ArtistImage
            src={artist.image || artist.imageUrl}
            mbid={artist.id}
            artistName={artist.name}
            alt={artist.name}
            className="artist-discover-card__image"
            showLoading={false}
            enablePreviewPlayback={hasValidMbid}
            isInLibrary={isInLibrary}
          />
          {isInLibrary && onOpenInLibrary && (
            <div
              className="artist-discover-card__action"
              onClick={(event) => event.stopPropagation()}
              role="none"
            >
              <AddActionButton
                Icon={Library}
                label={`Open ${artist.name} in library`}
                onClick={handleOpenInLibrary}
                isLoading={openingInLibrary}
                disabled={openingInLibrary}
              />
            </div>
          )}
        </div>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <span
                className={`artist-card-title--discover${hasValidMbid ? "" : " is-disabled"}`}
                title={artist.name}
              >
                {artist.name}
              </span>
              {isInLibrary && <SearchLibraryCheck size="discover" />}
            </div>
            {artistMetaText ? (
              <p className="artist-card-meta--discover" title={artistMetaText || undefined}>
                {artistMetaText}
              </p>
            ) : null}
            {artist.subtitle && (
              <p className="artist-card-meta--discover" title={artist.subtitle}>
                {artist.subtitle}
              </p>
            )}
          </div>
          <div onClick={(event) => event.stopPropagation()} role="none">
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
      getRecommendationReason(prevProps.artist) === getRecommendationReason(nextProps.artist) &&
      prevProps.status === nextProps.status &&
      prevProps.isInLibrary === nextProps.isInLibrary &&
      prevProps.canAddArtist === nextProps.canAddArtist &&
      prevProps.feedbackUsed?.more_like_this === nextProps.feedbackUsed?.more_like_this &&
      prevProps.feedbackUsed?.less_like_this === nextProps.feedbackUsed?.less_like_this &&
      prevProps.feedbackUsed?.block_artist === nextProps.feedbackUsed?.block_artist &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.onOpenInLibrary === nextProps.onOpenInLibrary &&
      prevProps.onAddToLibrary === nextProps.onAddToLibrary &&
      prevProps.onFeedback === nextProps.onFeedback
    );
  },
);

ArtistCard.displayName = "ArtistCard";
export const AlbumCard = memo(
  ({
    album,
    onNavigate,
    canAddAlbum = false,
    isPending = false,
    onAlbumAction,
  }) => {
    const releaseGroupMbid = album.mbid || album.foreignAlbumId;
    const artistMbid = album.artistMbid || album.foreignArtistId;
    const [fetchedCover, setFetchedCover] = useState(null);
    const coverUrl = album.coverUrl || fetchedCover;

    useEffect(() => {
      if (album.coverUrl || fetchedCover) return;

      const fetchCover = async () => {
        if (releaseGroupMbid) {
          try {
            const data = await getReleaseGroupCover(releaseGroupMbid, {
              artistName: album.artistName || "",
              albumTitle: album.albumName || "",
            });
            if (data?.images?.length > 0) {
              const front = data.images.find((img) => img.front) || data.images[0];
              if (front?.image) { setFetchedCover(front.image); return; }
            }
          } catch {}
        }
        if (artistMbid) {
          try {
            const data = await getArtistCover(artistMbid, album.artistName);
            if (data?.images?.length > 0) {
              const front = data.images.find((img) => img.front) || data.images[0];
              if (front?.image) setFetchedCover(front.image);
            }
          } catch {}
        }
      };

      fetchCover();
    }, [releaseGroupMbid, artistMbid, album.coverUrl, album.artistName, album.albumName, fetchedCover]);
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
      <div
        role="button"
        tabIndex={canOpen ? 0 : -1}
        onClick={handleClick}
        onKeyDown={(event) => handleCoverKeyDown(event, handleClick)}
        className={`artist-discover-card artist-discover-card--album${canOpen ? "" : " is-disabled"}`}
        aria-label={`Open ${album.albumName}`}
        aria-disabled={!canOpen}
      >
        <div className="artist-discover-card__cover-wrap">
          <div className={`artist-discover-card__cover${canOpen ? "" : " is-disabled"}`}>
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
          </div>
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
              <AddActionButton
                onClick={(event) => {
                  event.stopPropagation();
                  onAlbumAction(album);
                }}
                isLoading={isPending}
                disabled={isPending}
                label="Add to Lidarr"
              />
            </div>
          ) : null}
        </div>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <span
                className={`artist-card-title--discover${canOpen ? "" : " is-disabled"}`}
                title={album.albumName}
              >
                {album.albumName}
              </span>
            </div>
            <p className="artist-card-meta--discover" title={albumArtistText}>
              {albumArtistText}
            </p>
            {albumReleaseText && (
              <p className="artist-card-meta--discover" title={albumReleaseText}>
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
      prevProps.album.statistics?.percentOfTracks === nextProps.album.statistics?.percentOfTracks &&
      prevProps.canAddAlbum === nextProps.canAddAlbum &&
      prevProps.isPending === nextProps.isPending &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.onAlbumAction === nextProps.onAlbumAction
    );
  },
);

AlbumCard.displayName = "AlbumCard";
export const ViewAllCard = memo(({ onClick, label = "View All" }) => {
  return (
    <button type="button" onClick={onClick} className="artist-view-all-card--discover">
      <div className="artist-media-cell">
        <span className="artist-card-title">{label}</span>
      </div>
    </button>
  );
});

ViewAllCard.displayName = "ViewAllCard";
