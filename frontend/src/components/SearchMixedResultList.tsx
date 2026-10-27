import type { ReactNode } from "react";
import ArtworkImage from "./ArtworkImage";
import { Music } from "./icons";
import ArtistImage from "./ArtistImage";
import { getSearchResultKey, getSearchResultLink } from "../utils/searchNavigation";
import { getPlaylistArtworkUrl } from "../utils/api/endpoints/playlists.ts";
import { getArtistRecordId } from "../utils/artistTaste";
import RouteLink from "./RouteLink";
import Tooltip from "./Tooltip";

export type SearchItem = NonNullable<Parameters<typeof getSearchResultKey>[0]> & {
  status?: string;
};
export type SearchImageMap = Record<string, string | null | undefined>;

interface SearchMixedResultListProps {
  items: SearchItem[];
  query?: string;
  artistImages?: SearchImageMap;
  albumCovers?: SearchImageMap;
  renderAction?: ((item: SearchItem) => ReactNode) | null;
}

function getSearchPlaylistArtworkUrl(playlist: SearchItem) {
  if (!playlist) return null;
  if (playlist.coverUrl) return playlist.coverUrl;
  const playlistId = String(playlist.id || "").trim();
  return playlistId ? getPlaylistArtworkUrl(playlistId) : null;
}

function getTypeLabel(item: SearchItem) {
  if (item.type === "artist") return "Artist";
  if (item.type === "album") return "Album";
  if (item.type === "track") return "Song";
  if (item.type === "playlist") return "Playlist";
  return null;
}

function getPrimaryLabel(item: SearchItem) {
  if (item.type === "artist") return item.name || "";
  if (item.type === "playlist") return item.name || "";
  if (item.type === "album") return item.title || "";
  if (item.type === "track") return item.title || "";
  return "";
}

function getSecondaryLabel(item: SearchItem) {
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
    return `${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`;
  }
  return null;
}

function ResultThumbnail({
  item,
  artistImages,
  albumCovers,
}: {
  item: SearchItem;
  artistImages: SearchImageMap;
  albumCovers: SearchImageMap;
}) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return (
      <span className="search-mixed-results__thumb search-mixed-results__thumb--round">
        <ArtistImage
          src={artistImages[String(artistId)] || item.image || item.imageUrl}
          mbid={artistId}
          artistName={item.name}
          alt={item.name}
          className="search-mixed-results__image"
          sizes="3rem"
          showLoading={false}
          enableBackendFallback={false}
          enablePreviewPlayback
        />
      </span>
    );
  }

  const coverSrc =
    item.type === "playlist"
      ? getSearchPlaylistArtworkUrl(item)
      : item.type === "album"
        ? albumCovers[String(item.id)] || item.coverUrl
        : item.type === "track"
          ? albumCovers[String(item.albumMbid)] || item.coverUrl
          : null;

  return (
    <span className="search-mixed-results__thumb">
      {coverSrc ? (
        <ArtworkImage
          src={coverSrc}
          alt=""
          className="search-mixed-results__image"
          sizes="3rem"
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
  query = "",
  artistImages = {},
  albumCovers = {},
  renderAction = null,
}: SearchMixedResultListProps) {
  if (!items.length) return null;

  return (
    <ul className="search-mixed-results">
      {items.map((item, index) => {
        const typeLabel = getTypeLabel(item);
        const primaryLabel = getPrimaryLabel(item);
        const secondaryLabel = getSecondaryLabel(item);
        const action = renderAction ? renderAction(item) : null;
        const link = getSearchResultLink(item, { query });
        const copy = (
          <>
            <Tooltip content={primaryLabel}>
              <span className="search-mixed-results__title">{primaryLabel}</span>
            </Tooltip>
            {secondaryLabel ? (
              <Tooltip content={secondaryLabel}>
                <span className="search-mixed-results__subtitle">{secondaryLabel}</span>
              </Tooltip>
            ) : null}
          </>
        );

        return (
          <li key={getSearchResultKey(item, index)}>
            <div className="search-mixed-results__row">
              <div className="search-mixed-results__main">
                <ResultThumbnail
                  item={item}
                  artistImages={artistImages}
                  albumCovers={albumCovers}
                />
                {link ? (
                  <RouteLink
                    to={link.to}
                    state={link.state}
                    className="search-mixed-results__copy card-link"
                    aria-label={`Open ${primaryLabel}`}
                  >
                    {copy}
                  </RouteLink>
                ) : (
                  <span className="search-mixed-results__copy">{copy}</span>
                )}
              </div>
              {typeLabel ? (
                <span className="search-mixed-results__type-col">
                  <span className="search-mixed-results__type">{typeLabel}</span>
                </span>
              ) : (
                <span className="search-mixed-results__type-col" />
              )}
              <span className="search-mixed-results__actions">{action}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default SearchMixedResultList;
