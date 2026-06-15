import PropTypes from "prop-types";
import { Music } from "lucide-react";
import ArtistImage from "./ArtistImage";
import {
  getSearchResultKey,
  navigateFromSearchResult,
} from "../utils/searchNavigation";
import { getSearchPlaylistArtworkUrl } from "../utils/playlistArtworkUrls";
import { getArtistRecordId } from "../utils/artistTaste";

function getTypeLabel(item) {
  if (item.type === "artist") return "Artist";
  if (item.type === "album") return "Album";
  if (item.type === "track") return "Song";
  if (item.type === "playlist") return "Playlist";
  return null;
}

function getPrimaryLabel(item) {
  if (item.type === "artist") return item.name || "";
  if (item.type === "playlist") return item.name || "";
  if (item.type === "album") return item.title || "";
  if (item.type === "track") return item.title || "";
  return "";
}

function getSecondaryLabel(item) {
  if (item.type === "artist") {
    return String(item.disambiguation || "").trim() || null;
  }
  if (item.type === "album" && item.artistName) {
    return item.artistName;
  }
  if (item.type === "track") {
    return [item.artistName, item.albumTitle].filter(Boolean).join(" · ") || null;
  }
  if (item.type === "playlist" && item.trackCount != null) {
    const prefix = item.source === "discover" ? "Discover · " : "";
    return `${prefix}${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`;
  }
  return null;
}

function ResultThumbnail({ item, artistImages, albumCovers }) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return (
      <span className="search-mixed-results__thumb search-mixed-results__thumb--round">
        <ArtistImage
          src={artistImages[artistId] || item.image || item.imageUrl}
          mbid={artistId}
          artistName={item.name}
          alt={item.name}
          className="search-mixed-results__image"
          showLoading={false}
          enableBackendFallback={false}
        />
      </span>
    );
  }

  const coverSrc =
    item.type === "playlist"
      ? getSearchPlaylistArtworkUrl(item)
      : item.type === "album"
        ? albumCovers[item.id] || item.coverUrl
        : item.type === "track"
          ? albumCovers[item.albumMbid] || item.coverUrl
          : null;

  return (
    <span className="search-mixed-results__thumb">
      {coverSrc ? (
        <img
          src={coverSrc}
          alt=""
          className="search-mixed-results__image"
          loading="lazy"
          decoding="async"
        />
      ) : item.type === "playlist" ? (
        <span className="search-mixed-results__placeholder" aria-hidden="true" />
      ) : (
        <span className="search-mixed-results__placeholder" aria-hidden="true">
          <Music className="artist-icon-sm" />
        </span>
      )}
    </span>
  );
}

function SearchMixedResultList({
  items,
  navigate,
  query = "",
  artistImages = {},
  albumCovers = {},
  renderAction = null,
}) {
  if (!items.length) return null;

  return (
    <ul className="search-mixed-results">
      {items.map((item, index) => {
        const typeLabel = getTypeLabel(item);
        const primaryLabel = getPrimaryLabel(item);
        const secondaryLabel = getSecondaryLabel(item);
        const action = renderAction ? renderAction(item) : null;

        return (
          <li key={getSearchResultKey(item, index)}>
            <div className="search-mixed-results__row">
              <button
                type="button"
                className="search-mixed-results__main"
                onClick={() =>
                  navigateFromSearchResult(navigate, item, {
                    query,
                  })
                }
              >
                <ResultThumbnail
                  item={item}
                  artistImages={artistImages}
                  albumCovers={albumCovers}
                />
                <span className="search-mixed-results__copy">
                  <span
                    className="search-mixed-results__title"
                    title={primaryLabel}
                  >
                    {primaryLabel}
                  </span>
                  {secondaryLabel ? (
                    <span
                      className="search-mixed-results__subtitle"
                      title={secondaryLabel}
                    >
                      {secondaryLabel}
                    </span>
                  ) : null}
                </span>
              </button>
              {typeLabel ? (
                <span className="search-mixed-results__type-col">
                  <span className="search-mixed-results__type">{typeLabel}</span>
                </span>
              ) : (
                <span className="search-mixed-results__type-col" />
              )}
              <span
                className="search-mixed-results__actions"
                onClick={(event) => event.stopPropagation()}
              >
                {action}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

SearchMixedResultList.propTypes = {
  items: PropTypes.arrayOf(PropTypes.object).isRequired,
  navigate: PropTypes.func.isRequired,
  query: PropTypes.string,
  artistImages: PropTypes.object,
  albumCovers: PropTypes.object,
  renderAction: PropTypes.func,
};

ResultThumbnail.propTypes = {
  item: PropTypes.object.isRequired,
  artistImages: PropTypes.object.isRequired,
  albumCovers: PropTypes.object.isRequired,
};

export default SearchMixedResultList;
