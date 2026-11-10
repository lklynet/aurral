import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import type { ApiError } from "../utils/api/core.ts";
import { getApiErrorMessage, getApiErrorText } from "../utils/api/errors.ts";
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
import { getReleaseGroupCoversBatch } from "../utils/api/endpoints/artists.ts";
import {
  librarySearchQuery,
  playlistSearchQuery,
  searchCatalog,
  unifiedSearchQuery,
} from "../utils/api/endpoints/search.ts";
import SearchAlbumResults, { type SearchAlbum } from "../components/SearchAlbumResults";
import SearchArtistResults from "../components/SearchArtistResults";
import AddActionButton from "../components/AddActionButton";
import ReleaseWaitBadge from "../components/ReleaseWaitBadge";
import { isAwaitingRelease } from "../utils/aurralAlbumStatus.ts";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import SearchMixedResultList, {
  type SearchImageMap,
  type SearchItem,
} from "../components/SearchMixedResultList";
import SearchTopResultCard from "../components/SearchTopArtistCard";
import SearchPlaylistShelf from "../components/SearchPlaylistShelf";
import { TrackPlaylistMenu } from "../components/TrackPlaylistMenu";
import { buildMixedSearchPageItems } from "../utils/searchNavigation";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { allReleaseTypes } from "./ArtistDetails/constants";
import { readReleaseListViewMode, writeReleaseListViewMode } from "./ArtistDetails/utils";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { useBlockedGenres } from "../hooks/useBlockedGenres";
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
} from "./searchPageUtils";
import { Navigate, useSearchParams } from "react-router";
import { RECOMMENDED_PATH, recommendedListPath } from "../navigation/recommendedPath.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  Ban,
  Grid3X3,
  LayoutGrid,
  List,
  MoreVertical,
  Music,
  Search,
  SlidersHorizontal,
  AlertCircle,
} from "../components/icons";
import TooltipButton from "../components/TooltipButton";
import Tooltip from "../components/Tooltip";
import StatePanel from "../components/StatePanel";

type CatalogSearchPage = Awaited<ReturnType<typeof searchCatalog>>;
type SearchResultItem = SearchItem & {
  durationMs?: number | null;
  monitored?: boolean;
  managedBy?: string | null;
  trackFileCount?: number;
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
      providerAlbumId?: string | null;
      providerArtistId?: string | null;
      status?: string;
      monitored?: boolean;
      trackFileCount?: number;
      releaseDate?: string;
      ownerConflict?: { message: string };
    };

const EMPTY_SEARCH_PAGES: CatalogSearchPage[] = [];
const EMPTY_COVERS: SearchImageMap = {};
const combineLibraryLookup = (queries: { data?: ArtistsInLibrary }[]): ArtistsInLibrary =>
  queries.reduce<ArtistsInLibrary>((merged, query) => ({ ...merged, ...query.data }), {});
const toCoverMap = (covers: Awaited<ReturnType<typeof getReleaseGroupCoversBatch>>) =>
  Object.fromEntries(
    Object.entries(covers).map(([mbid, cover]): [string, string | null] => [
      mbid,
      cover?.image || null,
    ]),
  );
const LIBRARY_RESULT_LIMIT = 6;
const UNIFIED_RESULT_LIMIT = 20;
const CATALOG_UNAVAILABLE = "The metadata server did not answer. Try again in a moment.";
const PLAYLISTS_UNAVAILABLE = "Deezer did not answer. Try again in a moment.";

const getArtistName = (artist: SearchResultItem | null | undefined) =>
  String(artist?.name || "").trim();

function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type");
  const rawFilter = searchParams.get("filter") || "all";
  const activeFilter = rawFilter === "library" || rawFilter === "tracks" ? "all" : rawFilter;
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
  const isPlaylistTab = isUnifiedSearch && activeFilter === "playlists";
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
  const { isGenreBlocked, setGenreBlocked, pendingGenre } = useBlockedGenres();
  const tagName = isTagSearch ? trimmedQuery.replace(/^#/, "").trim() : "";
  const tagBlocked = tagName ? isGenreBlocked(tagName) : false;
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
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

  const playlistTabPath = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    params.set("filter", "playlists");
    return `/search?${params}`;
  }, [searchParams]);

  useEffect(() => {
    if (!isAlbumSearch) return;
    setAlbumReleaseTab("all");
  }, [trimmedQuery, isAlbumSearch]);

  const catalogQueryKey = useMemo(() => {
    const searchTerm = isTagSearch ? trimmedQuery.replace(/^#/, "") : trimmedQuery;
    return queryKeys.searchCatalog(searchTerm, normalizedType, {
      limit: PAGE_SIZE,
      offset: 0,
      releaseTypes: isAlbumSearch ? allReleaseTypes : [],
      sort: isAlbumSearch ? albumSort : undefined,
    });
  }, [albumSort, isAlbumSearch, isTagSearch, normalizedType, trimmedQuery]);
  const unifiedQuery = useQuery({
    ...unifiedSearchQuery(trimmedQuery, UNIFIED_RESULT_LIMIT),
    enabled: isUnifiedSearch,
  });
  const catalogQuery = useInfiniteQuery<
    CatalogSearchPage,
    ApiError,
    InfiniteData<CatalogSearchPage, number>,
    QueryKey,
    number
  >({
    queryKey: catalogQueryKey,
    enabled: Boolean(trimmedQuery) && !isUnifiedSearch,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
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
      const loaded = pages.reduce((count, page) => count + (page?.items?.length || 0), 0);
      if (!lastPage?.items?.length) return undefined;
      if (!("hasMore" in lastPage && lastPage.hasMore) && !(Number(lastPage?.count) > loaded))
        return undefined;
      return loaded;
    },
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return previousKey &&
        previousKey[1] === catalogQueryKey[1] &&
        previousKey[2] === catalogQueryKey[2]
        ? previous
        : undefined;
    },
    staleTime: 30_000,
  });
  const activeQuery = isUnifiedSearch ? unifiedQuery : catalogQuery;
  const searchUpdating = !isUnifiedSearch && catalogQuery.isPlaceholderData;

  const searchPages = catalogQuery.data?.pages || EMPTY_SEARCH_PAGES;
  const rawUnifiedResults = isUnifiedSearch ? unifiedQuery.data || null : null;
  const catalogUnavailable = rawUnifiedResults?.status === "unavailable";
  const rawResults = useMemo((): SearchResultItem[] => {
    if (isUnifiedSearch) return [];
    const items: SearchResultItem[] = searchPages.flatMap(
      (page): SearchResultItem[] => page?.items || [],
    );
    return isAlbumSearch ? dedupeAlbums(items) : dedupeArtists(items);
  }, [isAlbumSearch, isUnifiedSearch, searchPages]);
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
      albums: rawUnifiedResults.albums.map(withAlbumLibraryState),
    };
  }, [rawUnifiedResults, withAlbumLibraryState]);
  const results = useMemo(
    () => (isAlbumSearch ? rawResults.map(withAlbumLibraryState) : rawResults),
    [isAlbumSearch, rawResults, withAlbumLibraryState],
  );
  const libraryLookupBatches = useMemo(() => {
    if (isAlbumSearch || isUnifiedSearch) return [];
    const ids = results.map((artist) => getArtistRecordId(artist));
    const uniqueIds = [...new Set<string>(ids.filter((id): id is string => Boolean(id)))];
    const batches = [];
    for (let index = 0; index < uniqueIds.length; index += LIBRARY_LOOKUP_BATCH_SIZE) {
      batches.push(uniqueIds.slice(index, index + LIBRARY_LOOKUP_BATCH_SIZE));
    }
    return batches;
  }, [isAlbumSearch, isUnifiedSearch, results]);
  const catalogLibraryLookup = useQueries({
    queries: libraryLookupBatches.map((ids) => libraryLookupBatchQuery(ids)),
    combine: combineLibraryLookup,
  });
  const libraryLookup = useMemo<ArtistsInLibrary>(
    () =>
      rawUnifiedResults
        ? Object.fromEntries(
            rawUnifiedResults.artists.map((artist) => [artist.id, artist.inLibrary]),
          )
        : catalogLibraryLookup,
    [catalogLibraryLookup, rawUnifiedResults],
  );
  const libraryQuery = useQuery({
    ...librarySearchQuery(trimmedQuery, LIBRARY_RESULT_LIMIT),
    enabled: isUnifiedSearch,
  });
  const libraryResults = isUnifiedSearch ? libraryQuery.data || null : null;
  const libraryItems = useMemo(
    () =>
      libraryResults
        ? [...libraryResults.artists, ...libraryResults.albums, ...libraryResults.tracks]
        : [],
    [libraryResults],
  );
  const playlistsQuery = useQuery({
    ...playlistSearchQuery(trimmedQuery),
    enabled: isUnifiedSearch && (activeFilter === "all" || isPlaylistTab),
  });
  const playlistItems = useMemo(
    () => [...(libraryResults?.playlists ?? []), ...(playlistsQuery.data?.playlists ?? [])],
    [libraryResults, playlistsQuery.data],
  );
  const loading = isPlaylistTab
    ? libraryQuery.isLoading || playlistsQuery.isLoading
    : activeQuery.isLoading;
  const loadingMore = catalogQuery.isFetchingNextPage;
  const { fetchNextPage } = catalogQuery;
  const error = isPlaylistTab
    ? playlistsQuery.isError && playlistItems.length === 0
      ? PLAYLISTS_UNAVAILABLE
      : null
    : getApiErrorText(activeQuery.error, "message") ||
      activeQuery.error?.message ||
      (catalogUnavailable ? CATALOG_UNAVAILABLE : null);
  const hasMore = !searchUpdating && catalogQuery.hasNextPage === true;

  const coverRequests = useMemo(() => {
    const albums: SearchResultItem[] = rawUnifiedResults
      ? [rawUnifiedResults.top, ...rawUnifiedResults.albums].filter(
          (item): item is NonNullable<typeof item> => item?.type === "album",
        )
      : isAlbumSearch
        ? rawResults
        : [];
    const seen = new Set<string>();
    return albums.flatMap((album) => {
      const mbid = typeof album.id === "string" ? album.id : "";
      if (!mbid || album.coverUrl || seen.has(mbid)) return [];
      seen.add(mbid);
      return [{ mbid, artistName: album.artistName, albumTitle: album.title }];
    });
  }, [isAlbumSearch, rawResults, rawUnifiedResults]);
  const coversQuery = useQuery({
    queryKey: queryKeys.searchCovers(coverRequests.map((item) => item.mbid)),
    queryFn: () => getReleaseGroupCoversBatch(coverRequests),
    enabled: coverRequests.length > 0,
    select: toCoverMap,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const albumCovers = coversQuery.data ?? EMPTY_COVERS;

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
  }, [catalogQueryKey]);

  const statusAlbums = rawUnifiedResults?.albums ?? (isAlbumSearch ? rawResults : null);
  useEffect(() => {
    if (!statusAlbums?.length) return undefined;
    let cancelled = false;
    const missingAlbumIds = statusAlbums.flatMap((album) =>
      typeof album?.id === "string" &&
      album.id &&
      !album.inLibrary &&
      albumLibraryLookup[album.id] === undefined
        ? [album.id]
        : [],
    );

    if (missingAlbumIds.length === 0) return undefined;

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
  }, [albumLibraryLookup, statusAlbums]);

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
            staticPlaylistsClient["static-playlists"].$post({
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
            staticPlaylistsClient["static-playlists"][":playlistId"].tracks.$post({
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
        if (isAwaitingRelease(item)) return <ReleaseWaitBadge releaseDate={item.releaseDate} />;
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
      albumCovers,
      renderAction: renderSearchResultAction,
    }),
    [albumCovers, renderSearchResultAction, trimmedQuery],
  );

  const unifiedView = useMemo(() => {
    if (!unifiedResults) {
      return {
        artists: [],
        albums: [],
        singles: [],
        topResult: null,
        mixedItems: [],
        isEmpty: true,
      };
    }
    const releases = dedupeAlbums(unifiedResults.albums.filter(isAlbumListItem));
    const artists = activeFilter === "artists" ? unifiedResults.artists : [];
    const albums =
      activeFilter === "albums" ? releases.filter((album) => !isAlbumSingleOrEp(album)) : [];
    const singles = activeFilter === "singles" ? releases.filter(isAlbumSingleOrEp) : [];
    const topResult = activeFilter === "all" ? unifiedResults.top : null;
    const mixedItems = activeFilter === "all" ? buildMixedSearchPageItems(unifiedResults, 24) : [];
    const isEmpty =
      activeFilter === "all"
        ? !topResult && mixedItems.length === 0
        : artists.length === 0 && albums.length === 0 && singles.length === 0;
    return { artists, albums, singles, topResult, mixedItems, isEmpty };
  }, [activeFilter, unifiedResults]);
  const showContent = !loading && query;
  const showLibraryResults = isUnifiedSearch && activeFilter === "all" && libraryItems.length > 0;
  const showPlaylists =
    isUnifiedSearch && (activeFilter === "all" || isPlaylistTab) && playlistItems.length > 0;
  const isEmpty = isUnifiedSearch
    ? unifiedView.isEmpty && !showLibraryResults && !showPlaylists
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

  const emptyMessage = isAlbumSearch
    ? `No albums for "${trimmedQuery}".`
    : isTagSearch
      ? `No results for #${trimmedQuery.replace(/^#/, "")}.`
      : `No results for "${trimmedQuery}".`;

  const emptyTitle = "No results found";

  const pageSubtitle =
    isUnifiedSearch && trimmedQuery
      ? "Artists, releases, songs, and playlists"
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
          {tagBlocked ? (
            <span className="search-page__genre-blocked">
              <Ban aria-hidden="true" />
              Blocked
            </span>
          ) : null}
          {tagName ? (
            <div className="artist-relative search-page__genre-menu">
              <TooltipButton
                type="button"
                onClick={() => setGenreMenuOpen((open) => !open)}
                className="btn btn-surface btn-icon-square"
                aria-label="More genre actions"
                title="More genre actions"
                aria-expanded={genreMenuOpen}
              >
                {pendingGenre === tagName ? (
                  <DotLoader size="sm" label={null} />
                ) : (
                  <MoreVertical className="artist-icon-md" />
                )}
              </TooltipButton>
              {genreMenuOpen ? (
                <>
                  <button
                    type="button"
                    className="artist-backdrop-button"
                    onClick={() => setGenreMenuOpen(false)}
                    aria-label="Close genre actions"
                  />
                  <div className="artist-dropdown artist-dropdown--right">
                    <button
                      type="button"
                      onClick={() => {
                        setGenreMenuOpen(false);
                        void setGenreBlocked(tagName, !tagBlocked);
                      }}
                      disabled={pendingGenre === tagName}
                      className="artist-menu-item artist-menu-item--danger"
                    >
                      <span className="artist-menu-item__main">
                        <Ban className="artist-icon-sm" />
                        {tagBlocked ? "Unblock genre" : "Block genre"}
                      </span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
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
                    <div className="native-library-item-menu__separator" role="separator" />
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
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load results"
          message={error}
        />
      )}

      {loading && (
        <SkeletonStatus label="Loading results">
          <SkeletonSearchResults
            mode={
              isUnifiedSearch
                ? ({ all: "all", artists: "round-artists", playlists: "artist-list" } as const)[
                    activeFilter
                  ] || "albums"
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
            catalogUnavailable && !isPlaylistTab ? null : (
              <StatePanel
                icon={<Music className="artist-icon-lg" />}
                title={emptyTitle}
                message={emptyMessage}
              />
            )
          ) : (
            <>
              {isUnifiedSearch ? (
                <div className="search-page__unified">
                  {activeFilter === "all" && (
                    <>
                      {unifiedView.topResult && (
                        <SearchTopResultCard
                          item={unifiedView.topResult}
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
                      <SearchPlaylistShelf playlists={playlistItems} showAllTo={playlistTabPath} />
                    </>
                  )}

                  {isPlaylistTab && (
                    <SearchMixedResultList items={playlistItems} {...searchListProps} />
                  )}

                  {activeFilter === "singles" && unifiedView.singles.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.singles}
                      albumCovers={albumCovers}
                      canAddAlbum={canAddAlbum}
                      pendingAlbumIds={pendingAlbumIds}
                      onAlbumAction={handleAlbumAction}
                      libraryDestination={libraryDestination}
                      viewMode="grid"
                    />
                  )}

                  {activeFilter === "artists" && unifiedView.artists.length > 0 && (
                    <SearchArtistResults
                      artists={unifiedView.artists}
                      libraryLookup={libraryLookup}
                      onArtistFeedback={handleArtistFeedback}
                      artistFeedbackLookup={artistFeedbackLookup}
                      variant="round"
                    />
                  )}

                  {activeFilter === "albums" && unifiedView.albums.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.albums}
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
