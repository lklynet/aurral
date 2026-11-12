import { isAlbumCompleteInLibrary } from "../utils/albumAddAction.ts";
import { isAwaitingRelease } from "../utils/albumStatus.ts";
import { getArtistRecordId } from "../utils/artistTaste";
import { buildStaticPlaylistTrackPayload } from "../utils/staticPlaylists.ts";
import type { SearchItem } from "../utils/searchNavigation.ts";

export const PAGE_SIZE = 20;
export const DEFAULT_ALBUM_SORT = "relevance";
export const ALBUM_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "dateDesc", label: "Newest" },
  { value: "artistAsc", label: "Artist (A-Z)" },
  { value: "titleAsc", label: "Title (A-Z)" },
];
export const ALBUM_RELEASE_TABS = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "EPs & singles" },
  { value: "compilations", label: "Compilations" },
];
export const UNIFIED_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "tracks", label: "Songs" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles and EPs" },
  { value: "artists", label: "Artists" },
  { value: "playlists", label: "Playlists" },
] as const;

export type UnifiedFilter = (typeof UNIFIED_FILTER_OPTIONS)[number]["value"];

export const readUnifiedFilter = (value: string | null): UnifiedFilter =>
  UNIFIED_FILTER_OPTIONS.find((option) => option.value === value)?.value ?? "all";

const ACTIVE_ALBUM_LABELS: Partial<Record<string, string>> = {
  searching: "Searching",
  downloading: "Downloading",
  processing: "Queued",
};

export type SearchAlbumState =
  | { kind: "complete" }
  | { kind: "active"; label: string }
  | { kind: "waiting" }
  | { kind: "partial" }
  | { kind: "available" };

export function getSearchAlbumState(
  album: {
    status?: string | null;
    managed?: boolean;
    monitored?: boolean | null;
    releaseDate?: string | null;
    trackFileCount?: number | null;
  },
  downloading: boolean,
): SearchAlbumState {
  if (isAlbumCompleteInLibrary({ status: album.status })) return { kind: "complete" };
  const activeLabel = ACTIVE_ALBUM_LABELS[album.status ?? ""];
  if (downloading || activeLabel) return { kind: "active", label: activeLabel ?? "Downloading" };
  if (isAwaitingRelease(album)) return { kind: "waiting" };
  if (album.status === "partial" && Number(album.trackFileCount) > 0) return { kind: "partial" };
  return { kind: "available" };
}

interface SearchAlbum {
  id?: string | number | null;
  primaryType?: string | null;
  secondaryTypes?: string[] | null;
}

interface SearchArtist {
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
}

export function isAlbumCompilation(album: SearchAlbum | null | undefined) {
  return (
    album?.primaryType === "Compilation" || (album?.secondaryTypes || []).includes("Compilation")
  );
}

function isAlbumSingleOrEp(album: SearchAlbum | null | undefined) {
  return album?.primaryType === "Single" || album?.primaryType === "EP";
}

export function matchesAlbumReleaseTab(album: SearchAlbum | null | undefined, tab: string) {
  if (tab === "all") return true;
  if (tab === "compilations") return isAlbumCompilation(album);
  if (tab === "singles") {
    return isAlbumSingleOrEp(album) && !isAlbumCompilation(album);
  }
  return album?.primaryType === "Album" && !isAlbumCompilation(album);
}

export function dedupeArtists<T extends SearchArtist>(artists: T[]): T[] {
  const seen = new Set();
  return artists.filter((artist) => {
    const artistId = getArtistRecordId(artist);
    if (!artistId || seen.has(artistId)) return false;
    seen.add(artistId);
    return true;
  });
}

export function dedupeAlbums<T extends SearchAlbum>(albums: T[]): T[] {
  const seen = new Set();
  return albums.filter((album) => {
    if (!album?.id || seen.has(album.id)) return false;
    seen.add(album.id);
    return true;
  });
}

export const searchTrackPayload = (track: SearchItem) =>
  buildStaticPlaylistTrackPayload({
    artistName: track.artistName || "",
    trackName: track.title || "",
    albumName: track.albumTitle || "",
    artistMbid: track.artistMbid || "",
    albumMbid: track.albumMbid || "",
    trackMbid: track.trackMbid || "",
    releaseYear: track.releaseYear ? String(track.releaseYear) : null,
    durationMs: track.durationMs ?? null,
  });
