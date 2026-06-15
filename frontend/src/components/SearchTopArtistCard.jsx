import PropTypes from "prop-types";
import { ChevronRight, ListMusic, Music } from "lucide-react";
import ArtistImage from "./ArtistImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { useImageGradientColors } from "../hooks/useImageGradientColors";
import { navigateFromSearchResult } from "../utils/searchNavigation";
import { getArtistRecordId } from "../utils/artistTaste";

function getPrimaryLabel(item) {
  if (item?.type === "artist") return item.name || "";
  if (item?.type === "album" || item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function getMetaLabel(item) {
  if (item?.type === "artist") return "Artist";
  if (item?.type === "album") {
    return item.artistName ? `Album · ${item.artistName}` : "Album";
  }
  if (item?.type === "track") {
    return item.artistName ? `Song · ${item.artistName}` : "Song";
  }
  if (item?.type === "playlist") {
    return item.trackCount != null
      ? `Playlist · ${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`
      : "Playlist";
  }
  return "";
}

function getPreviewLabel(item, previewTracks) {
  const trackTitles = (previewTracks || [])
    .map((track) => track?.title)
    .filter(Boolean)
    .slice(0, 3);
  if (trackTitles.length > 0) {
    return trackTitles.join(" · ");
  }
  if (item?.type === "track" && item.albumTitle) {
    return item.albumTitle;
  }
  return null;
}

function TopResultArtwork({ item, artistImages, albumCovers }) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return (
      <ArtistImage
        src={artistImages[artistId] || item.image || item.imageUrl}
        mbid={artistId}
        artistName={item.name}
        alt={item.name}
        className="search-top-artist__image"
        showLoading={false}
        enableBackendFallback={false}
      />
    );
  }

  const coverSrc =
    item.type === "album"
      ? albumCovers[item.id] || item.coverUrl
      : item.type === "track"
        ? albumCovers[item.albumMbid] || item.coverUrl
        : null;

  if (coverSrc) {
    return (
      <img
        src={coverSrc}
        alt=""
        className="search-top-artist__image"
        loading="lazy"
        decoding="async"
      />
    );
  }

  return item.type === "playlist" ? (
    <ListMusic className="artist-icon-lg" />
  ) : (
    <Music className="artist-icon-lg" />
  );
}

function getBackdropSrc(item, artistImages, albumCovers) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return artistImages[artistId] || item.image || item.imageUrl || "";
  }
  if (item.type === "album") {
    return albumCovers[item.id] || item.coverUrl || "";
  }
  if (item.type === "track") {
    return albumCovers[item.albumMbid] || item.coverUrl || "";
  }
  return "";
}

function SearchTopArtistCard({
  item,
  artist: legacyArtist,
  artistImages,
  albumCovers = {},
  libraryLookup,
  navigate,
  query = "",
  previewTracks = [],
}) {
  const result = item || legacyArtist;
  const label = getPrimaryLabel(result);
  const backdropSrc = result ? getBackdropSrc(result, artistImages, albumCovers) : "";
  const gradientColors = useImageGradientColors(backdropSrc);
  if (!result || !label) return null;
  const isArtist = result.type === "artist";
  const artistId = isArtist ? getArtistRecordId(result) : null;
  const isInLibrary =
    result.inLibrary ||
    (isArtist && artistId ? libraryLookup[artistId] : false);
  const metaLabel = getMetaLabel(result);
  const previewLabel = getPreviewLabel(result, previewTracks);

  return (
    <article className="search-top-artist">
      <button
        type="button"
        className={`search-top-artist__main${
          gradientColors ? " search-top-artist__main--gradient" : ""
        }`}
        style={
          gradientColors
            ? {
                "--search-top-gradient-top": gradientColors.top,
                "--search-top-gradient-bottom": gradientColors.bottom,
              }
            : undefined
        }
        onClick={() =>
          navigateFromSearchResult(navigate, result, { query })
        }
      >
        <span className="search-top-artist__backdrop" aria-hidden="true">
          {gradientColors ? (
            <span className="search-top-artist__backdrop-gradient" />
          ) : backdropSrc ? (
            <img
              src={backdropSrc}
              alt=""
              className="search-top-artist__backdrop-image"
            />
          ) : null}
          <span className="search-top-artist__backdrop-wash" />
        </span>

        <span className="search-top-artist__content">
          <span
            className={`search-top-artist__image-wrap${
              isArtist ? "" : " search-top-artist__image-wrap--square"
            }`}
          >
            <TopResultArtwork
              item={result}
              artistImages={artistImages}
              albumCovers={albumCovers}
            />
          </span>

          <span className="search-top-artist__copy">
            <span className="search-top-artist__eyebrow">Top result</span>
            <span className="search-top-artist__title-row">
              <span className="search-top-artist__name">{label}</span>
              {isInLibrary && <SearchLibraryCheck />}
            </span>
            <span className="search-top-artist__meta-row">
              <span className="search-top-artist__meta">{metaLabel}</span>
              {previewLabel ? (
                <>
                  <span className="search-top-artist__meta-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="search-top-artist__preview">{previewLabel}</span>
                </>
              ) : null}
            </span>
          </span>

          <span className="search-top-artist__cta" aria-hidden="true">
            <ChevronRight className="search-top-artist__cta-icon" />
          </span>
        </span>
      </button>
    </article>
  );
}

SearchTopArtistCard.propTypes = {
  item: PropTypes.object,
  artist: PropTypes.object,
  artistImages: PropTypes.object.isRequired,
  albumCovers: PropTypes.object,
  libraryLookup: PropTypes.object.isRequired,
  navigate: PropTypes.func.isRequired,
  query: PropTypes.string,
  previewTracks: PropTypes.arrayOf(PropTypes.object),
};

TopResultArtwork.propTypes = {
  item: PropTypes.object.isRequired,
  artistImages: PropTypes.object.isRequired,
  albumCovers: PropTypes.object.isRequired,
};

export default SearchTopArtistCard;
