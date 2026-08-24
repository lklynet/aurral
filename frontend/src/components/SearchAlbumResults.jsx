import { useCallback, useState } from "react";
import { Music } from "lucide-react";
import SearchLibraryCheck from "./SearchLibraryCheck";
import AddActionButton from "./AddActionButton";
import { getAlbumAddButtonLabel, isAlbumCompleteInLibrary } from "../utils/albumAddAction";
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
  const secondary = Array.isArray(album.secondaryTypes) ? album.secondaryTypes.filter(Boolean) : [];
  const types = [primary, ...secondary].filter(Boolean);
  return types.length ? types.join(" · ") : null;
}

function AlbumCover({ src, alt }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="artist-release-card__placeholder">
        <Music className="artist-icon-lg" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}

function AlbumAction({ album, isPending, canAddAlbum, onAlbumAction }) {
  const actionDisabled = isAlbumActionDisabled(album, isPending, canAddAlbum);
  const isComplete = isAlbumCompleteInLibrary({ status: album.status });
  const actionLabel = getAlbumAddButtonLabel({
    status: album.status,
    inLibrary: album.inLibrary,
    monitored: album.monitored,
  });

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
    <AddActionButton
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
    (album) => {
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
    const releaseMeta = [releaseYear, releaseTypeLabel].filter(Boolean).join(" · ");

    if (viewMode === "list") {
      return (
        <article
          key={album.id}
          className="artist-release-list-item search-album-results__item"
        >
          <button
            type="button"
            className="search-album-results__cover-link"
            aria-label={`Open ${album.title}`}
            onClick={() => openAlbum(album)}
          >
            <div className="artist-media-cell artist-list-cover">
              {coverSrc ? (
                <img src={coverSrc} alt="" loading="lazy" decoding="async" />
              ) : (
                <div className="artist-media-placeholder">
                  <Music className="artist-icon-md" aria-hidden="true" />
                </div>
              )}
            </div>
          </button>
          <div className="artist-min-0">
            <h2 className="artist-release-card__title artist-truncate">
              <button
                type="button"
                className="search-album-results__title-link"
                onClick={() => openAlbum(album)}
              >
                {album.title}
              </button>
            </h2>
            <div className="artist-release-card__meta artist-truncate">
              {album.artistName ? (
                <button
                  type="button"
                  className="artist-link-button"
                  onClick={() => openArtist(album)}
                >
                  {album.artistName}
                </button>
              ) : null}
              {album.artistName && releaseMeta ? " · " : null}
              {releaseMeta ? <span>{releaseMeta}</span> : null}
            </div>
          </div>
          <div className="artist-row-actions">
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </article>
      );
    }

    return (
      <article
        key={album.id}
        className="artist-release-card search-album-results__item"
      >
        <div className="search-album-results__cover-wrap">
          <button
            type="button"
            className="artist-release-card__cover search-album-results__cover-link"
            aria-label={`Open ${album.title}`}
            onClick={() => openAlbum(album)}
          >
            {coverSrc ? (
              <AlbumCover src={coverSrc} alt="" />
            ) : (
              <div className="artist-release-card__placeholder">
                <Music className="artist-icon-lg" aria-hidden="true" />
              </div>
            )}
          </button>
          <div className="artist-release-card__action">
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </div>
        <h2 className="artist-release-card__title artist-truncate" title={album.title}>
          <button
            type="button"
            className="search-album-results__title-link"
            onClick={() => openAlbum(album)}
          >
            {album.title}
          </button>
        </h2>
        {album.artistName ? (
          <button
            type="button"
            className="artist-card-button"
            onClick={() => openArtist(album)}
          >
            <p className="artist-release-card__meta artist-truncate">{album.artistName}</p>
          </button>
        ) : null}
        {releaseMeta && <p className="artist-release-card__meta artist-truncate">{releaseMeta}</p>}
      </article>
    );
  };

  return (
    <div className={viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"}>
      {albums.map((album) => renderAlbum(album))}
    </div>
  );
}

export default SearchAlbumResults;
