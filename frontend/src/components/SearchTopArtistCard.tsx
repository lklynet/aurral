import { ChevronRight, ListMusic, Music } from "./icons";
import type { SearchImageMap, SearchItem } from "./SearchMixedResultList";
import ArtistImage from "./ArtistImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { getSearchResultLink } from "../utils/searchNavigation";
import { getArtistRecordId } from "../utils/artistTaste";
import { isAlbumCompleteInLibrary } from "../utils/albumAddAction";
import RouteLink from "./RouteLink";
import ArtworkImage from "./ArtworkImage";
import { useThemeDocument } from "../hooks/useThemeDocument.ts";

type PreviewTrack = { title?: string | null };

function getPrimaryLabel(item: SearchItem | null | undefined) {
  if (item?.type === "artist") return item.name || "";
  if (item?.type === "album" || item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function getMetaLabel(item: SearchItem | null | undefined) {
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

function getPreviewLabel(item: SearchItem | null | undefined, previewTracks: PreviewTrack[]) {
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

function TopResultArtwork({
  item,
  artistImages,
  albumCovers,
  isInLibrary,
}: {
  item: SearchItem;
  artistImages: SearchImageMap;
  albumCovers: SearchImageMap;
  isInLibrary: boolean | undefined;
}) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return (
      <ArtistImage
        src={artistImages[String(artistId)] || item.image || item.imageUrl}
        mbid={artistId}
        artistName={item.name}
        alt={item.name}
        className="search-top-artist__image"
        showLoading={false}
        enableBackendFallback={false}
        enablePreviewPlayback
        isInLibrary={isInLibrary}
      />
    );
  }

  const coverSrc =
    item.type === "album"
      ? albumCovers[String(item.id)] || item.coverUrl
      : item.type === "track"
        ? albumCovers[String(item.albumMbid)] || item.coverUrl
        : null;

  if (coverSrc) {
    return (
      <ArtworkImage
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

function getBackdropSrc(
  item: SearchItem,
  artistImages: SearchImageMap,
  albumCovers: SearchImageMap,
) {
  if (item.type === "artist") {
    const artistId = getArtistRecordId(item);
    return artistImages[String(artistId)] || item.image || item.imageUrl || "";
  }
  if (item.type === "album") {
    return albumCovers[String(item.id)] || item.coverUrl || "";
  }
  if (item.type === "track") {
    return albumCovers[String(item.albumMbid)] || item.coverUrl || "";
  }
  return "";
}

interface SearchTopArtistCardProps {
  item?: SearchItem | null;
  artistImages: SearchImageMap;
  albumCovers?: SearchImageMap;
  libraryLookup: Record<string, boolean | undefined>;
  query?: string;
  previewTracks?: PreviewTrack[];
}

function SearchTopArtistCard({
  item: result,
  artistImages,
  albumCovers = {},
  libraryLookup,
  query = "",
  previewTracks = [],
}: SearchTopArtistCardProps) {
  const { matchArtwork: immersiveMode } = useThemeDocument();
  const label = getPrimaryLabel(result);
  const backdropSrc =
    immersiveMode && result ? getBackdropSrc(result, artistImages, albumCovers) : "";
  if (!result || !label) return null;
  const isArtist = result.type === "artist";
  const artistId = isArtist ? getArtistRecordId(result) : null;
  const isInLibrary =
    result.type === "album"
      ? isAlbumCompleteInLibrary({ status: result.status })
      : result.inLibrary || (isArtist && artistId ? libraryLookup[artistId] : false);
  const metaLabel = getMetaLabel(result);
  const previewLabel = getPreviewLabel(result, previewTracks);
  const link = getSearchResultLink(result, { query });
  const copy = (
    <>
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
    </>
  );

  return (
    <article className="search-top-artist">
      <div
        className={`search-top-artist__main${backdropSrc ? " search-top-artist__main--overlay" : ""}`}
      >
        {backdropSrc ? (
          <span className="search-top-artist__backdrop" aria-hidden="true">
            <img src={backdropSrc} alt="" className="search-top-artist__backdrop-image" />
            <span className="search-top-artist__backdrop-wash" />
          </span>
        ) : null}

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
              isInLibrary={isInLibrary}
            />
          </span>

          {link ? (
            <RouteLink
              to={link.to}
              state={link.state}
              className="search-top-artist__copy card-link"
              aria-label={`Open ${label}`}
            >
              {copy}
            </RouteLink>
          ) : (
            <span className="search-top-artist__copy">{copy}</span>
          )}

          <span className="search-top-artist__cta" aria-hidden="true">
            <ChevronRight className="search-top-artist__cta-icon" />
          </span>
        </span>
      </div>
    </article>
  );
}

export default SearchTopArtistCard;
