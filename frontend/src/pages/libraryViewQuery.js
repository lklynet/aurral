import { queryOptions } from "@tanstack/react-query";
import { fetchLibraryPage, getLibraryFavorites } from "../utils/api/endpoints/library.js";
import {
  EMPTY_LIBRARY,
  favoriteId,
  favoriteLibraryFromResponse,
  normalizeLibraryPages,
} from "../utils/libraryPageData.js";
import { DEFAULT_LIBRARY_VIEW, LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
import { queryKeys } from "../queryClient.js";

export const LIBRARY_PAGE_SIZE = 100;

const LIBRARY_VIEW_IDS = new Set(LIBRARY_VIEWS.map((view) => view.id));

export const resolveLibrarySection = (routeSection) =>
  LIBRARY_VIEW_IDS.has(routeSection) ? routeSection : DEFAULT_LIBRARY_VIEW;

export const libraryTabForSection = (section) =>
  section === "home" || section === "album-artists" ? "artists" : section;

const favoriteIdsFromPages = (pages) => new Set(
  ["artists", "albums", "tracks"].flatMap((kind) =>
    pages
      .flatMap((page) => (Array.isArray(page?.[kind]) ? page[kind] : []))
      .filter((entity) => entity.userFavorite)
      .map((entity) => favoriteId(
        kind === "artists" ? "artist" : kind === "albums" ? "album" : "song",
        entity,
      )),
  ),
);

const favoriteIdsFromFavorites = (favorites) => new Set(
  ["artist", "album", "song"].flatMap((kind) =>
    (Array.isArray(favorites?.[kind]) ? favorites[kind] : []).map((entry) => entry.id),
  ),
);

const fetchLibraryView = async (
  { section, albumId, artistId, pageIndex, query, genre, sort, direction },
  signal,
) => {
  const tab = libraryTabForSection(section);
  const pageSize = LIBRARY_PAGE_SIZE;
  if (albumId) {
    return fetchLibraryPage({
      kind: "tracks",
      albumId,
      page: 1,
      pageSize,
      // An album detail view shows the full tracklist regardless of the
      // library-wide availability setting; owned/missing is shown per row.
      availableOnly: false,
    }, { signal });
  }
  if (artistId) {
    return Promise.all([
      fetchLibraryPage({ kind: "albums", artistId, page: 1, pageSize, availableOnly: true }, { signal }),
      fetchLibraryPage({ kind: "tracks", artistId, page: 1, pageSize, availableOnly: true }, { signal }),
    ]);
  }
  if (section === "favorites") return getLibraryFavorites({ signal });
  if (section === "home") {
    return Promise.all([
      fetchLibraryPage({
        kind: "albums",
        page: 1,
        pageSize,
        sort: "newest",
        // "Recently added" defers to the Lidarr "available only"
        // setting (omitted param) like the Albums/Artists tabs.
      }, { signal }),
      fetchLibraryPage({
        kind: "tracks",
        page: 1,
        pageSize: 12,
        sort: "newest",
        availableOnly: true,
      }, { signal }),
    ]);
  }
  return fetchLibraryPage({
    kind: tab,
    page: pageIndex,
    pageSize,
    query,
    genre,
    sort,
    direction,
    // Albums/artists defer to the Lidarr "available only" setting
    // (omitted param); tracks always filter to playable files.
    availableOnly: tab === "tracks" ? true : undefined,
  }, { signal });
};

export function libraryViewQueryOptions({
  preview = false,
  section = DEFAULT_LIBRARY_VIEW,
  albumId = null,
  artistId = null,
  pageIndex = 1,
  query = "",
  genre = "",
  sort = "name",
  direction = "asc",
} = {}) {
  const view = albumId || artistId
    ? { preview, albumId: albumId || null, artistId: albumId ? null : artistId || null }
    : { preview, section, pageIndex, query, genre, sort, direction };
  return queryOptions({
    queryKey: queryKeys.libraryView(view),
    enabled: !preview,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const nextData = await fetchLibraryView(view, signal);
      const pageResults = view.section === "favorites"
        ? [nextData?.library || EMPTY_LIBRARY]
        : Array.isArray(nextData) ? nextData : [nextData];
      const normalizedLibrary = view.section === "favorites"
        ? favoriteLibraryFromResponse(nextData)
        : normalizeLibraryPages(pageResults);
      const usePreview =
        import.meta.env.DEV &&
        pageResults.every((page) => Number(page?.total || 0) === 0) &&
        !view.query &&
        !view.genre &&
        normalizedLibrary.artists.length === 0 &&
        normalizedLibrary.albums.length === 0 &&
        normalizedLibrary.tracks.length === 0;
      return {
        nextData,
        pageResults,
        isPreview: usePreview,
        library: usePreview ? libraryPreviewData : normalizedLibrary,
        favoriteIds: usePreview
          ? new Set(libraryPreviewFavorites)
          : view.section === "favorites"
            ? favoriteIdsFromFavorites(nextData)
            : favoriteIdsFromPages(pageResults),
      };
    },
  });
}
