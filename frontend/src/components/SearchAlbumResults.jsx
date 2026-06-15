import { useCallback, useState } from "react";
import PropTypes from "prop-types";
import { Music } from "lucide-react";
import SearchLibraryCheck from "./SearchLibraryCheck";
import AddAlbumButton from "./AddAlbumButton";
import { getReleaseNavigationTarget } from "../utils/searchNavigation";

function isAlbumActionDisabled(album, isPending, canAddAlbum) {
  if (!canAddAlbum) return true;
  return isPending || ["searching", "downloading", "processing"].includes(album.status);
}

function getReleaseYear(releaseDate) {
  const value = String(releaseDate || "").trim();
  if (!value) return null;
  return value.split("-")[0] || null;
}

function getReleaseTypeLabel(album) {
  const primary = album.primaryType || null;
  const secondary = Array.isArray(album.secondaryTypes)
    ? album.secondaryTypes.filter(Boolean)
    : [];
  const types = [primary, ...secondary].filter(Boolean);
  return types.length ? types.join(" · ") : null;
}

function AlbumCover({ src, alt }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="artist-release-card__placeholder">
        <Music className="artist-icon-lg" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function AlbumAction({ album, isPending, canAddAlbum, onAlbumAction }) {
  const actionDisabled = isAlbumActionDisabled(album, isPending, canAddAlbum);
  const isComplete = album.status === "available";
  const actionLabel =
    album.status === "inLibrary" ? "Search Album" : "Add to Lidarr";

  if (isComplete) {
    return (
      <span className="artist-release-card__status" title="In library">
        <SearchLibraryCheck size="overlay" />
        <span className="sr-only">In library</span>
      </span>
    );
  }

  if (!canAddAlbum) return null;

  return (
    <AddAlbumButton
      onClick={(event) => {
        event.stopPropagation();
        onAlbumAction(album);
      }}
      isLoading={isPending}
      disabled={actionDisabled}
      label={actionLabel}
    />
  );
}

function SearchAlbumResults({
  albums,
  albumCovers,
  canAddAlbum,
  pendingAlbumIds,
  onAlbumAction,
  navigate,
  viewMode = "grid",
}) {
  const openAlbum = useCallback(
    (album) => {
      const target = getReleaseNavigationTarget({ ...album, type: "album" });
      if (target) {
        navigate(target.pathname, { state: target.state });
        return;
      }
      if (album.artistMbid) {
        navigate(`/artist/${album.artistMbid}/albums`, {
          state: { artistName: album.artistName },
        });
      }
    },
    [navigate],
  );

  const openArtist = useCallback(
    (album, event) => {
      event?.stopPropagation();
      if (!album.artistMbid) return;
      navigate(`/artist/${album.artistMbid}`, {
        state: { artistName: album.artistName },
      });
    },
    [navigate],
  );

  const renderAlbum = (album) => {
    const isPending = !!pendingAlbumIds[album.id];
    const coverSrc = albumCovers[album.id] || album.coverUrl;
    const releaseYear = getReleaseYear(album.releaseDate);
    const releaseTypeLabel = getReleaseTypeLabel(album);
    const releaseMeta = [releaseYear, releaseTypeLabel]
      .filter(Boolean)
      .join(" · ");

    if (viewMode === "list") {
      return (
        <div
          className="artist-release-list-item search-album-results__item"
          onClick={() => openAlbum(album)}
        >
          <div className="artist-media-cell artist-list-cover">
            {coverSrc ? (
              <img src={coverSrc} alt={album.title} loading="lazy" decoding="async" />
            ) : (
              <div className="artist-media-placeholder">
                <Music className="artist-icon-md" />
              </div>
            )}
          </div>
          <div className="artist-min-0">
            <h2 className="artist-release-card__title artist-truncate">
              {album.title}
            </h2>
            <div className="artist-release-card__meta artist-truncate">
              {album.artistName ? (
                <button
                  type="button"
                  className="artist-link-button"
                  onClick={(event) => openArtist(album, event)}
                >
                  {album.artistName}
                </button>
              ) : null}
              {album.artistName && releaseMeta ? " · " : null}
              {releaseMeta ? <span>{releaseMeta}</span> : null}
            </div>
          </div>
          <div
            className="artist-row-actions"
            onClick={(event) => event.stopPropagation()}
          >
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </div>
      );
    }

    return (
      <article
        key={album.id}
        className="artist-release-card search-album-results__item"
        onClick={() => openAlbum(album)}
      >
        <div className="artist-release-card__cover">
          {coverSrc ? (
            <AlbumCover src={coverSrc} alt={album.title} />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
          <div
            className="artist-release-card__action"
            onClick={(event) => event.stopPropagation()}
          >
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </div>
        <h2 className="artist-release-card__title artist-truncate" title={album.title}>
          {album.title}
        </h2>
        {album.artistName ? (
          <button
            type="button"
            className="artist-card-button"
            onClick={(event) => openArtist(album, event)}
          >
            <p className="artist-release-card__meta artist-truncate">
              {album.artistName}
            </p>
          </button>
        ) : null}
        {releaseMeta && (
          <p className="artist-release-card__meta artist-truncate">
            {releaseMeta}
          </p>
        )}
      </article>
    );
  };

  return (
    <div
      className={
        viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"
      }
    >
      {albums.map((album) => renderAlbum(album))}
    </div>
  );
}

SearchAlbumResults.propTypes = {
  albums: PropTypes.arrayOf(PropTypes.object).isRequired,
  albumCovers: PropTypes.object.isRequired,
  canAddAlbum: PropTypes.bool.isRequired,
  pendingAlbumIds: PropTypes.object.isRequired,
  onAlbumAction: PropTypes.func.isRequired,
  navigate: PropTypes.func.isRequired,
  viewMode: PropTypes.oneOf(["grid", "list"]),
};

AlbumCover.propTypes = {
  src: PropTypes.string,
  alt: PropTypes.string,
};

AlbumAction.propTypes = {
  album: PropTypes.object.isRequired,
  isPending: PropTypes.bool.isRequired,
  canAddAlbum: PropTypes.bool.isRequired,
  onAlbumAction: PropTypes.func.isRequired,
};

export default SearchAlbumResults;
