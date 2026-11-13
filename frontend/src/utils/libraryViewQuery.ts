import { queryOptions } from "@tanstack/react-query";
import {
  fetchLibraryPage,
  getLibraryPage,
  type LibraryPageResponse,
} from "./api/endpoints/library.ts";
import {
  favoriteId,
  normalizeLibraryPages,
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
} from "./libraryPageData.ts";
import {
  DEFAULT_LIBRARY_VIEW,
  LIBRARY_VIEWS,
  type LibraryViewId,
} from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
import { queryKeys } from "../queryClient.ts";
import {
  isLibraryStatus,
  LIBRARY_STATUSES,
  type LibraryStatus,
} from "../../../lib/libraryStatus.ts";
import type { SelectOption } from "../components/Select.tsx";

export const LIBRARY_PAGE_SIZE = 100;

const SORTS = [
  { value: "name", label: "Name" },
  { value: "artist", label: "Artist" },
  { value: "newest", label: "Recently added" },
  { value: "played", label: "Recently played" },
  { value: "plays", label: "Most played" },
  { value: "released", label: "Release date" },
] satisfies SelectOption<string>[];

const ARTIST_SORTS = SORTS.filter((sort) => sort.value !== "artist");

const LIBRARY_SORT_OPTIONS: Partial<Record<LibraryViewId, SelectOption<string>[]>> = {
  favorites: [{ value: "favorited", label: "Date favorited" }, ...SORTS],
  albums: SORTS,
  tracks: SORTS,
  artists: ARTIST_SORTS,
  "album-artists": ARTIST_SORTS,
  genres: SORTS.slice(0, 1),
};

export const librarySortOptions = (section: LibraryViewId) => LIBRARY_SORT_OPTIONS[section] ?? [];

export const libraryDefaultSort = (section: LibraryViewId) =>
  librarySortOptions(section)[0]?.value ?? "name";

export const LIBRARY_STATUS_LABELS = {
  monitored: "Monitored",
  unmonitored: "Not monitored",
  missing: "Missing tracks",
} satisfies Record<LibraryStatus, string>;

export const LIBRARY_STATUS_OPTIONS: SelectOption<"" | LibraryStatus>[] = [
  { value: "", label: "All statuses" },
  ...LIBRARY_STATUSES.map((value) => ({ value, label: LIBRARY_STATUS_LABELS[value] })),
];

const HOME_RAIL_SIZE = 20;
const ARTIST_TOP_TRACKS = 10;

export const HOME_ALBUM_RAILS = [
  { title: "Most played", sort: "plays", path: "/library/albums?sort=plays" },
  { title: "Explore", sort: "random", availableOnly: true },
  { title: "Recently added", sort: "newest", path: "/library/albums?sort=newest" },
  { title: "Recently played", sort: "played", path: "/library/albums?sort=played" },
  {
    title: "Recently released",
    sort: "released",
    availableOnly: true,
    path: "/library/albums?sort=released",
  },
] as const satisfies readonly {
  title: string;
  sort: string;
  availableOnly?: true;
  path?: string;
}[];

export const libraryListParams = (section: LibraryViewId, searchParams: URLSearchParams) => {
  const requestedSort = searchParams.get("sort");
  const requestedPage = Number(searchParams.get("page"));
  const requestedStatus = searchParams.get("status");
  return {
    sort:
      librarySortOptions(section).find((option) => option.value === requestedSort)?.value ??
      libraryDefaultSort(section),
    direction: searchParams.get("dir") === "desc" ? "desc" : "asc",
    pageIndex: Number.isSafeInteger(requestedPage) && requestedPage > 1 ? requestedPage : 1,
    artist: section === "tracks" ? searchParams.get("artist") || "" : "",
    status: section !== "genres" && isLibraryStatus(requestedStatus) ? requestedStatus : null,
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

type LibraryViewRequest = {
  section?: LibraryViewId;
  albumId?: string | null;
  artistId?: string | null;
  pageIndex?: number;
  query?: string;
  genre?: string;
  status?: LibraryStatus | null;
  artist?: string;
  sort?: string;
  direction?: string;
};

const fetchLibraryPages = async (
  {
    section,
    albumId,
    artistId,
    pageIndex,
    query,
    genre,
    status,
    artist,
    sort,
    direction,
  }: LibraryViewRequest,
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
      fetchLibraryPage(
        {
          kind: "tracks",
          artistId,
          page: 1,
          pageSize: ARTIST_TOP_TRACKS,
          sort: "plays",
          availableOnly: true,
        },
        { signal },
      ),
    ]);
  }
  if (section === "home") {
    return Promise.all([
      ...HOME_ALBUM_RAILS.map((rail) =>
        fetchLibraryPage(
          {
            kind: "albums",
            page: 1,
            pageSize: HOME_RAIL_SIZE,
            sort: rail.sort,
            availableOnly: "availableOnly" in rail ? rail.availableOnly : undefined,
          },
          { signal },
        ),
      ),
      fetchLibraryPage(
        { kind: "tracks", page: 1, pageSize: 12, sort: "newest", availableOnly: true },
        { signal },
      ),
    ]);
  }
  if (section === "favorites") {
    return Promise.all(
      (["artists", "albums", "tracks"] as const).map((kind) =>
        fetchLibraryPage(
          {
            kind,
            page: pageIndex,
            pageSize,
            query,
            genre,
            status,
            sort,
            direction,
            favorite: true,
            availableOnly: kind === "tracks" ? true : undefined,
          },
          { signal },
        ),
      ),
    );
  }
  return fetchLibraryPage(
    {
      kind: tab,
      page: pageIndex,
      pageSize,
      query,
      genre,
      status,
      artistId: artist || undefined,
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
  nextData?: LibraryPageResponse | LibraryPageResponse[];
  pageResults?: (LibraryPage & { total?: number })[];
  isPreview?: boolean;
  library?: LibraryViewLibrary;
  favoriteIds?: Set<string>;
};

const finishLibraryView = (
  {
    query,
    genre,
    status,
    artist,
  }: Pick<LibraryViewRequest, "query" | "genre" | "status" | "artist">,
  { nextData, pageResults, library, favoriteIds }: Required<Omit<LibraryViewData, "isPreview">>,
): LibraryViewData => {
  const usePreview =
    import.meta.env.DEV &&
    pageResults.every((page) => Number(page?.total || 0) === 0) &&
    !query &&
    !genre &&
    !status &&
    !artist &&
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
  status = null,
  artist = "",
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
  status?: LibraryStatus | null;
  artist?: string;
  sort?: string;
  direction?: string;
} = {}) {
  const view =
    albumId || artistId
      ? { preview, albumId: albumId || null, artistId: albumId ? null : artistId || null }
      : { preview, section, pageIndex, query, genre, status, artist, sort, direction };
  return queryOptions({
    queryKey: queryKeys.libraryView(view),
    enabled: !preview,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const [nextData, genres] = await Promise.all([
        fetchLibraryPages(view, signal),
        getLibraryPage({ kind: "genres", page: 1, pageSize: 1 }),
      ]);
      const pageResults = Array.isArray(nextData) ? nextData : [nextData];
      return finishLibraryView(view, {
        nextData,
        pageResults,
        library: normalizeLibraryPages([...pageResults, genres]),
        favoriteIds: favoriteIdsFromPages(pageResults),
      });
    },
  });
}
