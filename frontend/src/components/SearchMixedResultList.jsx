import { Music } from "lucide-react";
import ArtistImage from "./ArtistImage";
import { getSearchResultKey, navigateFromSearchResult } from "../utils/searchNavigation";
import { getDiscoverArtworkUrl } from "../utils/api/endpoints/discovery.js";
import { getFlowArtworkUrl } from "../utils/api/endpoints/playlists.js";
import { getArtistRecordId } from "../utils/artistTaste";

const handleMainKeyDown = (event, onClick) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onClick();
};

function getSearchPlaylistArtworkUrl(playlist) {
  if (!playlist) return null;
  if (playlist.coverUrl) return playlist.coverUrl;
  const presetId = String(playlist.discoverPresetId || "").trim();
  if (playlist.source === "discover" && presetId) {
    return getDiscoverArtworkUrl(presetId);
  }
  const playlistId = String(playlist.id || "").trim();
  if (playlistId && !playlistId.startsWith("discover:")) {
    return getFlowArtworkUrl(playlistId);
  }
  if (presetId) {
    return getDiscoverArtworkUrl(presetId);
  }
  return null;
}

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

function ResultThumbnail({ item, artistImages, albumCovers, playbackEnabled }) {
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
          enablePreviewPlayback={playbackEnabled}
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
  playbackEnabled = true,
}) {
  if (!items.length) return null;

  return (
    <ul className="search-mixed-results">
      {items.map((item, index) => {
        const typeLabel = getTypeLabel(item);
        const primaryLabel = getPrimaryLabel(item);
        const secondaryLabel = getSecondaryLabel(item);
        const action = renderAction ? renderAction(item) : null;
        const handleOpen = () =>
          navigateFromSearchResult(navigate, item, {
            query,
          });

        return (
          <li key={getSearchResultKey(item, index)}>
            <div className="search-mixed-results__row">
              <div
                role="button"
                tabIndex={0}
                className="search-mixed-results__main"
                onClick={handleOpen}
                onKeyDown={(event) => handleMainKeyDown(event, handleOpen)}
                aria-label={`Open ${primaryLabel}`}
              >
                <ResultThumbnail
                  item={item}
                  artistImages={artistImages}
                  albumCovers={albumCovers}
                  playbackEnabled={playbackEnabled}
                />
                <span className="search-mixed-results__copy">
                  <span className="search-mixed-results__title" title={primaryLabel}>
                    {primaryLabel}
                  </span>
                  {secondaryLabel ? (
                    <span className="search-mixed-results__subtitle" title={secondaryLabel}>
                      {secondaryLabel}
                    </span>
                  ) : null}
                </span>
              </div>
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

export default SearchMixedResultList;
