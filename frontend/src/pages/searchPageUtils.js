export const PAGE_SIZE = 20;
export const DEFAULT_ALBUM_SORT = "relevance";
export { ALBUM_PENDING_STATUSES } from "../utils/globalSearchUtils";
export const ALBUM_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "dateDesc", label: "Newest" },
  { value: "artistAsc", label: "Artist (A-Z)" },
  { value: "titleAsc", label: "Title (A-Z)" },
];
export const ALBUM_RELEASE_TABS = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "EP & Singles" },
  { value: "compilations", label: "Compilations" },
];
export const UNIFIED_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "artists", label: "Artists" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles" },
];

export function isAlbumCompilation(album) {
  return (
    album?.primaryType === "Compilation" ||
    (album?.secondaryTypes || []).includes("Compilation")
  );
}

export function isAlbumSingleOrEp(album) {
  return album?.primaryType === "Single" || album?.primaryType === "EP";
}

export function matchesAlbumReleaseTab(album, tab) {
  if (tab === "all") return true;
  if (tab === "compilations") return isAlbumCompilation(album);
  if (tab === "singles") {
    return isAlbumSingleOrEp(album) && !isAlbumCompilation(album);
  }
  return album?.primaryType === "Album" && !isAlbumCompilation(album);
}

import { getArtistRecordId } from "../utils/artistTaste";

export function dedupeArtists(artists) {
  const seen = new Set();
  return artists.filter((artist) => {
    const artistId = getArtistRecordId(artist);
    if (!artistId || seen.has(artistId)) return false;
    seen.add(artistId);
    return true;
  });
}

export function dedupeAlbums(albums) {
  const seen = new Set();
  return albums.filter((album) => {
    if (!album?.id || seen.has(album.id)) return false;
    seen.add(album.id);
    return true;
  });
}

export const ARTIST_IMAGE_HYDRATION_CONCURRENCY = 6;
export const ALBUM_COVER_HYDRATION_CONCURRENCY = 6;
