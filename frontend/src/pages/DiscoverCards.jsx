import { memo, useState, useEffect } from "react";
import { getReleaseGroupCover, getArtistCover } from "../utils/api/endpoints/artists.js";

import { Music } from "lucide-react";
import ArtistImage from "../components/ArtistImage";
import AddActionButton from "../components/AddActionButton";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { ArtistContextMenu } from "../components/ArtistContextMenu";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import { getReleaseNavigationTarget } from "../utils/searchNavigation";
import { getAlbumAddAction } from "../utils/albumAddAction";
import { formatDate, formatRelativeTime } from "../utils/dateTime.js";
import Tooltip from "../components/Tooltip";
import RecommendationMeta from "../components/RecommendationMeta";
import RouteLink from "../components/RouteLink";
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
  if (date > todayStart) {
    return { text: `Releasing ${formattedDate}`, detail: formattedDate };
  }
  return { text: `Released ${formatRelativeTime(date, { unit: "day" })}`, detail: formattedDate };
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

function CardText({ link, label, children }) {
  if (!link) return <div className="artist-discover-card__text">{children}</div>;
  return (
    <RouteLink
      to={link.to}
      state={link.state}
      className="artist-discover-card__text card-link"
      aria-label={label}
    >
      {children}
    </RouteLink>
  );
}

export const ArtistCard = memo(
  ({
    artist,
    isInLibrary,
    getLibraryLink,
    onFeedback,
    feedbackUsed = {},
  }) => {
    const navigateTo = artist.navigateTo || artist.id;
    const hasValidMbid = navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
    const artistMetaText = getRecommendationReason(artist);
    const link = artist.libraryPath
      ? { to: artist.libraryPath }
      : hasValidMbid
        ? {
            to: `/artist/${navigateTo}`,
            state: {
              artistName: artist.name,
              inLibrary: isInLibrary,
              artistImage: artist.image || artist.imageUrl || undefined,
            },
          }
        : null;
    const canOpen = Boolean(link);
    return (
      <div
        className={`artist-discover-card artist-discover-card--artist${canOpen ? "" : " is-disabled"}`}
        data-artwork-scope
        data-library-menu-target
      >
        <div className="artist-discover-card__cover" data-artwork>
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
        </div>

        <div className="artist-discover-card__content">
          <CardText link={link} label={`Open ${artist.name}`}>
            <div className="artist-card-title-row--discover">
              <Tooltip content={artist.name}>
                <span
                  className={`artist-card-title--discover${canOpen ? "" : " is-disabled"}`}
                >
                  {artist.name}
                </span>
              </Tooltip>
              {isInLibrary && <SearchLibraryCheck size="discover" />}
            </div>
            <RecommendationMeta
              artist={artist}
              text={artistMetaText}
              className="artist-card-meta--discover"
            />
            {artist.subtitle && (
              <Tooltip content={artist.subtitleDetail || artist.subtitle}>
                <p className="artist-card-meta--discover" >
                  {artist.subtitle}
                </p>
              </Tooltip>
            )}
          </CardText>
          <div className="artist-discover-card__menu">
            <ArtistContextMenu
              artist={artist}
              isInLibrary={isInLibrary}
              getLibraryLink={getLibraryLink}
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
      prevProps.artist.libraryPath === nextProps.artist.libraryPath &&
      prevProps.artist.canonicalId === nextProps.artist.canonicalId &&
      prevProps.artist.subtitle === nextProps.artist.subtitle &&
      prevProps.artist.subtitleDetail === nextProps.artist.subtitleDetail &&
      getRecommendationReason(prevProps.artist) === getRecommendationReason(nextProps.artist) &&
      prevProps.artist.matchPercent === nextProps.artist.matchPercent &&
      prevProps.status === nextProps.status &&
      prevProps.isInLibrary === nextProps.isInLibrary &&
      prevProps.feedbackUsed?.more_like_this === nextProps.feedbackUsed?.more_like_this &&
      prevProps.feedbackUsed?.less_like_this === nextProps.feedbackUsed?.less_like_this &&
      prevProps.feedbackUsed?.block_artist === nextProps.feedbackUsed?.block_artist &&
      prevProps.getLibraryLink === nextProps.getLibraryLink &&
      prevProps.onFeedback === nextProps.onFeedback
    );
  },
);

ArtistCard.displayName = "ArtistCard";
export const AlbumCard = memo(
  ({
    album,
    canAddAlbum = false,
    isPending = false,
    onAlbumAction,
    libraryDestination,
  }) => {
    const releaseGroupMbid = album.mbid || album.foreignAlbumId;
    const artistMbid = album.artistMbid || album.foreignArtistId;
    const { isAlbumDownloading } = useActiveDownloads();
    const downloading = isPending || isAlbumDownloading(releaseGroupMbid);
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
    const albumRelease = formatReleaseStatus(album.releaseDate);
    const albumReleaseText = albumRelease?.text;
    const isComplete = (album.statistics?.percentOfTracks || 0) > 0;
    const target = getReleaseNavigationTarget({
      type: "album",
      id: releaseGroupMbid,
      artistMbid,
      artistName: album.artistName,
      title: album.albumName,
      releaseDate: album.releaseDate,
      coverUrl,
    });
    const link = target ? { to: target.pathname, state: target.state } : null;
    const canOpen = Boolean(link);

    return (
      <div
        className={`artist-discover-card artist-discover-card--album${canOpen ? "" : " is-disabled"}`}
        data-artwork-scope
      >
        <div className="artist-discover-card__cover-wrap">
          <div className={`artist-discover-card__cover${canOpen ? "" : " is-disabled"}`} data-artwork>
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
              <Tooltip content="In library">
                <span className="artist-release-card__status" >
                  <SearchLibraryCheck size="overlay" />
                  <span className="sr-only">In library</span>
                </span>
              </Tooltip>
            </div>
          ) : canAddAlbum && typeof onAlbumAction === "function" ? (
            <div className="artist-discover-card__action">
              <AddActionButton
                {...getAlbumAddAction(album, libraryDestination)}
                onAdd={(managedBy) => onAlbumAction(album, managedBy)}
                isLoading={downloading}
                loadingLabel="Downloading"
                disabled={downloading}
              />
            </div>
          ) : null}
        </div>

        <div className="artist-discover-card__content">
          <CardText link={link} label={`Open ${album.albumName}`}>
            <div className="artist-card-title-row--discover">
              <Tooltip content={album.albumName}>
                <span
                  className={`artist-card-title--discover${canOpen ? "" : " is-disabled"}`}
                >
                  {album.albumName}
                </span>
              </Tooltip>
            </div>
            <Tooltip content={albumArtistText}>
              <p className="artist-card-meta--discover" >
                {albumArtistText}
              </p>
            </Tooltip>
            {albumReleaseText && (
              <Tooltip content={albumRelease.detail}>
                <p className="artist-card-meta--discover" >
                  {albumReleaseText}
                </p>
              </Tooltip>
            )}
          </CardText>
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
      prevProps.album.managedBy === nextProps.album.managedBy &&
      prevProps.libraryDestination === nextProps.libraryDestination &&
      prevProps.onAlbumAction === nextProps.onAlbumAction
    );
  },
);

AlbumCard.displayName = "AlbumCard";
export const ViewAllCard = memo(({ to, label = "View All" }) => {
  return (
    <RouteLink to={to} className="artist-view-all-card--discover">
      <div className="artist-media-cell">
        <span className="artist-card-title">{label}</span>
      </div>
    </RouteLink>
  );
});

ViewAllCard.displayName = "ViewAllCard";
