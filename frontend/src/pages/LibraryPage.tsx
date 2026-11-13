import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link, useNavigate, useNavigationType, useParams, useSearchParams } from "react-router";
import {
  ArrowDownAZ,
  ArrowUpZA,
  Eye,
  Fingerprint,
  Grid3X3,
  Info,
  List,
  ListFilter,
  MoreVertical,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  X,
} from "../components/icons";

import { DotLoader } from "../components/DotLoader";
import { LibraryItemMenu, type LibraryMenuItem } from "../components/LibraryItemMenu";
import { Select } from "../components/Select";
import TooltipButton from "../components/TooltipButton";
import Pagination from "../components/Pagination";
import { FavoriteButton, TrackList } from "../components/TrackList";
import { useCollectionTint } from "../components/CollectionHeader";
import RouteLink from "../components/RouteLink";
import {
  SkeletonLibraryArtist,
  SkeletonLibraryGrid,
  SkeletonShape,
  SkeletonStatus,
  SkeletonText,
  SkeletonTrackList,
} from "../components/Skeletons";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { libraryClient } from "../utils/api/clients/library.ts";
import {
  clearLibraryPageCache,
  getLibraryPage,
  getDownloadStatus,
} from "../utils/api/endpoints/library.ts";
import { asApiError } from "../utils/api/core.ts";
import {
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
  albumCardMeta,
  favoriteId,
  firstAvailableFile,
} from "../utils/libraryPageData.ts";
import { describeAlbumStatus, shouldPollAlbumStatuses } from "../utils/albumStatus.ts";
import { useArtistMonitoring } from "../components/ArtistMonitoringButtons";
import { LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import {
  HOME_ALBUM_RAILS,
  LIBRARY_PAGE_SIZE,
  LIBRARY_STATUS_LABELS,
  LIBRARY_STATUS_OPTIONS,
  libraryDefaultSort,
  libraryListParams,
  librarySortOptions,
  libraryTabForSection,
  libraryViewQueryOptions,
  resolveLibrarySection,
  type LibraryViewLibrary,
} from "../utils/libraryViewQuery.ts";
import { ArtistMatchModal, type ArtistMatchResult } from "./library/MatchModal";
import { DiscoverRail } from "../components/DiscoverRail";
import { LibraryHomeMixes } from "./library/LibraryHomeMixes";
import { LibraryHomePlaylists } from "./library/LibraryHomePlaylists";
import { useResponsiveReleaseLimit } from "./ArtistDetails/hooks/useResponsiveReleaseLimit";
import { queryKeys } from "../queryClient.ts";
import Tooltip from "../components/Tooltip";
import { useLibraryActions } from "./library/useLibraryActions.tsx";
import { LibraryArtistDetail, type AlbumCardOptions } from "./library/LibraryArtistDetail.tsx";
import {
  type LibraryPageTrack,
  type LibraryRemoval,
  Cover,
  EmptyState,
  hasMbid,
  invalidateLibraryViews,
  text,
  useLibraryScanRefresh,
  useLibraryViewData,
  waitForLibraryScan,
} from "./library/libraryShared.tsx";
import { getApiErrorMessage, getApiErrorText } from "../utils/api/errors.ts";

type LibraryData = LibraryViewLibrary;

type LibraryGenre = LibraryData["genres"][number];

type GenreSource = { metadata?: object | null };

const nestedField = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, key) : undefined;

const metadataGenres = (entity: GenreSource | null | undefined) => {
  const metadata = entity?.metadata;
  return [
    nestedField(metadata, "genres"),
    nestedField(metadata, "genre"),
    nestedField(nestedField(metadata, "common"), "genre"),
    nestedField(nestedField(metadata, "tags"), "genre"),
  ]
    .flatMap((value): unknown[] => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => String(value || "").split(";"))
    .map(text)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
};

const hasGenre = (genre: string, ...entities: (GenreSource | null | undefined)[]) => {
  if (!genre) return true;
  const wanted = genre.toLocaleLowerCase();
  return entities.flatMap(metadataGenres).some((value) => value.toLocaleLowerCase() === wanted);
};

const QUERY_DEBOUNCE_MS = 250;

const canRemoveLibraryArtist = (artist: LibraryArtist) =>
  Boolean(artist.mbid) || artist.sources?.some((source) => source === "aurral") === true;

const artistAlbumTotal = (artist: LibraryArtist) =>
  ("albumCount" in artist ? artist.albumCount : undefined) ?? artist.albumIds?.length ?? 0;

const inPageOrder = <Entity extends { id: string | number }>(
  items: readonly { id: string | number }[],
  entities: readonly Entity[],
) => {
  const byId = new Map(entities.map((entity) => [String(entity.id), entity]));
  return items.map((item) => byId.get(String(item.id))).filter((entity) => entity !== undefined);
};

const entityMatches = (
  entity:
    | {
        name?: string | null;
        title?: string | null;
        artistName?: unknown;
        albumArtist?: string | null;
        albumName?: unknown;
      }
    | null
    | undefined,
  query: string,
) => {
  if (!query) return true;
  return [
    entity?.name,
    entity?.title,
    entity?.artistName,
    entity?.albumArtist,
    entity?.albumName,
  ].some((value) => text(value).toLocaleLowerCase().includes(query));
};

function LibraryPage() {
  const navigate = useNavigate();
  const { section: routeSection, artistId: routeArtistId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showError, showSuccess } = useToast();
  const navigationType = useNavigationType();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const queryTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState<boolean | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAttemptRef = useRef(0);
  const [mbidArtist, setMbidArtist] = useState<LibraryArtist | null | undefined>(null);
  const [homeAlbumsGridRef, homeAlbumColumns] = useResponsiveReleaseLimit({
    cardMinWidth: 152,
  });

  useLibraryScanRefresh();

  useEffect(
    () => () => {
      refreshAttemptRef.current += 1;
    },
    [],
  );

  const pollLibraryRefresh = useCallback(
    async (jobId: number, attempt: number, successMessage = "") => {
      const done = await waitForLibraryScan(jobId, () => refreshAttemptRef.current === attempt);
      if (done && successMessage) showSuccess(successMessage);
    },
    [showSuccess],
  );

  useEffect(() => {
    let mounted = true;
    const restoreLibraryRefresh = async () => {
      try {
        const active = await parseResponse(libraryClient.refresh.$get());
        if (
          !mounted ||
          !active?.jobId ||
          !(["queued", "running"] as (string | undefined)[]).includes(active.status?.status)
        )
          return;
        const attempt = refreshAttemptRef.current + 1;
        refreshAttemptRef.current = attempt;
        setRefreshing(true);
        try {
          await pollLibraryRefresh(active.jobId, attempt);
        } catch (requestError) {
          if (refreshAttemptRef.current === attempt) {
            showError(
              getApiErrorText(requestError, "message") ||
                asApiError(requestError)?.message ||
                "Library refresh failed",
            );
          }
        } finally {
          if (refreshAttemptRef.current === attempt) setRefreshing(false);
        }
      } catch {}
    };
    void restoreLibraryRefresh();
    return () => {
      mounted = false;
    };
  }, [pollLibraryRefresh, showError]);

  const refreshLibrary = useCallback(
    async (mode: "quick" | "full") => {
      if (refreshing) return;
      const attempt = refreshAttemptRef.current + 1;
      refreshAttemptRef.current = attempt;
      setRefreshing(true);
      try {
        clearLibraryPageCache();
        const queued = await parseResponse(libraryClient.refresh.$post({ json: { mode } }));
        const jobId = queued?.jobId;
        if (!jobId) throw new Error("Library refresh did not start");
        await pollLibraryRefresh(
          jobId,
          attempt,
          mode === "full" ? "Full scan complete" : "Library refreshed",
        );
      } catch (requestError) {
        if (refreshAttemptRef.current === attempt) {
          showError(
            getApiErrorText(requestError, "message") ||
              asApiError(requestError)?.message ||
              "Library refresh failed",
          );
        }
      } finally {
        if (refreshAttemptRef.current === attempt) setRefreshing(false);
      }
    },
    [pollLibraryRefresh, refreshing, showError],
  );

  const refreshControls = (
    <LibraryItemMenu
      label="Library refresh"
      triggerLabel={refreshing ? "Refreshing library…" : "Refresh library"}
      triggerIcon={
        <>
          {refreshing ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
          <MoreVertical aria-hidden="true" />
        </>
      }
      items={[
        {
          id: "quick",
          label: "Quick scan",
          icon: RefreshCw,
          disabled: refreshing,
          onSelect: () => void refreshLibrary("quick"),
        },
        {
          id: "full",
          label: "Full scan (re-read every file)",
          icon: ScanSearch,
          disabled: refreshing,
          onSelect: () => void refreshLibrary("full"),
        },
      ]}
    />
  );

  const section = resolveLibrarySection(routeSection);
  const isDetail = Boolean(routeArtistId);
  const tab = libraryTabForSection(section);
  const selectedGenre = searchParams.get("genre") || "";
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";
  const sectionLabel = LIBRARY_VIEWS.find((view) => view.id === section)?.label || "Library";
  const sortOptions = librarySortOptions(section);
  const defaultSort = libraryDefaultSort(section);
  const {
    sort: sortMode,
    direction: sortDirection,
    pageIndex,
    artist: selectedArtist,
    status: selectedStatus,
  } = libraryListParams(section, searchParams);
  const viewMode = searchParams.get("view") === "list" ? "list" : "grid";
  const normalizedQuery = query.trim() ? urlQuery.trim().toLocaleLowerCase() : "";

  const updateViewParams = (
    changes: Record<string, string | number | null | undefined>,
    { replace = false }: { replace?: boolean } = {},
  ) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    setSearchParams(next, { replace });
  };
  const updateViewParamsRef = useRef(updateViewParams);
  updateViewParamsRef.current = updateViewParams;

  const changeQuery = (value: string) => {
    setQuery(value);
    if (queryTimerRef.current) window.clearTimeout(queryTimerRef.current);
    const nextQuery = value.trim();
    const writeQuery = () =>
      updateViewParamsRef.current({ q: nextQuery, page: null }, { replace: true });
    if (!nextQuery) writeQuery();
    else queryTimerRef.current = window.setTimeout(writeQuery, QUERY_DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (queryTimerRef.current) window.clearTimeout(queryTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (navigationType === "REPLACE") return;
    if (queryTimerRef.current) window.clearTimeout(queryTimerRef.current);
    setQuery(urlQuery);
  }, [navigationType, urlQuery]);

  useEffect(() => {
    setSearchOpen(false);
    setFiltersOpen(null);
  }, [section]);

  const setPageIndex = (nextPage: number) =>
    updateViewParams({ page: nextPage > 1 ? nextPage : null });

  const libraryQueryOptions = useMemo(
    () =>
      libraryViewQueryOptions({
        preview: forcePreview,
        section,
        artistId: routeArtistId || null,
        pageIndex,
        query: normalizedQuery,
        genre: selectedGenre,
        status: selectedStatus,
        artist: selectedArtist,
        sort: sortMode,
        direction: sortDirection,
      }),
    [
      forcePreview,
      normalizedQuery,
      pageIndex,
      routeArtistId,
      section,
      selectedArtist,
      selectedGenre,
      selectedStatus,
      sortDirection,
      sortMode,
    ],
  );
  const libraryQueryKey = libraryQueryOptions.queryKey;
  const libraryQuery = useQuery({
    ...libraryQueryOptions,
    placeholderData: (previous, previousQuery) => {
      const previousView = previousQuery?.queryKey?.[2];
      const view = libraryQueryOptions.queryKey[2];
      return previousView &&
        previousView.preview === view.preview &&
        previousView.section === view.section &&
        previousView.artistId === view.artistId
        ? previous
        : undefined;
    },
  });
  const libraryUpdating = libraryQuery.isPlaceholderData;

  const queryData = libraryQuery.data;
  const { isPreviewLibrary, library, favoriteIds } = useLibraryViewData(queryData, forcePreview);
  const filterArtistName = selectedArtist
    ? library.artists.find((artist) => String(artist.id) === selectedArtist)?.name
    : undefined;
  const loading = !forcePreview && libraryQuery.isPending;
  const error = forcePreview ? null : getApiErrorMessage(libraryQuery.error, "") || null;
  const pageData = useMemo(() => {
    if (!queryData || isPreviewLibrary || isDetail || section === "favorites") return null;
    if (section === "home") {
      const { nextData } = queryData;
      if (!Array.isArray(nextData)) return null;
      return {
        kind: "home",
        total: nextData.reduce(
          (count, page, index) =>
            page.kind === "tracks" || HOME_ALBUM_RAILS[index]?.sort === "newest"
              ? count + page.total
              : count,
          0,
        ),
      };
    }
    const { nextData } = queryData;
    return nextData && "kind" in nextData ? nextData : null;
  }, [isDetail, isPreviewLibrary, queryData, section]);
  const favoritePages = useMemo(() => {
    if (section !== "favorites" || isPreviewLibrary || !Array.isArray(queryData?.nextData)) {
      return null;
    }
    const [artists, albums, tracks] = queryData.nextData;
    return {
      artists: artists?.kind === "artists" ? artists : null,
      albums: albums?.kind === "albums" ? albums : null,
      tracks: tracks?.kind === "tracks" ? tracks : null,
    };
  }, [isPreviewLibrary, queryData?.nextData, section]);
  const totalPages = favoritePages
    ? Math.ceil(
        Math.max(...Object.values(favoritePages).map((page) => page?.total ?? 0)) /
          LIBRARY_PAGE_SIZE,
      )
    : pageData && "pageSize" in pageData && pageData.kind === tab && tab !== "genres"
      ? Math.ceil(pageData.total / pageData.pageSize)
      : 0;
  const lastPage = Math.max(totalPages, 1);
  const pagesLoaded = Boolean(pageData || favoritePages);

  useEffect(() => {
    if (pagesLoaded && pageIndex > lastPage) {
      updateViewParamsRef.current({ page: lastPage > 1 ? lastPage : null }, { replace: true });
    }
  }, [lastPage, pagesLoaded, pageIndex]);
  const handleLibraryEntityRemoved = useCallback(
    (removal: LibraryRemoval) => {
      if (removal.kind === "artist" && String(routeArtistId) === String(removal.entity.id)) {
        navigate("/library/artists" + previewQuery);
      }
    },
    [navigate, previewQuery, routeArtistId],
  );
  const actions = useLibraryActions({
    libraryQueryKey,
    library,
    favoriteIds,
    isPreviewLibrary,
    forcePreview,
    onRemoved: handleLibraryEntityRemoved,
  });
  const {
    getAlbumTracks,
    getAlbumForTrack,
    getArtistForAlbum,
    lookupWithPages,
    albumAvailability,
    loadAlbumCollection,
    playCollection,
  } = actions;
  const renderTrackList = (tracks: LibraryPageTrack[], label: string) => (
    <TrackList
      label={label}
      highlightKey={searchParams.get("track")}
      rows={tracks.map((track, index) => actions.buildLibraryTrackRow(track, index, tracks))}
    />
  );

  const filteredArtists = useMemo(
    () =>
      library.artists.filter(
        (artist) => hasGenre(selectedGenre, artist) && entityMatches(artist, normalizedQuery),
      ),
    [library.artists, normalizedQuery, selectedGenre],
  );

  const filteredAlbums = useMemo(
    () =>
      library.albums.filter((album) => {
        const artist = getArtistForAlbum(album);
        return (
          hasGenre(selectedGenre, artist, album) &&
          entityMatches({ ...album, artistName: artist?.name }, normalizedQuery)
        );
      }),
    [getArtistForAlbum, library.albums, normalizedQuery, selectedGenre],
  );

  const ownedLibraryTracks = useMemo(
    () => library.tracks.filter((track) => firstAvailableFile(track)),
    [library.tracks],
  );

  const filteredTracks = useMemo(
    () =>
      ownedLibraryTracks.filter((track) => {
        const album = getAlbumForTrack(track);
        const artist = getArtistForAlbum(album);
        return (
          hasGenre(selectedGenre, artist, album, track) &&
          entityMatches(
            {
              ...track,
              albumName: album?.title,
              artistName: track.artistName || artist?.name,
              albumArtist: artist?.name || album?.albumArtist,
            },
            normalizedQuery,
          )
        );
      }),
    [getAlbumForTrack, getArtistForAlbum, normalizedQuery, ownedLibraryTracks, selectedGenre],
  );

  const genreStats = useMemo(() => {
    if (library.genres?.length) return library.genres;
    const stats = new Map<string, LibraryGenre>();
    const add = (genre: string, kind: "artists" | "albums" | "tracks") => {
      const entry = stats.get(genre) || { name: genre, artists: 0, albums: 0, tracks: 0 };
      entry[kind] += 1;
      stats.set(genre, entry);
    };
    library.artists.forEach((artist) =>
      metadataGenres(artist).forEach((genre) => add(genre, "artists")),
    );
    library.albums.forEach((album) =>
      metadataGenres(album).forEach((genre) => add(genre, "albums")),
    );
    ownedLibraryTracks.forEach((track) =>
      metadataGenres(track).forEach((genre) => add(genre, "tracks")),
    );
    return [...stats.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [library.albums, library.artists, library.genres, ownedLibraryTracks]);

  const visibleGenreStats = useMemo(
    () =>
      genreStats.filter(
        (genre) => !normalizedQuery || genre.name.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [genreStats, normalizedQuery],
  );

  const favoriteArtists = useMemo(
    () =>
      (favoritePages
        ? inPageOrder(favoritePages.artists?.artists ?? [], library.artists)
        : library.artists
      ).filter((artist) => favoriteIds.has(favoriteId("artist", artist))),
    [favoriteIds, favoritePages, library.artists],
  );

  const favoriteAlbums = useMemo(
    () =>
      (favoritePages
        ? inPageOrder(favoritePages.albums?.albums ?? [], library.albums)
        : library.albums
      ).filter((album) => favoriteIds.has(favoriteId("album", album))),
    [favoriteIds, favoritePages, library.albums],
  );

  const favoriteTracks = useMemo(
    () =>
      (favoritePages
        ? inPageOrder(favoritePages.tracks?.tracks ?? [], ownedLibraryTracks)
        : ownedLibraryTracks
      ).filter((track) => favoriteIds.has(favoriteId("song", track))),
    [favoriteIds, favoritePages, ownedLibraryTracks],
  );

  const sortedGenres = useMemo(() => {
    const items = [...visibleGenreStats].sort((left, right) => left.name.localeCompare(right.name));
    return sortDirection === "asc" ? items : items.reverse();
  }, [sortDirection, visibleGenreStats]);

  const homeRails = useMemo(() => {
    if (section !== "home") return [];
    if (isPreviewLibrary) return [{ ...HOME_ALBUM_RAILS[2], albums: library.albums }];
    const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
    const pages = Array.isArray(queryData?.nextData) ? queryData.nextData : [];
    return HOME_ALBUM_RAILS.map((rail, index) => {
      const page = pages[index];
      const items = page?.kind === "albums" ? page.albums : [];
      return {
        ...rail,
        albums: items
          .map((item) => albumsById.get(String(item.id)))
          .filter((album) => album !== undefined),
      };
    });
  }, [isPreviewLibrary, library.albums, queryData?.nextData, section]);
  const artistTopTracks = useMemo(() => {
    const page = Array.isArray(queryData?.nextData) && routeArtistId ? queryData.nextData[2] : null;
    if (page?.kind !== "tracks") return [];
    const tracksById = new Map(library.tracks.map((track) => [String(track.id), track]));
    return page.tracks
      .map((item) => tracksById.get(String(item.id)))
      .filter((track) => track !== undefined);
  }, [library.tracks, queryData?.nextData, routeArtistId]);
  const homeGenres = useMemo(
    () =>
      [...genreStats]
        .sort(
          (left, right) =>
            right.tracks - left.tracks ||
            right.albums - left.albums ||
            left.name.localeCompare(right.name),
        )
        .slice(0, 12),
    [genreStats],
  );
  const libraryArtist = routeArtistId
    ? actions.artistsById.get(String(routeArtistId)) || null
    : null;
  const libraryArtistMonitoring = useArtistMonitoring({
    mbid: !isPreviewLibrary ? libraryArtist?.mbid : null,
    artistName: libraryArtist?.name,
    canChange: actions.canChangeMonitoring,
    canAdd: actions.canEditArtistMbid,
    onChanged: invalidateLibraryViews,
  });
  const libraryArtistMonitoringItems = (() => {
    if (!libraryArtist?.mbid || isPreviewLibrary) return [];
    const { label, monitoringItems, reason } = libraryArtistMonitoring;
    const submenuItems = reason
      ? [{ id: "monitoring-blocked", label: reason, disabled: true }]
      : monitoringItems;
    return submenuItems.length
      ? [
          {
            id: "monitoring",
            label,
            icon: Eye,
            separatorBefore: true,
            submenuItems,
          },
        ]
      : [];
  })();

  const albumStatusIds = useMemo(() => {
    if (isPreviewLibrary) return [];
    return library.albums
      .filter((album) => {
        if (!album.managed) return false;
        const { total, available } = albumAvailability(album);
        return !total || available < total;
      })
      .map((album) => String(album.id))
      .sort();
  }, [albumAvailability, isPreviewLibrary, library.albums]);
  const albumStatusesQuery = useQuery({
    queryKey: queryKeys.downloadStatus(albumStatusIds),
    queryFn: ({ signal }) => getDownloadStatus(albumStatusIds, { signal, bypassCache: true }),
    enabled: albumStatusIds.length > 0,
    staleTime: 0,
    refetchInterval: (query) => (shouldPollAlbumStatuses(query.state.data) ? 4000 : false),
    refetchIntervalInBackground: false,
  });
  const albumStatuses = albumStatusesQuery.data || {};

  useDocumentTitle(
    isDetail
      ? libraryArtist?.name || "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : filterArtistName || "Library",
  );

  const detailTint = useCollectionTint(libraryArtist?.coverUrl);

  const loadArtistTracks = useCallback(
    async (artist: LibraryArtist) => {
      if (isPreviewLibrary) {
        return {
          tracks: library.albums
            .filter((album) => String(album.artistId) === String(artist.id))
            .flatMap(getAlbumTracks),
          lookup: null,
        };
      }
      const pages = [];
      for (let page = 1; ; page += 1) {
        const result = await getLibraryPage({
          kind: "tracks",
          artistId: artist.id,
          page,
          pageSize: LIBRARY_PAGE_SIZE,
          availableOnly: true,
        });
        pages.push(result);
        if (!result?.hasMore) break;
      }
      const lookup = lookupWithPages(pages);
      const position = (track: LibraryTrack) => {
        const album = getAlbumForTrack(track, lookup.albumsById);
        const relation = track.albums?.find((entry) => String(entry.albumId) === String(album?.id));
        return {
          released: album?.releaseDate || "",
          album: text(album?.title),
          disc: Number(relation?.discNumber || 0),
          number: Number(relation?.trackNumber || 0),
        };
      };
      const tracks = pages
        .flatMap((page) => (Array.isArray(page?.tracks) ? page.tracks : []))
        .map((track) => ({ track, position: position(track) }))
        .sort(
          (left, right) =>
            left.position.released.localeCompare(right.position.released) ||
            left.position.album.localeCompare(right.position.album) ||
            left.position.disc - right.position.disc ||
            left.position.number - right.position.number,
        )
        .map(({ track }) => track);
      return { tracks, lookup };
    },
    [getAlbumForTrack, getAlbumTracks, isPreviewLibrary, library.albums, lookupWithPages],
  );

  const handleArtistOpen = (artist: Pick<LibraryArtist, "id">) => {
    const path = actions.libraryArtistPath(artist);
    if (path) navigate(path);
  };

  const artistMbidMenuItems = (artist: LibraryArtist | null | undefined) =>
    actions.canEditArtistMbid &&
    (artist && "providerId" in artist ? artist.providerId : undefined) == null
      ? [
          {
            id: "mbid",
            label: "Match artist",
            icon: Fingerprint,
            onSelect: () => setMbidArtist(artist),
          },
        ]
      : [];

  const handleArtistMbidSaved = (result: ArtistMatchResult) => {
    const previousId = mbidArtist?.id;
    setMbidArtist(null);
    const previousName = mbidArtist?.name || "Artist";
    showSuccess(
      result.merged
        ? `Merged ${previousName} into ${result.name}`
        : result.mbid
          ? `Matched ${previousName} to ${result.musicbrainzName || "MusicBrainz"}`
          : `Removed the match from ${previousName}`,
    );
    if (
      routeArtistId &&
      String(routeArtistId) === String(previousId) &&
      String(result.id) !== String(previousId)
    ) {
      handleArtistOpen(result);
    }
  };

  const artistMenuProps = (artist: LibraryArtist) =>
    actions.collectionPlaylistMenu({
      key: "artist:" + artist.id,
      label: artist.name || "Artist",
      defaultName: `${artist.name || "Artist"} Picks`,
      load: () => loadArtistTracks(artist),
    });

  const discoverArtistMenuItem = (artist: LibraryArtist): LibraryMenuItem => ({
    id: "discover",
    label: "Open in Discover",
    icon: Sparkles,
    separatorBefore: true,
    disabled: !hasMbid(artist),
    onSelect: () => {
      if (!hasMbid(artist)) return;
      navigate("/artist/" + encodeURIComponent(artist.mbid), {
        state: actions.discoverArtistState(artist),
      });
    },
  });

  const favoriteTotals = {
    artists: favoritePages?.artists?.total ?? favoriteArtists.length,
    albums: favoritePages?.albums?.total ?? favoriteAlbums.length,
    tracks: favoritePages?.tracks?.total ?? favoriteTracks.length,
  };
  const favoriteCount = favoriteTotals.artists + favoriteTotals.albums + favoriteTotals.tracks;
  const activeCount =
    section === "home"
      ? (pageData?.total ?? library.albums.length + ownedLibraryTracks.length)
      : section === "favorites"
        ? favoriteCount
        : pageData && pageData.kind === tab
          ? pageData.total
          : tab === "artists"
            ? filteredArtists.length
            : tab === "albums"
              ? filteredAlbums.length
              : tab === "tracks"
                ? filteredTracks.length
                : sortedGenres.length;
  const collectionTracks = useMemo(() => {
    if (section === "favorites") return favoriteTracks;
    if (section === "albums") return filteredAlbums.flatMap(getAlbumTracks);
    if (section === "tracks") return filteredTracks;
    if (section === "genres" && selectedGenre) return filteredTracks;
    return ownedLibraryTracks;
  }, [
    favoriteTracks,
    filteredAlbums,
    filteredTracks,
    getAlbumTracks,
    ownedLibraryTracks,
    section,
    selectedGenre,
  ]);

  const collectionPlayable = collectionTracks.some((track) => firstAvailableFile(track));

  const updateGenreFilter = (genre: string) => updateViewParams({ genre, page: null });

  const renderArtistCard = (artist: LibraryArtist) => {
    const isFavorite = favoriteIds.has(favoriteId("artist", artist));
    return (
      <article
        className="native-library-card native-library-card--artist"
        data-library-menu-target
        data-artwork-scope
        key={artist.id}
      >
        <div className="native-library-card__cover-wrap">
          <RouteLink
            to={actions.libraryArtistPath(artist)}
            className="native-library-card__cover native-library-card__cover--round"
            data-artwork
            aria-label={"Open " + (artist.name || "artist")}
          >
            <Cover src={artist.coverUrl} label={artist.name} round />
          </RouteLink>
          <LibraryItemMenu
            label={artist.name || "Artist"}
            {...artistMenuProps(artist)}
            items={[
              ...actions.collectionPlayItems(() => loadArtistTracks(artist), false, {
                seed: { artists: [{ id: String(artist.id) }] },
                label: artist.name || "Artist",
              }),
              actions.shareMenuItem({ kind: "artist", entity: artist }),
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => actions.openLibraryInfo({ kind: "artist", entity: artist }),
              },
              discoverArtistMenuItem(artist),
              ...artistMbidMenuItems(artist),
              ...actions.pluginMenuItems("artist", { artistId: artist.id }),
              ...(actions.canDeleteArtist && canRemoveLibraryArtist(artist)
                ? [
                    {
                      id: "delete",
                      label: "Delete artist",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () =>
                        actions.openLibraryRemoval({ kind: "artist", entity: artist }),
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <Tooltip content={artist.name}>
              <RouteLink
                to={actions.libraryArtistPath(artist)}
                className="native-library-card__title"
              >
                {artist.name || "Unknown Artist"}
              </RouteLink>
            </Tooltip>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(actions.pendingFavorite)}
              label={artist.name || "artist"}
              onClick={() => actions.toggleFavorite("artist", artist)}
            />
          </div>
          <span className="native-library-card__meta">
            {artistAlbumTotal(artist)} album
            {artistAlbumTotal(artist) === 1 ? "" : "s"}
          </span>
        </div>
      </article>
    );
  };

  const renderAlbumCard = (
    album: LibraryAlbum,
    { showArtist = true, showType = true, showTotal = true }: AlbumCardOptions = {},
  ) => {
    const artist = getArtistForAlbum(album);
    const albumEmpty =
      !getAlbumTracks(album).length && !album.trackCount && !album.trackIds?.length;
    const meta = albumCardMeta(album, albumAvailability(album), { type: showType });
    const isFavorite = favoriteIds.has(favoriteId("album", album));
    const downloadState = album.managed ? describeAlbumStatus(albumStatuses[album.id] || {}) : null;
    // The yellow track count already shows a partial album, so the label would only crowd it out.
    const cardStatus =
      downloadState?.status === "complete" || downloadState?.status === "partial"
        ? null
        : downloadState;
    const albumLinkState = {
      artistMbid: artist?.mbid || null,
      seed: {
        title: album.title || "",
        artistName: artist?.name || album.albumArtist || "",
        coverUrl: album.coverUrl || null,
      },
    };
    return (
      <article
        className="native-library-card"
        data-library-menu-target
        data-artwork-scope
        key={album.id}
      >
        <div className="native-library-card__cover-wrap">
          <RouteLink
            to={actions.libraryAlbumPath(album)}
            state={albumLinkState}
            className="native-library-card__cover"
            data-artwork
            aria-label={"Open " + (album.title || "album")}
          >
            <Cover src={album.coverUrl} label={album.title} />
          </RouteLink>
          <TooltipButton
            className="native-library-card__play"
            onClick={() => playCollection(() => loadAlbumCollection(album))}
            disabled={albumEmpty}
            label={"Play " + (album.title || "album")}
            aria-label={"Play " + (album.title || "album")}
          >
            <Play aria-hidden="true" />
          </TooltipButton>
          <LibraryItemMenu
            label={album.title || "Album"}
            {...actions.albumMenuProps(album, () => loadAlbumCollection(album))}
            items={[
              ...actions.collectionPlayItems(() => loadAlbumCollection(album), albumEmpty, {
                seed: { albumIds: [String(album.id)] },
                label: album.title || "Album",
              }),
              ...actions.albumMenuItems(album, artist),
            ]}
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <Tooltip content={album.title}>
              <RouteLink
                to={actions.libraryAlbumPath(album)}
                state={albumLinkState}
                className="native-library-card__title"
              >
                {album.title || "Unknown Album"}
              </RouteLink>
            </Tooltip>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(actions.pendingFavorite)}
              label={album.title || "album"}
              onClick={() => actions.toggleFavorite("album", album)}
            />
          </div>
          {!showArtist ? null : artist ? (
            <RouteLink
              to={actions.libraryArtistPath(artist)}
              className="native-library-card__artist"
            >
              {artist.name}
            </RouteLink>
          ) : (
            <span className="native-library-card__artist">
              {album.albumArtist || "Unknown Artist"}
            </span>
          )}
          <span className="native-library-card__meta">
            {cardStatus && (
              <span className="native-library-card__status" data-tone={cardStatus.tone}>
                {cardStatus.label + " · "}
              </span>
            )}
            {meta.partial && downloadState?.status !== "unreleased" ? (
              <>
                {meta.details && meta.details + " · "}
                <span className="native-library-card__status" data-tone="warning">
                  {meta.count}
                  <span className="sr-only"> available</span>
                </span>
              </>
            ) : showTotal || meta.partial ? (
              [meta.details, meta.count].filter(Boolean).join(" · ")
            ) : (
              meta.details
            )}
          </span>
        </div>
      </article>
    );
  };

  const renderSectionHeader = (title: string, count?: number | null, path = "") => (
    <div className="native-library-section-heading">
      <div>
        <h2>{title}</h2>
        {count != null && <span>{count}</span>}
      </div>
      {path && (
        <RouteLink to={path} className="section-show-all">
          Show all
        </RouteLink>
      )}
    </div>
  );

  const renderHome = () => (
    <div className="native-library-home">
      {homeGenres.length > 0 && (
        <section className="native-library-section">
          {renderSectionHeader("Genres", null, "/library/genres" + previewQuery)}
          <div className="native-library-genre-grid">
            {homeGenres.map((genre) => (
              <Link
                className="native-library-genre-card"
                key={genre.name}
                to={
                  "/library/albums?genre=" +
                  encodeURIComponent(genre.name) +
                  (forcePreview ? "&preview=1" : "")
                }
              >
                {genre.name}
              </Link>
            ))}
          </div>
        </section>
      )}
      {homeRails.map((rail) =>
        rail.albums.length > 0 ? (
          <DiscoverRail
            key={rail.title}
            title={rail.title}
            viewAllTo={"path" in rail ? rail.path + (forcePreview ? "&preview=1" : "") : undefined}
          >
            {rail.albums.map((album) => (
              <div key={album.id} className="artist-discover-shelf-card">
                {renderAlbumCard(album)}
              </div>
            ))}
          </DiscoverRail>
        ) : null,
      )}
      {isPreviewLibrary ? null : (
        <>
          <LibraryHomeMixes />
          <LibraryHomePlaylists />
        </>
      )}
    </div>
  );

  const renderFavorites = () => {
    if (!favoriteCount) {
      return <EmptyState title="No favorites" message="Favorite music to find it here." />;
    }
    return (
      <div className="native-library-favorites">
        {favoriteArtists.length > 0 && (
          <section className="native-library-section">
            {renderSectionHeader("Artists", favoriteTotals.artists)}
            <div className="native-library-grid native-library-grid--artists">
              {favoriteArtists.map(renderArtistCard)}
            </div>
          </section>
        )}
        {favoriteAlbums.length > 0 && (
          <section className="native-library-section">
            {renderSectionHeader("Albums", favoriteTotals.albums)}
            <div className="native-library-grid">
              {favoriteAlbums.map((album) => renderAlbumCard(album))}
            </div>
          </section>
        )}
        {favoriteTracks.length > 0 && (
          <section className="native-library-section">
            {renderSectionHeader("Tracks", favoriteTotals.tracks)}
            {renderTrackList(favoriteTracks, "Favorite tracks")}
          </section>
        )}
      </div>
    );
  };

  const renderGenres = () => (
    <div className="native-library-genre-list">
      <div
        className="native-library-genre-row native-library-genre-row--heading"
        aria-hidden="true"
      >
        <span>Genre</span>
        <span>Artists</span>
        <span>Albums</span>
        <span>Tracks</span>
      </div>
      <div role="list" aria-label="Library genres">
        {sortedGenres.map((genre) => (
          <div role="listitem" key={genre.name}>
            <RouteLink
              className="native-library-genre-row"
              to={"/library/albums?genre=" + encodeURIComponent(genre.name)}
            >
              <strong>{genre.name}</strong>
              <span>{genre.artists}</span>
              <span>{genre.albums}</span>
              <span>{genre.tracks}</span>
            </RouteLink>
          </div>
        ))}
      </div>
    </div>
  );

  const renderLibraryArtistDetail = () =>
    libraryArtist ? (
      <LibraryArtistDetail
        artist={libraryArtist}
        albums={library.albums}
        topTracks={isPreviewLibrary ? null : artistTopTracks}
        favorite={favoriteIds.has(favoriteId("artist", libraryArtist))}
        actions={actions}
        loadTracks={() => loadArtistTracks(libraryArtist)}
        renderAlbumCard={renderAlbumCard}
        menu={artistMenuProps(libraryArtist)}
        menuItems={[
          discoverArtistMenuItem(libraryArtist),
          ...artistMbidMenuItems(libraryArtist),
          ...libraryArtistMonitoringItems,
          ...actions.rescanMenuItem({ artistId: libraryArtist.id }, libraryArtist),
          ...actions.pluginMenuItems("artist", { artistId: libraryArtist.id }),
          ...(actions.canDeleteArtist && canRemoveLibraryArtist(libraryArtist)
            ? [
                {
                  id: "delete",
                  label: "Delete artist",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () =>
                    actions.openLibraryRemoval({ kind: "artist", entity: libraryArtist }),
                },
              ]
            : []),
        ]}
      />
    ) : null;

  const renderLibraryModals = () => (
    <>
      {libraryArtistMonitoring.dialog}
      {actions.renderModals()}
      {mbidArtist ? (
        <ArtistMatchModal
          key={mbidArtist.id}
          artist={mbidArtist}
          onClose={() => setMbidArtist(null)}
          onSaved={handleArtistMbidSaved}
        />
      ) : null}
    </>
  );

  const renderStatus = () => (
    <>
      {loading &&
        (isDetail ? (
          <div className="native-library-content">
            <SkeletonLibraryArtist label="Loading library" />
          </div>
        ) : (
          <SkeletonStatus label="Loading library" className="native-library-content">
            {section === "home" ? (
              <div className="native-library-home">
                <section className="native-library-section">
                  {renderSectionHeader("Genres")}
                  <div className="native-library-genre-grid">
                    {Array.from({ length: 12 }, (_, index) => (
                      <SkeletonShape key={index} className="native-library-genre-card" />
                    ))}
                  </div>
                </section>
                <section className="native-library-section">
                  {renderSectionHeader(HOME_ALBUM_RAILS[0].title)}
                  <SkeletonLibraryGrid ref={homeAlbumsGridRef} count={homeAlbumColumns} />
                </section>
              </div>
            ) : section === "favorites" ? (
              <div className="native-library-favorites">
                <section className="native-library-section">
                  {renderSectionHeader("Artists")}
                  <SkeletonLibraryGrid
                    kind="artist"
                    className="native-library-grid native-library-grid--artists"
                  />
                </section>
              </div>
            ) : tab === "tracks" ? (
              <SkeletonTrackList count={12} />
            ) : tab === "genres" ? (
              <div className="native-library-genre-list">
                <div className="native-library-genre-row native-library-genre-row--heading">
                  <span>Genre</span>
                  <span>Artists</span>
                  <span>Albums</span>
                  <span>Tracks</span>
                </div>
                {Array.from({ length: 12 }, (_, index) => (
                  <div key={index} className="native-library-genre-row">
                    <strong>
                      <SkeletonText width={index % 2 ? "6em" : "8em"} />
                    </strong>
                    <span>
                      <SkeletonText width="2em" />
                    </span>
                    <span>
                      <SkeletonText width="2em" />
                    </span>
                    <span>
                      <SkeletonText width="2em" />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <SkeletonLibraryGrid
                kind={tab === "artists" ? "artist" : "album"}
                className={
                  "native-library-grid" +
                  (tab === "artists" ? " native-library-grid--artists" : "") +
                  (viewMode === "list" ? " is-list" : "")
                }
              />
            )}
          </SkeletonStatus>
        ))}
      {!loading && error && (
        <div className="native-library-state" role="alert">
          <strong>Library unavailable</strong>
          <span>{error}</span>
          <button
            type="button"
            className="native-library-state__action"
            onClick={() => refreshLibrary("quick")}
            disabled={refreshing}
          >
            {refreshing ? <DotLoader size="sm" label={null} /> : null}
            {refreshing ? "Refreshing…" : "Refresh library"}
          </button>
        </div>
      )}
    </>
  );

  if (isDetail) {
    return (
      <div
        className={`library-page native-library-page${libraryArtist ? " collection-page" : ""}`}
        style={detailTint ? { "--collection-tint": detailTint } : undefined}
      >
        {renderLibraryModals()}
        {renderStatus()}
        {!loading && !error && !libraryArtist && (
          <EmptyState title="Not found" message="This item is no longer in the Library." />
        )}
        {!loading && !error && libraryArtist && (
          <div className="native-library-content">{renderLibraryArtistDetail()}</div>
        )}
      </div>
    );
  }

  const content =
    section === "home" ? (
      renderHome()
    ) : section === "favorites" ? (
      renderFavorites()
    ) : tab === "artists" ? (
      <div
        className={
          "native-library-grid native-library-grid--artists" +
          (viewMode === "list" ? " is-list" : "")
        }
      >
        {filteredArtists.map(renderArtistCard)}
      </div>
    ) : tab === "albums" ? (
      <div className={"native-library-grid" + (viewMode === "list" ? " is-list" : "")}>
        {filteredAlbums.map((album) => renderAlbumCard(album))}
      </div>
    ) : tab === "tracks" ? (
      renderTrackList(filteredTracks, "Library tracks")
    ) : (
      renderGenres()
    );

  const pageTitle =
    section === "home"
      ? "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : filterArtistName || sectionLabel;
  const pageCount =
    section === "home"
      ? (pageData?.total ?? library.albums.length + ownedLibraryTracks.length)
      : activeCount;
  const showToolbar = section !== "home";
  const isSearchVisible = searchOpen || Boolean(query);
  const hasActiveFilters = Boolean(selectedGenre || selectedArtist || selectedStatus);
  const filtersVisible =
    section !== "genres" && (filtersOpen ?? Boolean(selectedGenre || selectedStatus));
  const appliedFilters = [
    selectedGenre,
    selectedStatus && LIBRARY_STATUS_LABELS[selectedStatus],
    filterArtistName,
  ].filter(Boolean);

  return (
    <div className="library-page native-library-page">
      {renderLibraryModals()}
      <header
        className={`native-library-header${section === "home" ? " native-library-header--home" : ""}`}
      >
        <div className="native-library-title-row">
          <div className="native-library-title">
            <TooltipButton
              className="native-library-title-play"
              onClick={() => actions.playTracks(collectionTracks)}
              disabled={!collectionPlayable}
              label={"Play " + pageTitle}
            >
              <Play aria-hidden="true" />
            </TooltipButton>
            <h1 className="page-title">
              {pageTitle}
              {pageCount != null && (
                <span className="native-library-count">
                  {loading ? <SkeletonText width="2.5em" /> : pageCount}
                </span>
              )}
            </h1>
          </div>
          <div className="native-library-header-actions">
            {selectedGenre && (
              <RouteLink
                className="btn btn-surface btn-sm"
                to={"/search?q=" + encodeURIComponent("#" + selectedGenre) + "&type=tag"}
              >
                <Sparkles aria-hidden="true" />
                Explore in Discover
              </RouteLink>
            )}
            {showToolbar ? (
              <TooltipButton
                className={`native-library-icon-button${isSearchVisible ? " is-active" : ""}`}
                onClick={() => {
                  if (isSearchVisible) {
                    setSearchOpen(false);
                    if (query) changeQuery("");
                    return;
                  }
                  setSearchOpen(true);
                }}
                label={isSearchVisible ? "Close search" : "Search"}
                aria-label={
                  isSearchVisible ? "Close search" : "Search " + sectionLabel.toLocaleLowerCase()
                }
                aria-pressed={isSearchVisible}
              >
                <Search aria-hidden="true" />
              </TooltipButton>
            ) : (
              refreshControls
            )}
          </div>
        </div>
        {showToolbar && (
          <>
            <div className="native-library-toolbar">
              {isSearchVisible && (
                <label className="native-library-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={query}
                    onChange={(event) => changeQuery(event.target.value)}
                    placeholder={"Search " + sectionLabel.toLocaleLowerCase()}
                    aria-label={"Search " + sectionLabel.toLocaleLowerCase()}
                    autoFocus
                  />
                  {query && (
                    <TooltipButton
                      onClick={() => changeQuery("")}
                      label="Clear search"
                      className="btn"
                    >
                      <X aria-hidden="true" />
                    </TooltipButton>
                  )}
                </label>
              )}
              {sortOptions.length > 0 && (
                <>
                  <div className="native-library-sort">
                    <Select
                      className=""
                      value={sortMode}
                      onChange={(sort) =>
                        updateViewParams(
                          { sort: sort === defaultSort ? null : sort, page: null },
                          { replace: true },
                        )
                      }
                      aria-label={"Sort " + sectionLabel.toLocaleLowerCase()}
                      options={sortOptions}
                    />
                  </div>
                  <span className="native-library-toolbar-divider" aria-hidden="true" />
                  <TooltipButton
                    className="native-library-icon-button"
                    onClick={() =>
                      updateViewParams(
                        { dir: sortDirection === "asc" ? "desc" : null, page: null },
                        { replace: true },
                      )
                    }
                    label={sortDirection === "asc" ? "Descending" : "Ascending"}
                    aria-label={sortDirection === "asc" ? "Sort descending" : "Sort ascending"}
                  >
                    {sortDirection === "asc" ? (
                      <ArrowDownAZ aria-hidden="true" />
                    ) : (
                      <ArrowUpZA aria-hidden="true" />
                    )}
                  </TooltipButton>
                </>
              )}
              {section !== "genres" && (
                <TooltipButton
                  ref={filterButtonRef}
                  className={`native-library-icon-button${hasActiveFilters ? " is-active" : ""}`}
                  onClick={() => setFiltersOpen(!filtersVisible)}
                  label="Filters"
                  aria-label={
                    appliedFilters.length
                      ? `Filter library, ${appliedFilters.join(", ")} applied`
                      : "Filter library"
                  }
                  aria-expanded={filtersVisible}
                  aria-controls="library-filters"
                >
                  <ListFilter aria-hidden="true" />
                </TooltipButton>
              )}
              <span className="native-library-toolbar-spacer" aria-hidden="true" />
              {(tab === "artists" || tab === "albums") && (
                <div className="native-library-view-toggle" aria-label="Library view">
                  <TooltipButton
                    className={`native-library-icon-button${viewMode === "grid" ? " is-active" : ""}`}
                    onClick={() => updateViewParams({ view: null }, { replace: true })}
                    label="Grid view"
                    aria-label="Grid view"
                    aria-pressed={viewMode === "grid"}
                  >
                    <Grid3X3 aria-hidden="true" />
                  </TooltipButton>
                  <TooltipButton
                    className={`native-library-icon-button${viewMode === "list" ? " is-active" : ""}`}
                    onClick={() => updateViewParams({ view: "list" }, { replace: true })}
                    label="List view"
                    aria-label="List view"
                    aria-pressed={viewMode === "list"}
                  >
                    <List aria-hidden="true" />
                  </TooltipButton>
                </div>
              )}
            </div>
            {filtersVisible && (
              <div id="library-filters" className="native-library-filter-panel">
                <Select
                  className="native-library-filter-genre"
                  value={selectedGenre}
                  onChange={updateGenreFilter}
                  aria-label="Filter by genre"
                  options={[
                    { value: "", label: "All genres" },
                    ...genreStats.map((genre) => ({ value: genre.name, label: genre.name })),
                  ]}
                />
                <Select
                  className="native-library-filter-status"
                  value={selectedStatus ?? ""}
                  onChange={(status) => updateViewParams({ status, page: null })}
                  aria-label={tab === "artists" ? "Filter artists by status" : "Filter by status"}
                  options={LIBRARY_STATUS_OPTIONS}
                />
                {hasActiveFilters && (
                  <button
                    type="button"
                    className="native-library-filter-reset"
                    aria-label="Clear library filters"
                    onClick={() => {
                      updateViewParams({ genre: null, artist: null, status: null, page: null });
                      setFiltersOpen(true);
                      filterButtonRef.current?.focus();
                    }}
                  >
                    <X aria-hidden="true" />
                    Clear
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </header>

      {renderStatus()}
      {!loading && !error && activeCount === 0 && (
        <EmptyState
          title={
            query || hasActiveFilters
              ? "No matches"
              : section === "favorites"
                ? "No favorites"
                : "Your library is empty"
          }
          message={
            query || hasActiveFilters
              ? "Try a different search or clear the filter."
              : "Music appears here after a Library scan."
          }
        />
      )}
      {!loading && !error && activeCount > 0 && (
        <div
          className={`native-library-content${libraryUpdating ? " query-pending" : ""}`}
          aria-busy={libraryUpdating || undefined}
        >
          {content}
        </div>
      )}
      {!loading && !error && (
        <Pagination
          page={pageIndex}
          pageCount={totalPages}
          label={sectionLabel + " pages"}
          onChange={setPageIndex}
        />
      )}
    </div>
  );
}

export default LibraryPage;
