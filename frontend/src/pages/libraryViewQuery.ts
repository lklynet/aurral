import { queryOptions } from "@tanstack/react-query";
import {
  fetchLibraryPage,
  getLibraryFavorites,
  type LibraryFavoritesResponse,
  type LibraryPageResponse,
} from "../utils/api/endpoints/library.ts";
import {
  EMPTY_LIBRARY,
  favoriteId,
  favoriteLibraryFromResponse,
  normalizeLibraryPages,
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
} from "../utils/libraryPageData.ts";
import {
  DEFAULT_LIBRARY_VIEW,
  LIBRARY_VIEWS,
  type LibraryViewId,
} from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
import { queryKeys } from "../queryClient.ts";

export const LIBRARY_PAGE_SIZE = 100;
export const LIBRARY_DEFAULT_SORT = "name";

const NAME_SORT = { value: LIBRARY_DEFAULT_SORT, label: "Name" };
const ARTIST_SORT = { value: "artist", label: "Artist" };
const NEWEST_SORT = { value: "newest", label: "Recently added" };

export const LIBRARY_SORT_OPTIONS: Partial<Record<LibraryViewId, (typeof NAME_SORT)[]>> = {
  albums: [NAME_SORT, ARTIST_SORT, NEWEST_SORT],
  tracks: [NAME_SORT, ARTIST_SORT, NEWEST_SORT],
  artists: [NAME_SORT, NEWEST_SORT],
  "album-artists": [NAME_SORT, NEWEST_SORT],
  genres: [NAME_SORT],
};

export const libraryListParams = (section: LibraryViewId, searchParams: URLSearchParams) => {
  const requestedSort = searchParams.get("sort");
  const requestedPage = Number(searchParams.get("page"));
  return {
    sort: (LIBRARY_SORT_OPTIONS[section] || []).some((option) => option.value === requestedSort)
      ? requestedSort!
      : LIBRARY_DEFAULT_SORT,
    direction: searchParams.get("dir") === "desc" ? "desc" : "asc",
    pageIndex: Number.isSafeInteger(requestedPage) && requestedPage > 1 ? requestedPage : 1,
  };
};

const LIBRARY_VIEW_IDS = new Set<string | undefined>(LIBRARY_VIEWS.map((view) => view.id));

const isLibraryViewId = (value: string | undefined): value is LibraryViewId =>
  LIBRARY_VIEW_IDS.has(value);

export const resolveLibrarySection = (routeSection: string | undefined): LibraryViewId =>
  isLibraryViewId(routeSection) ? routeSection : DEFAULT_LIBRARY_VIEW;

export const libraryTabForSection = (section: LibraryViewId | undefined) =>
  section === "home" || section === "album-artists" ? "artists" : section;

type LibraryPage = Parameters<typeof normalizeLibraryPages>[0][number];
type LibraryEntity = LibraryArtist | LibraryAlbum | LibraryTrack;

const favoriteIdsFromPages = (pages: LibraryPage[]) =>
  new Set(
    (["artists", "albums", "tracks"] as const).flatMap((kind) =>
      pages
        .flatMap((page): LibraryEntity[] => (Array.isArray(page?.[kind]) ? page[kind] : []))
        .filter((entity) => entity.userFavorite)
        .map((entity) =>
          favoriteId(kind === "artists" ? "artist" : kind === "albums" ? "album" : "song", entity),
        ),
    ),
  );

const favoriteIdsFromFavorites = (favorites: LibraryFavoritesResponse) =>
  new Set(
    (["artist", "album", "song"] as const).flatMap((kind) =>
      (Array.isArray(favorites?.[kind]) ? favorites[kind] : []).map((entry) => entry.id),
    ),
  );

type LibraryViewRequest = {
  section?: LibraryViewId;
  albumId?: string | null;
  artistId?: string | null;
  pageIndex?: number;
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
};

const fetchLibraryPages = async (
  { section, albumId, artistId, pageIndex, query, genre, sort, direction }: LibraryViewRequest,
  signal: AbortSignal,
) => {
  const tab = libraryTabForSection(section);
  const pageSize = LIBRARY_PAGE_SIZE;
  if (albumId) {
    return fetchLibraryPage(
      {
        kind: "tracks",
        albumId,
        page: 1,
        pageSize,
        // An album detail view shows the full tracklist; owned/missing is
        // shown per row.
        availableOnly: false,
      },
      { signal },
    );
  }
  if (artistId) {
    return Promise.all([
      fetchLibraryPage({ kind: "albums", artistId, page: 1, pageSize }, { signal }),
      fetchLibraryPage(
        { kind: "tracks", artistId, page: 1, pageSize, availableOnly: true },
        { signal },
      ),
    ]);
  }
  if (section === "home") {
    return Promise.all([
      fetchLibraryPage(
        {
          kind: "albums",
          page: 1,
          pageSize,
          sort: "newest",
        },
        { signal },
      ),
      fetchLibraryPage(
        {
          kind: "tracks",
          page: 1,
          pageSize: 12,
          sort: "newest",
          availableOnly: true,
        },
        { signal },
      ),
    ]);
  }
  return fetchLibraryPage(
    {
      kind: tab,
      page: pageIndex,
      pageSize,
      query,
      genre,
      sort,
      direction,
      // Albums and artists omit the param, so the server shows what can be
      // played and what Aurral is fetching; tracks show playable files.
      availableOnly: tab === "tracks" ? true : undefined,
    },
    { signal },
  );
};

export type LibraryViewLibrary = ReturnType<typeof normalizeLibraryPages>;

export type LibraryViewData = {
  nextData?: LibraryPageResponse | LibraryPageResponse[] | LibraryFavoritesResponse;
  pageResults?: (LibraryPage & { total?: number })[];
  isPreview?: boolean;
  library?: LibraryViewLibrary;
  favoriteIds?: Set<string>;
};

const finishLibraryView = (
  { query, genre }: Pick<LibraryViewRequest, "query" | "genre">,
  { nextData, pageResults, library, favoriteIds }: Required<Omit<LibraryViewData, "isPreview">>,
): LibraryViewData => {
  const usePreview =
    import.meta.env.DEV &&
    pageResults.every((page) => Number(page?.total || 0) === 0) &&
    !query &&
    !genre &&
    library.artists.length === 0 &&
    library.albums.length === 0 &&
    library.tracks.length === 0;
  return {
    nextData,
    pageResults,
    isPreview: usePreview,
    library: usePreview ? libraryPreviewData : library,
    favoriteIds: usePreview ? new Set(libraryPreviewFavorites) : favoriteIds,
  };
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
}: {
  preview?: boolean;
  section?: LibraryViewId;
  albumId?: string | null;
  artistId?: string | null;
  pageIndex?: number;
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
} = {}) {
  const view =
    albumId || artistId
      ? { preview, albumId: albumId || null, artistId: albumId ? null : artistId || null }
      : { preview, section, pageIndex, query, genre, sort, direction };
  return queryOptions({
    queryKey: queryKeys.libraryView(view),
    enabled: !preview,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      if (view.section === "favorites") {
        const favorites = await getLibraryFavorites({ signal });
        return finishLibraryView(view, {
          nextData: favorites,
          pageResults: [favorites?.library || EMPTY_LIBRARY],
          library: favoriteLibraryFromResponse(favorites),
          favoriteIds: favoriteIdsFromFavorites(favorites),
        });
      }
      const nextData = await fetchLibraryPages(view, signal);
      const pageResults = Array.isArray(nextData) ? nextData : [nextData];
      return finishLibraryView(view, {
        nextData,
        pageResults,
        library: normalizeLibraryPages(pageResults),
        favoriteIds: favoriteIdsFromPages(pageResults),
      });
    },
  });
}
