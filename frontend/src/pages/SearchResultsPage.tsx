import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import type { ApiError } from "../utils/api/core.ts";
import { getApiErrorMessage, getApiErrorText } from "./onboardingUtils.tsx";
import {
  LIBRARY_LOOKUP_BATCH_SIZE,
  libraryLookupBatchQuery,
  lookupAlbumsInLibraryBatch,
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
  type ArtistsInLibrary,
} from "../utils/api/endpoints/library.ts";
import { parseResponse } from "hono/client";
import { staticPlaylistsClient } from "../utils/api/clients/staticPlaylists.ts";
import { DotLoader } from "../components/DotLoader";
import { SkeletonSearchResults, SkeletonStatus } from "../components/Skeletons";
import { getArtistCover, getReleaseGroupCover } from "../utils/api/endpoints/artists.ts";
import { searchCatalog, searchLibrary, searchUnified } from "../utils/api/endpoints/search.ts";
import SearchAlbumResults, { type SearchAlbum } from "../components/SearchAlbumResults";
import SearchArtistResults from "../components/SearchArtistResults";
import AddActionButton from "../components/AddActionButton";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import SearchMixedResultList, {
  type SearchImageMap,
  type SearchItem,
} from "../components/SearchMixedResultList";
import SearchTopResultCard from "../components/SearchTopArtistCard";
import { TrackPlaylistMenu } from "./ArtistDetails/components/TrackPlaylistMenu";
import {
  buildMixedSearchPageItems,
  buildSearchArtistResults,
  resolveSearchTopResult,
} from "../utils/searchNavigation";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { allReleaseTypes } from "./ArtistDetails/constants";
import { readReleaseListViewMode, writeReleaseListViewMode } from "./ArtistDetails/utils";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import type { ArtistFeedbackAction, ArtistFeedbackSource } from "../utils/artistTaste";
import { queryKeys } from "../queryClient.ts";
import { useStaticPlaylists } from "../hooks/useStaticPlaylists";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  describeAlbumRequestResult,
  getAlbumAddAction,
  isAlbumCompleteInLibrary,
  shouldTriggerAlbumSearch,
} from "../utils/albumAddAction";
import { buildAlbumRequestPayload } from "../utils/libraryDestination";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import {
  PAGE_SIZE,
  DEFAULT_ALBUM_SORT,
  ALBUM_PENDING_STATUSES,
  ALBUM_SORT_OPTIONS,
  ALBUM_RELEASE_TABS,
  UNIFIED_FILTER_OPTIONS,
  matchesAlbumReleaseTab,
  isAlbumSingleOrEp,
  dedupeArtists,
  dedupeAlbums,
  ARTIST_IMAGE_HYDRATION_CONCURRENCY,
  ALBUM_COVER_HYDRATION_CONCURRENCY,
} from "./searchPageUtils";
import { Navigate, useSearchParams } from "react-router";
import { RECOMMENDED_PATH, recommendedListPath } from "../navigation/recommendedPath.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Grid3X3, LayoutGrid, List, Music, Search, SlidersHorizontal } from "../components/icons";
import TooltipButton from "../components/TooltipButton";
import Tooltip from "../components/Tooltip";

type UnifiedSearchResponse = Awaited<ReturnType<typeof searchUnified>>;
type CatalogSearchPage = Awaited<ReturnType<typeof searchCatalog>>;
type SearchPage = UnifiedSearchResponse | CatalogSearchPage;
type SearchResultItem = SearchItem & {
  durationMs?: number | null;
  monitored?: boolean;
  ownerConflict?: { message: string };
};
type AlbumActionTarget = Pick<
  SearchResultItem,
  "id" | "title" | "artistMbid" | "artistName" | "inLibrary" | "monitored"
> & { status?: string | null };
const isAlbumListItem = (item: SearchResultItem): item is SearchResultItem & SearchAlbum =>
  typeof item.id === "string" && typeof item.title === "string";
type PlaylistTarget = { mode: "new"; name: string } | { mode: "existing"; playlistId: string };
type AlbumLibraryState =
  | boolean
  | {
      inLibrary?: boolean;
      managedBy?: string | null;
      libraryAlbumId?: string | number | null;
      libraryArtistId?: string | number | null;
      status?: string;
      monitored?: boolean;
      ownerConflict?: { message: string };
    };

const EMPTY_SEARCH_PAGES: SearchPage[] = [];
const combineLibraryLookup = (queries: { data?: ArtistsInLibrary }[]): ArtistsInLibrary =>
  Object.assign({}, ...queries.map((query) => query.data || {}));
const LIBRARY_RESULT_LIMIT = 6;

const getArtistName = (artist: SearchResultItem | null | undefined) =>
  String(artist?.name || "").trim();

function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type");
  const rawFilter = searchParams.get("filter") || "all";
  const activeFilter = rawFilter === "library" || rawFilter === "tracks" ? "all" : rawFilter;
  const [artistImages, setArtistImages] = useState<SearchImageMap>({});
  const [albumCovers, setAlbumCovers] = useState<SearchImageMap>({});
  const [albumLibraryLookup, setAlbumLibraryLookup] = useState<Record<string, AlbumLibraryState>>(
    {},
  );
  const [pendingAlbumIds, setPendingAlbumIds] = useState<Record<string, boolean>>({});
  const [albumOptionsOpen, setAlbumOptionsOpen] = useState(false);
  const [albumViewMode, setAlbumViewMode] = useState(() => readReleaseListViewMode());
  const [albumReleaseTab, setAlbumReleaseTab] = useState("all");
  const [tagFilterTerm, setTagFilterTerm] = useState("");
  const [tagViewMode, setTagViewMode] = useState(
    () => localStorage.getItem("libraryViewMode") || "grid",
  );
  const [tagGridColumns, setTagGridColumns] = useState(() => {
    const saved = parseInt(String(localStorage.getItem("libraryGridColumns")), 10);
    return saved >= 2 && saved <= 10 ? saved : 6;
  });
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const albumOptionsMenuRef = useRef<HTMLDivElement>(null);
  const { hasPermission } = useAuth();
  const { showSuccess, showError, showInfo } = useToast();
  const libraryDestination = useLibraryDestination();
  const { isAlbumDownloading } = useActiveDownloads();

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const normalizedType = useMemo(() => {
    if (type === "album") return "album";
    if (type === "tag" || trimmedQuery.startsWith("#")) return "tag";
    if (type === "artist") return "artist";
    return "unified";
  }, [type, trimmedQuery]);
  const isTagSearch = normalizedType === "tag";
  const isAlbumSearch = normalizedType === "album";
  const isUnifiedSearch = normalizedType === "unified" && !!trimmedQuery;
  const pageTitle = useMemo(() => {
    if (isTagSearch && trimmedQuery) {
      return trimmedQuery.startsWith("#") ? trimmedQuery : `#${trimmedQuery.replace(/^#/, "")}`;
    }
    if (isAlbumSearch) return trimmedQuery || "Album results";
    if (isUnifiedSearch) return trimmedQuery || "Search results";
    return trimmedQuery || "Search results";
  }, [isTagSearch, trimmedQuery, isAlbumSearch, isUnifiedSearch]);
  useDocumentTitle(pageTitle);
  const albumSort = searchParams.get("sort") || DEFAULT_ALBUM_SORT;
  const { lookup: artistFeedbackLookup, submitFeedback } = useArtistTasteFeedback();
  const canAddAlbum = hasPermission("addAlbum");
  const updateAlbumSort = useCallback(
    (nextSort: string) => {
      const params = new URLSearchParams(searchParams);
      if (nextSort === DEFAULT_ALBUM_SORT) {
        params.delete("sort");
      } else {
        params.set("sort", nextSort);
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  const updateUnifiedFilter = useCallback(
    (nextFilter: string) => {
      const params = new URLSearchParams(searchParams);
      if (!nextFilter || nextFilter === "all") {
        params.delete("filter");
      } else {
        params.set("filter", nextFilter);
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    if (!isAlbumSearch) return;
    setAlbumReleaseTab("all");
  }, [trimmedQuery, isAlbumSearch]);

  const searchQueryKey = useMemo(() => {
    if (isUnifiedSearch) {
      return queryKeys.searchUnified(trimmedQuery, "full", 20);
    }
    const searchTerm = isTagSearch ? trimmedQuery.replace(/^#/, "") : trimmedQuery;
    return queryKeys.searchCatalog(searchTerm, normalizedType, {
      limit: PAGE_SIZE,
      offset: 0,
      releaseTypes: isAlbumSearch ? allReleaseTypes : [],
      sort: isAlbumSearch ? albumSort : undefined,
    });
  }, [albumSort, isAlbumSearch, isTagSearch, isUnifiedSearch, normalizedType, trimmedQuery]);
  const searchQuery = useInfiniteQuery<
    SearchPage,
    ApiError,
    InfiniteData<SearchPage, number>,
    QueryKey,
    number
  >({
    queryKey: searchQueryKey,
    enabled: Boolean(trimmedQuery),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }): Promise<SearchPage> => {
      if (isUnifiedSearch) {
        return searchUnified(trimmedQuery, {
          mode: "full",
          limit: 20,
          signal,
        });
      }
      const searchTerm = isTagSearch ? trimmedQuery.replace(/^#/, "") : trimmedQuery;
      return searchCatalog(searchTerm, normalizedType, {
        limit: PAGE_SIZE,
        offset: pageParam,
        releaseTypes: isAlbumSearch ? allReleaseTypes : [],
        sort: isAlbumSearch ? albumSort : undefined,
        signal,
      });
    },
    getNextPageParam: (lastPage, pages) => {
      if (isUnifiedSearch) return undefined;
      const loaded = (pages as CatalogSearchPage[]).reduce(
        (count, page) => count + (page?.items?.length || 0),
        0,
      );
      const lastCatalogPage = lastPage as CatalogSearchPage;
      if (!lastCatalogPage?.items?.length) return undefined;
      if (
        !("hasMore" in lastCatalogPage && lastCatalogPage.hasMore) &&
        !(Number(lastCatalogPage?.count) > loaded)
      )
        return undefined;
      return loaded;
    },
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return previousKey &&
        searchQueryKey[1] !== "unified" &&
        previousKey[1] === searchQueryKey[1] &&
        previousKey[2] === searchQueryKey[2]
        ? previous
        : undefined;
    },
    staleTime: 30_000,
  });
  const searchUpdating = searchQuery.isPlaceholderData;

  const searchPages = searchQuery.data?.pages || EMPTY_SEARCH_PAGES;
  const rawUnifiedResults = isUnifiedSearch
    ? (searchPages[0] as UnifiedSearchResponse) || null
    : null;
  const rawResults = useMemo((): SearchResultItem[] => {
    const items: SearchResultItem[] = (searchPages as CatalogSearchPage[]).flatMap(
      (page): SearchResultItem[] => page?.items || [],
    );
    return isAlbumSearch ? dedupeAlbums(items) : dedupeArtists(items);
  }, [isAlbumSearch, searchPages]);
  const withAlbumLibraryState = useCallback(
    (album: SearchResultItem) => {
      const match = album?.id ? albumLibraryLookup[album.id] : null;
      return match && typeof match === "object" ? { ...album, ...match } : album;
    },
    [albumLibraryLookup],
  );
  const unifiedResults = useMemo(() => {
    if (!rawUnifiedResults) return null;
    return {
      ...rawUnifiedResults,
      top:
        rawUnifiedResults.top?.type === "album"
          ? withAlbumLibraryState(rawUnifiedResults.top)
          : rawUnifiedResults.top,
      catalog: rawUnifiedResults.catalog
        ? {
            ...rawUnifiedResults.catalog,
            albums: (rawUnifiedResults.catalog.albums || []).map(withAlbumLibraryState),
          }
        : rawUnifiedResults.catalog,
    };
  }, [rawUnifiedResults, withAlbumLibraryState]);
  const results = useMemo(
    () => (isAlbumSearch ? rawResults.map(withAlbumLibraryState) : rawResults),
    [isAlbumSearch, rawResults, withAlbumLibraryState],
  );
  const libraryLookupBatches = useMemo(() => {
    if (isAlbumSearch) return [];
    const ids = isUnifiedSearch
      ? (unifiedResults?.catalog?.artists || []).map((artist) => artist?.id)
      : results.map((artist) => getArtistRecordId(artist));
    const uniqueIds = [...new Set<string>(ids.filter((id): id is string => Boolean(id)))];
    const batches = [];
    for (let index = 0; index < uniqueIds.length; index += LIBRARY_LOOKUP_BATCH_SIZE) {
      batches.push(uniqueIds.slice(index, index + LIBRARY_LOOKUP_BATCH_SIZE));
    }
    return batches;
  }, [isAlbumSearch, isUnifiedSearch, results, unifiedResults]);
  const libraryLookup = useQueries({
    queries: libraryLookupBatches.map((ids) => libraryLookupBatchQuery(ids)),
    combine: combineLibraryLookup,
  });
  const librarySearchQuery = useQuery({
    queryKey: queryKeys.searchLibrary(trimmedQuery, LIBRARY_RESULT_LIMIT),
    enabled: isUnifiedSearch,
    queryFn: ({ signal }) => searchLibrary(trimmedQuery, { limit: LIBRARY_RESULT_LIMIT, signal }),
    staleTime: 30_000,
  });
  const libraryResults = isUnifiedSearch ? librarySearchQuery.data || null : null;
  const libraryItems = useMemo(
    () =>
      libraryResults
        ? [
            ...(libraryResults.artists || []),
            ...(libraryResults.albums || []),
            ...(libraryResults.tracks || []),
          ]
        : [],
    [libraryResults],
  );
  const loading = searchQuery.isLoading;
  const loadingMore = searchQuery.isFetchingNextPage;
  const { fetchNextPage } = searchQuery;
  const error = getApiErrorText(searchQuery.error, "message") || searchQuery.error?.message || null;
  const hasMore = !searchUpdating && searchQuery.hasNextPage === true;

  const albumResultsForTab = useMemo(() => {
    if (!isAlbumSearch) return results;
    return results.filter((album) => matchesAlbumReleaseTab(album, albumReleaseTab));
  }, [albumReleaseTab, isAlbumSearch, results]);

  const tagArtists = useMemo(() => {
    if (!isTagSearch) return [];
    const normalizedSearch = tagFilterTerm.trim().toLowerCase();
    return normalizedSearch
      ? results.filter((artist) => getArtistName(artist).toLowerCase().includes(normalizedSearch))
      : results;
  }, [isTagSearch, tagFilterTerm, results]);

  const displayedResults = isTagSearch ? tagArtists : isAlbumSearch ? albumResultsForTab : results;

  useEffect(() => {
    setAlbumLibraryLookup({});
    setPendingAlbumIds({});
    setAlbumCovers({});
  }, [searchQueryKey]);

  useEffect(() => {
    const artists: SearchItem[] = isUnifiedSearch
      ? unifiedResults?.catalog?.artists || []
      : isAlbumSearch
        ? []
        : results;
    const imagesMap: Record<string, string | null | undefined> = {};
    artists.forEach((artist) => {
      const artistId = getArtistRecordId(artist);
      if (artistId && (artist.image || artist.imageUrl)) {
        imagesMap[artistId] = artist.image || artist.imageUrl;
      }
    });
    setArtistImages(imagesMap);
  }, [isAlbumSearch, isUnifiedSearch, results, unifiedResults]);

  useEffect(() => {
    if (isAlbumSearch) return undefined;

    let cancelled = false;
    const artists: SearchItem[] = isUnifiedSearch
      ? [
          ...(libraryResults?.artists || []).filter(
            (artist) => String(artist.id) !== String(artist.canonicalId),
          ),
          ...buildSearchArtistResults(unifiedResults, {}),
        ]
      : displayedResults;

    if (!artists.length) {
      return undefined;
    }

    const seenArtistIds = new Set<string | number>();
    const pendingArtists = artists.filter((artist) => {
      const artistId = getArtistRecordId(artist);
      if (!artistId || seenArtistIds.has(artistId)) return false;
      seenArtistIds.add(artistId);
      if (artistImages[artistId] !== undefined) return false;
      if (artist.image || artist.imageUrl) return false;
      return true;
    });

    if (pendingArtists.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateArtistImages = async () => {
      for (
        let index = 0;
        index < pendingArtists.length && !cancelled;
        index += ARTIST_IMAGE_HYDRATION_CONCURRENCY
      ) {
        const batch = pendingArtists.slice(index, index + ARTIST_IMAGE_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(
            async (artist): Promise<[string | number | null | undefined, string | null]> => {
              const artistId = getArtistRecordId(artist);
              if (!artistId) return [null, null];
              const data = await getArtistCover(artistId, artist.name);
              const imageUrl = data?.images?.[0]?.image || null;
              return [artistId, imageUrl];
            },
          ),
        );
        if (cancelled) return;
        const nextBatch: Record<string, string | null> = {};
        batch.forEach((artist, batchIndex) => {
          const artistId = getArtistRecordId(artist);
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled" && artistId) {
            nextBatch[artistId] = entry.value?.[1] ?? null;
          } else if (artistId) {
            nextBatch[artistId] = null;
          }
        });
        if (Object.keys(nextBatch).length > 0) {
          setArtistImages((prev) => ({ ...prev, ...nextBatch }));
        }
      }
    };

    hydrateArtistImages();

    return () => {
      cancelled = true;
    };
  }, [
    artistImages,
    displayedResults,
    isAlbumSearch,
    isUnifiedSearch,
    libraryResults,
    unifiedResults,
  ]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults?.catalog?.albums?.length) {
      return undefined;
    }
    let cancelled = false;
    const albums = unifiedResults.catalog.albums.filter((album) => album?.id);
    const missingCoverIds = albums
      .filter((album) => !album.coverUrl)
      .map((album) => album.id)
      .filter((id): id is string => Boolean(id && albumCovers[id] === undefined));

    if (missingCoverIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateCovers = async () => {
      for (
        let index = 0;
        index < missingCoverIds.length && !cancelled;
        index += ALBUM_COVER_HYDRATION_CONCURRENCY
      ) {
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = albums.find((item) => item.id === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || "",
              albumTitle: album?.title || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch: Record<string, string | null> = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
        if (Object.keys(nextBatch).length > 0) {
          setAlbumCovers((prev) => ({
            ...prev,
            ...nextBatch,
          }));
        }
      }
    };

    hydrateCovers();

    return () => {
      cancelled = true;
    };
  }, [albumCovers, isUnifiedSearch, unifiedResults]);

  useEffect(() => {
    if (!libraryResults) {
      return undefined;
    }
    let cancelled = false;
    const tracks = libraryResults.tracks || [];
    const albums = libraryResults.albums || [];
    const missingCoverIds = [
      ...albums.map((album) => album?.id),
      ...tracks.map((track) => track?.albumMbid),
    ]
      .filter((albumMbid): albumMbid is string =>
        Boolean(albumMbid && albumCovers[albumMbid] === undefined),
      )
      .filter((albumMbid, index, list) => list.indexOf(albumMbid) === index);

    if (missingCoverIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateCovers = async () => {
      for (
        let index = 0;
        index < missingCoverIds.length && !cancelled;
        index += ALBUM_COVER_HYDRATION_CONCURRENCY
      ) {
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = albums.find((item) => item.id === id);
            const track = tracks.find((item) => item.albumMbid === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || track?.artistName || "",
              albumTitle: album?.title || track?.albumTitle || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch: Record<string, string | null> = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
        if (Object.keys(nextBatch).length > 0) {
          setAlbumCovers((prev) => ({
            ...prev,
            ...nextBatch,
          }));
        }
      }
    };

    hydrateCovers();

    return () => {
      cancelled = true;
    };
  }, [albumCovers, libraryResults]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults?.catalog?.albums?.length) {
      return undefined;
    }
    let cancelled = false;
    const missingAlbumIds = unifiedResults.catalog.albums.flatMap((album) =>
      typeof album?.id === "string" &&
      album.id &&
      !album.inLibrary &&
      albumLibraryLookup[album.id] === undefined
        ? [album.id]
        : [],
    );

    if (missingAlbumIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateLibraryStatus = async () => {
      try {
        const lookup = await lookupAlbumsInLibraryBatch(missingAlbumIds);
        if (cancelled || !lookup || typeof lookup !== "object") return;

        const resolvedLookup: Record<string, AlbumLibraryState> = {};
        for (const albumId of missingAlbumIds) {
          resolvedLookup[albumId] = lookup[albumId] || false;
        }

        setAlbumLibraryLookup((prev) => ({
          ...prev,
          ...resolvedLookup,
        }));
      } catch {
        if (!cancelled) {
          setAlbumLibraryLookup((prev) => {
            const next = { ...prev };
            for (const albumId of missingAlbumIds) {
              if (next[albumId] === undefined) {
                next[albumId] = false;
              }
            }
            return next;
          });
        }
      }
    };

    hydrateLibraryStatus();

    return () => {
      cancelled = true;
    };
  }, [albumLibraryLookup, isUnifiedSearch, unifiedResults]);

  useEffect(() => {
    if (!isAlbumSearch || results.length === 0) return undefined;
    let cancelled = false;
    const missingCoverIds = results
      .filter((album) => !album.coverUrl)
      .map((album) => album.id)
      .filter((id): id is string => Boolean(id && albumCovers[id] === undefined));

    if (missingCoverIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateCovers = async () => {
      for (
        let index = 0;
        index < missingCoverIds.length && !cancelled;
        index += ALBUM_COVER_HYDRATION_CONCURRENCY
      ) {
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = results.find((item) => item.id === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || "",
              albumTitle: album?.title || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch: Record<string, string | null> = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
        if (Object.keys(nextBatch).length > 0) {
          setAlbumCovers((prev) => ({
            ...prev,
            ...nextBatch,
          }));
        }
      }
    };

    hydrateCovers();

    return () => {
      cancelled = true;
    };
  }, [results, isAlbumSearch, albumCovers]);

  useEffect(() => {
    if (!isAlbumSearch || results.length === 0) return undefined;
    let cancelled = false;
    const missingAlbumIds = results.flatMap((album) =>
      typeof album?.id === "string" &&
      album.id &&
      !album.inLibrary &&
      albumLibraryLookup[album.id] === undefined
        ? [album.id]
        : [],
    );

    if (missingAlbumIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateLibraryStatus = async () => {
      try {
        const lookup = await lookupAlbumsInLibraryBatch(missingAlbumIds);
        if (cancelled || !lookup || typeof lookup !== "object") return;

        const resolvedLookup: Record<string, AlbumLibraryState> = {};
        for (const albumId of missingAlbumIds) {
          resolvedLookup[albumId] = lookup[albumId] || false;
        }

        setAlbumLibraryLookup((prev) => ({
          ...prev,
          ...resolvedLookup,
        }));
      } catch {
        if (!cancelled) {
          setAlbumLibraryLookup((prev) => {
            const next = { ...prev };
            for (const albumId of missingAlbumIds) {
              if (next[albumId] === undefined) {
                next[albumId] = false;
              }
            }
            return next;
          });
        }
      }
    };

    hydrateLibraryStatus();

    return () => {
      cancelled = true;
    };
  }, [results, isAlbumSearch, albumLibraryLookup]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;

    try {
      await fetchNextPage();
    } catch (err) {
      console.warn("Failed to load more search results:", err);
    }
  }, [hasMore, loading, loadingMore, fetchNextPage]);

  const onSentinel = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting) {
        loadMore();
      }
    },
    [loadMore],
  );

  const handleAlbumAction = useCallback(
    async (album: AlbumActionTarget, managedBy: string = libraryDestination.primary) => {
      if (!album?.id) return;
      const albumId = String(album.id);
      const shouldTriggerSearch = shouldTriggerAlbumSearch({
        status: album.status,
        inLibrary: album.inLibrary,
        monitored: album.monitored,
      });
      setPendingAlbumIds((prev) => ({ ...prev, [albumId]: true }));
      try {
        const result = await requestAlbumFromSearch(
          buildAlbumRequestPayload({
            albumMbid: albumId,
            albumName: album.title,
            artistMbid: album.artistMbid,
            artistName: album.artistName,
            managedBy,
            triggerSearch: shouldTriggerSearch,
          }),
        );
        const nextAlbum = {
          inLibrary: true,
          managedBy: result?.album?.managedBy || result?.managedBy || managedBy,
          libraryAlbumId: result.album?.id,
          libraryArtistId: result.artist?.id,
          status: result?.queued ? "processing" : result.status,
        };
        setAlbumLibraryLookup((prev) => ({
          ...prev,
          [albumId]: nextAlbum,
        }));
        const outcome = describeAlbumRequestResult(result, album.title);
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      } catch (err) {
        const conflict = settleLibraryOwnerConflict(err);
        if (conflict) {
          setAlbumLibraryLookup((prev) => ({
            ...prev,
            [albumId]: { ownerConflict: conflict },
          }));
          showInfo(`${album.title}: ${conflict.message}`);
          return;
        }
        showError(`Could not download the album: ${getApiErrorMessage(err, "Unknown error")}`);
      } finally {
        setPendingAlbumIds(({ [albumId]: _, ...prev }) => prev);
      }
    },
    [libraryDestination.primary, showError, showInfo, showSuccess],
  );

  const handleSearchTrackAdd = useCallback(
    async (track: SearchResultItem, target: PlaylistTarget) => {
      const payload = {
        artistName: track.artistName || "",
        trackName: track.title || "",
        albumName: track.albumTitle || "",
        artistMbid: track.artistMbid || "",
        albumMbid: track.albumMbid || "",
        trackMbid: track.trackMbid || "",
        releaseYear: track.releaseYear ? String(track.releaseYear) : null,
        durationMs:
          track.durationMs != null && Number.isFinite(Number(track.durationMs))
            ? Number(track.durationMs)
            : null,
        reason: null,
        artistAliases: [],
      };
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return;
      }
      const savingKey = String(track.id ?? track.trackMbid ?? "");
      setPlaylistModalError("");
      setPlaylistMenuSavingKey(savingKey);
      try {
        if (target?.mode === "new") {
          const name = String(target?.name || "").trim() || "Playlist";
          await parseResponse(
            staticPlaylistsClient["shared-playlists"].$post({
              json: {
                name,
                tracks: [payload],
              },
            }),
          );
          showSuccess(`Track saved to ${name}`);
        } else {
          const targetPlaylist = staticPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await parseResponse(
            staticPlaylistsClient["shared-playlists"][":playlistId"].tracks.$post({
              param: { playlistId: encodeURIComponent(target.playlistId) },
              json: {
                tracks: [payload],
              },
            }),
          );
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) {
          setStaticPlaylists(nextPlaylists);
        }
      } catch (err) {
        const message = getApiErrorMessage(err, "Failed to save track to playlist");
        setPlaylistModalError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [
      loadStaticPlaylists,
      setPlaylistModalError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const handleArtistFeedback = useCallback(
    (
      artist: ArtistFeedbackSource,
      action: ArtistFeedbackAction,
      options: Parameters<typeof submitFeedback>[2] = {},
    ) => submitFeedback(artist, action, options),
    [submitFeedback],
  );

  const isSearchResultInLibrary = useCallback(
    (item: SearchResultItem | null | undefined) => {
      if (!item) return false;
      if (item.type === "album") {
        return isAlbumCompleteInLibrary({ status: item.status });
      }
      if (item.inLibrary) return true;
      if (item.type === "artist") {
        const artistId = getArtistRecordId(item);
        return artistId ? !!libraryLookup[artistId] : false;
      }
      return false;
    },
    [libraryLookup],
  );

  const renderSearchResultAction = useCallback(
    (item: SearchResultItem | null | undefined) => {
      if (!item || item.type === "playlist") return null;

      if (item.type === "track") {
        const savingKey = String(
          item.id ?? item.trackMbid ?? `${item.artistName || ""}:${item.title || ""}`,
        );
        return (
          <TrackPlaylistMenu
            track={item}
            triggerLabel="Add to playlist"
            playlists={staticPlaylists}
            loading={playlistModalLoading}
            saving={playlistMenuSavingKey === savingKey}
            error={playlistModalError}
            defaultNewPlaylistName={`${item.artistName || "Artist"} Picks`}
            menuVariant="search-suggestion"
            onLoadPlaylists={loadStaticPlaylists}
            onSelect={(target: PlaylistTarget) => handleSearchTrackAdd(item, target)}
          />
        );
      }

      if (isSearchResultInLibrary(item)) {
        return <SearchLibraryCheck action />;
      }

      if (item.type === "album") {
        if (!canAddAlbum || !item.id) return null;
        const albumId = String(item.id);
        const pending = !!pendingAlbumIds[albumId] || isAlbumDownloading(albumId);
        return (
          <AddActionButton
            {...getAlbumAddAction(item, libraryDestination)}
            ownerConflict={item.ownerConflict}
            onAdd={(managedBy) => handleAlbumAction(item, managedBy)}
            isLoading={pending}
            loadingLabel="Downloading"
            disabled={pending || ALBUM_PENDING_STATUSES.has(item.status)}
          />
        );
      }

      return null;
    },
    [
      canAddAlbum,
      handleAlbumAction,
      isAlbumDownloading,
      libraryDestination,
      handleSearchTrackAdd,
      isSearchResultInLibrary,
      loadStaticPlaylists,
      pendingAlbumIds,
      playlistMenuSavingKey,
      playlistModalError,
      playlistModalLoading,
      staticPlaylists,
    ],
  );

  const searchListProps = useMemo(
    () => ({
      query: trimmedQuery,
      artistImages,
      albumCovers,
      renderAction: renderSearchResultAction,
    }),
    [albumCovers, artistImages, renderSearchResultAction, trimmedQuery],
  );

  const searchLibraryFlags = useMemo(() => {
    const artistIds = new Set(
      Object.entries(libraryLookup)
        .filter(([, inLibrary]) => inLibrary)
        .map(([id]) => id),
    );
    const albumIds = new Set<string | number>();
    for (const [albumId, entry] of Object.entries(albumLibraryLookup)) {
      if (entry && (entry === true || entry.inLibrary)) {
        albumIds.add(albumId);
      }
    }
    for (const album of unifiedResults?.catalog?.albums || []) {
      if (album?.id && album.inLibrary) {
        albumIds.add(album.id);
      }
    }
    return { artistIds, albumIds };
  }, [albumLibraryLookup, libraryLookup, unifiedResults]);

  const unifiedView = useMemo(() => {
    if (!isUnifiedSearch || !unifiedResults) {
      return {
        artistsWithId: [],
        albumsWithId: [],
        singlesWithId: [],
        tracks: [],
        libraryTracks: [],
        topResult: null,
        mixedItems: [],
        isEmpty: true,
      };
    }

    const artistsWithId = buildSearchArtistResults(unifiedResults, searchLibraryFlags);

    const albums = unifiedResults.catalog?.albums || [];
    const albumsWithId = dedupeAlbums(albums.filter(isAlbumListItem));

    const showArtists = activeFilter === "all" || activeFilter === "artists";
    const showAlbums = activeFilter === "all" || activeFilter === "albums";
    const showSingles = activeFilter === "all" || activeFilter === "singles";

    const visibleArtistsWithId = showArtists ? artistsWithId : [];
    const visibleAlbumsWithId = showAlbums
      ? albumsWithId.filter((album) => !isAlbumSingleOrEp(album))
      : [];
    const visibleSinglesWithId = showSingles ? albumsWithId.filter(isAlbumSingleOrEp) : [];

    const topResult =
      activeFilter === "all" ? resolveSearchTopResult(unifiedResults, searchLibraryFlags) : null;
    const mixedItems =
      activeFilter === "all"
        ? buildMixedSearchPageItems(unifiedResults, {
            limit: 24,
            excludeItem: topResult,
            libraryFlags: searchLibraryFlags,
          })
        : [];

    const isEmpty =
      activeFilter === "all"
        ? !topResult && mixedItems.length === 0
        : visibleArtistsWithId.length === 0 &&
          visibleAlbumsWithId.length === 0 &&
          visibleSinglesWithId.length === 0;

    return {
      artistsWithId: visibleArtistsWithId,
      albumsWithId: visibleAlbumsWithId,
      singlesWithId: visibleSinglesWithId,
      topResult,
      mixedItems,
      isEmpty,
    };
  }, [activeFilter, isUnifiedSearch, searchLibraryFlags, unifiedResults]);

  const showContent = !loading && query;
  const showLibraryResults = isUnifiedSearch && activeFilter === "all" && libraryItems.length > 0;
  const isEmpty = isUnifiedSearch
    ? unifiedView.isEmpty && !showLibraryResults
    : displayedResults.length === 0;
  const showLoadMore = hasMore && (isTagSearch || displayedResults.length >= PAGE_SIZE);

  useEffect(() => {
    if (!albumOptionsOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && albumOptionsMenuRef.current?.contains(event.target)) {
        return;
      }
      setAlbumOptionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [albumOptionsOpen]);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !showContent || isEmpty || !showLoadMore) return;
    const observer = new IntersectionObserver(onSentinel, {
      rootMargin: "200px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEmpty, onSentinel, showContent, showLoadMore]);

  const localSearchConfigured = unifiedResults?.localSearchConfigured !== false;

  const emptyMessage =
    isUnifiedSearch && !localSearchConfigured
      ? "Set up the metadata server in Settings → Metadata to search music."
      : isUnifiedSearch
        ? `No results for "${trimmedQuery}".`
        : isAlbumSearch
          ? `No albums for "${trimmedQuery}".`
          : isTagSearch
            ? `No results for #${trimmedQuery.replace(/^#/, "")}.`
            : `No results for "${trimmedQuery}".`;

  const emptyTitle = "No results found";

  const pageSubtitle =
    isUnifiedSearch && trimmedQuery
      ? "Artists, releases, and songs"
      : isTagSearch && trimmedQuery
        ? `Results for tag "${trimmedQuery.replace(/^#/, "")}"`
        : isAlbumSearch && trimmedQuery
          ? null
          : trimmedQuery
            ? `${displayedResults.length} results`
            : null;

  return (
    <div className="search-page">
      <header className="search-page__header">
        <div className="search-page__title-row">
          <h1 className="search-page__title">{pageTitle}</h1>
        </div>

        {pageSubtitle && (
          <div className="search-page__subtitle-row">
            <p className="search-page__subtitle">{pageSubtitle}</p>
          </div>
        )}

        {isTagSearch && (
          <div className="library-page__toolbar global-search">
            <div className="global-search__box">
              <div className="global-search__input-wrap">
                <Search className="global-search__icon" />
                <input
                  type="text"
                  value={tagFilterTerm}
                  onChange={(event) => setTagFilterTerm(event.target.value)}
                  placeholder=""
                  className="global-search__input"
                  autoComplete="off"
                  aria-label="Search results"
                />
                {!tagFilterTerm && (
                  <div className="global-search__placeholder">Search results...</div>
                )}
              </div>
            </div>

            <div className="library-page__view-controls">
              {tagViewMode === "grid" && (
                <Tooltip content={`${tagGridColumns} columns`}>
                  <input
                    type="range"
                    min="2"
                    max="10"
                    value={tagGridColumns}
                    onChange={(event) => {
                      const value = parseInt(event.target.value, 10);
                      setTagGridColumns(value);
                      localStorage.setItem("libraryGridColumns", String(value));
                    }}
                    className="library-page__grid-slider"
                    aria-label="Grid columns"
                  />
                </Tooltip>
              )}
              <TooltipButton
                type="button"
                onClick={() => {
                  const next = tagViewMode === "grid" ? "list" : "grid";
                  setTagViewMode(next);
                  localStorage.setItem("libraryViewMode", next);
                }}
                className="btn btn-icon-square library-page__view-toggle"
                aria-label={tagViewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
                title={tagViewMode === "grid" ? "List view" : "Grid view"}
              >
                {tagViewMode === "grid" ? (
                  <List className="artist-icon-sm" />
                ) : (
                  <LayoutGrid className="artist-icon-sm" />
                )}
              </TooltipButton>
            </div>
          </div>
        )}

        {isUnifiedSearch && trimmedQuery && (
          <div className="search-page__filters">
            {UNIFIED_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => updateUnifiedFilter(option.value)}
                className={`search-page__filter${
                  activeFilter === option.value ? " is-active" : ""
                }`}
                aria-pressed={activeFilter === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {isAlbumSearch && trimmedQuery && (
          <>
            <div className="artist-heading-row">
              <div className="artist-min-0">
                <div className="artist-tabs">
                  {ALBUM_RELEASE_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setAlbumReleaseTab(tab.value)}
                      className={`artist-tab${albumReleaseTab === tab.value ? " is-active" : ""}`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="artist-options" ref={albumOptionsMenuRef}>
                <TooltipButton
                  type="button"
                  onClick={() => setAlbumOptionsOpen((current) => !current)}
                  className="btn btn-surface btn-icon-square"
                  aria-label="Album search options"
                  title="Album search options"
                  aria-expanded={albumOptionsOpen}
                >
                  <SlidersHorizontal className="artist-icon-sm" />
                </TooltipButton>
                {albumOptionsOpen && (
                  <div className="artist-options-menu">
                    {ALBUM_SORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          updateAlbumSort(option.value);
                          setAlbumOptionsOpen(false);
                        }}
                        className={`artist-menu-item${albumSort === option.value ? " is-active" : ""}`}
                      >
                        <span>{option.label}</span>
                      </button>
                    ))}
                    <div className="artist-menu-section" />
                    <div className="artist-options-view-grid">
                      <TooltipButton
                        type="button"
                        onClick={() => {
                          setAlbumViewMode("grid");
                          writeReleaseListViewMode("grid");
                        }}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "grid" ? " is-active" : ""}`}
                        aria-label="Grid view"
                        title="Grid view"
                        aria-pressed={albumViewMode === "grid"}
                      >
                        <Grid3X3 className="artist-icon-sm" />
                      </TooltipButton>
                      <TooltipButton
                        type="button"
                        onClick={() => {
                          setAlbumViewMode("list");
                          writeReleaseListViewMode("list");
                        }}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "list" ? " is-active" : ""}`}
                        aria-label="List view"
                        title="List view"
                        aria-pressed={albumViewMode === "list"}
                      >
                        <List className="artist-icon-sm" />
                      </TooltipButton>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="artist-count">
              {displayedResults.length.toLocaleString()} release
              {displayedResults.length === 1 ? "" : "s"}
            </div>
          </>
        )}
      </header>

      {showLibraryResults && (
        <section className="search-page__section" aria-labelledby="search-library-heading">
          <h2 id="search-library-heading" className="search-page__section-title">
            Your library
          </h2>
          <SearchMixedResultList items={libraryItems} {...searchListProps} />
        </section>
      )}

      {showLibraryResults && (loading || !unifiedView.isEmpty || error) && (
        <h2 className="search-page__section-title">Discover</h2>
      )}

      {error && (
        <div className="artist-error-panel" role="alert">
          <p className="artist-error-text">{error}</p>
        </div>
      )}

      {loading && (
        <SkeletonStatus label="Loading results">
          <SkeletonSearchResults
            mode={
              isUnifiedSearch
                ? ({ all: "all", artists: "round-artists" } as const)[activeFilter] || "albums"
                : isAlbumSearch
                  ? "albums"
                  : isTagSearch && tagViewMode === "list"
                    ? "artist-list"
                    : "artists"
            }
            gridColumns={isTagSearch && tagViewMode === "grid" ? tagGridColumns : undefined}
          />
        </SkeletonStatus>
      )}

      {showContent && (
        <div
          className={searchUpdating ? "query-pending" : undefined}
          aria-busy={searchUpdating || undefined}
        >
          {isEmpty ? (
            <div className="search-empty-panel">
              <div className="search-empty-panel__icon" aria-hidden="true">
                <Music className="artist-icon-lg" />
              </div>
              <h2 className="search-empty-panel__title">{emptyTitle}</h2>
              <p className="search-empty-panel__message">{emptyMessage}</p>
            </div>
          ) : (
            <>
              {isUnifiedSearch ? (
                <div className="search-page__unified">
                  {activeFilter === "all" && (
                    <>
                      {unifiedView.topResult && (
                        <SearchTopResultCard
                          item={unifiedView.topResult}
                          artistImages={artistImages}
                          albumCovers={albumCovers}
                          libraryLookup={libraryLookup}
                          query={trimmedQuery}
                        />
                      )}
                      {unifiedView.mixedItems.length > 0 && (
                        <SearchMixedResultList
                          items={unifiedView.mixedItems}
                          {...searchListProps}
                        />
                      )}
                    </>
                  )}

                  {activeFilter === "singles" && unifiedView.singlesWithId.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.singlesWithId}
                      albumCovers={albumCovers}
                      canAddAlbum={canAddAlbum}
                      pendingAlbumIds={pendingAlbumIds}
                      onAlbumAction={handleAlbumAction}
                      libraryDestination={libraryDestination}
                      viewMode="grid"
                    />
                  )}

                  {activeFilter === "artists" && unifiedView.artistsWithId.length > 0 && (
                    <SearchArtistResults
                      artists={unifiedView.artistsWithId}
                      artistImages={artistImages}
                      libraryLookup={libraryLookup}
                      onArtistFeedback={handleArtistFeedback}
                      artistFeedbackLookup={artistFeedbackLookup}
                      variant="round"
                    />
                  )}

                  {activeFilter === "albums" && unifiedView.albumsWithId.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.albumsWithId}
                      albumCovers={albumCovers}
                      canAddAlbum={canAddAlbum}
                      pendingAlbumIds={pendingAlbumIds}
                      onAlbumAction={handleAlbumAction}
                      libraryDestination={libraryDestination}
                      viewMode="grid"
                    />
                  )}
                </div>
              ) : isAlbumSearch ? (
                <SearchAlbumResults
                  albums={displayedResults.filter(isAlbumListItem)}
                  albumCovers={albumCovers}
                  canAddAlbum={canAddAlbum}
                  pendingAlbumIds={pendingAlbumIds}
                  onAlbumAction={handleAlbumAction}
                  libraryDestination={libraryDestination}
                  viewMode={albumViewMode}
                />
              ) : (
                <SearchArtistResults
                  artists={displayedResults}
                  artistImages={artistImages}
                  libraryLookup={libraryLookup}
                  onArtistFeedback={handleArtistFeedback}
                  artistFeedbackLookup={artistFeedbackLookup}
                  variant={isTagSearch ? tagViewMode : "square"}
                  gridColumns={isTagSearch && tagViewMode === "grid" ? tagGridColumns : undefined}
                />
              )}

              {showLoadMore && (
                <div ref={sentinelRef} className="search-load-more">
                  <span className="search-load-more__inner">
                    <DotLoader size="xl" label={null} />
                    Loading...
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchResultsPage() {
  const [searchParams] = useSearchParams();
  const type = searchParams.get("type");
  if (type === "trending") return <Navigate to="/discover/trending" replace />;
  if (type === "recommended") {
    const tag = searchParams.get("tag");
    return <Navigate to={tag ? recommendedListPath({ genre: tag }) : RECOMMENDED_PATH} replace />;
  }
  return <SearchResults />;
}
