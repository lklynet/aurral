import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link, useNavigate, useNavigationType, useParams, useSearchParams } from "react-router";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
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
import { LibraryItemMenu } from "../components/LibraryItemMenu";
import { Select } from "../components/Select";
import TooltipButton from "../components/TooltipButton";
import { FavoriteButton, TrackList } from "../components/TrackList";
import { CollectionPlayButtons, useCollectionTint } from "../components/CollectionHeader";
import CrossViewLink from "../components/CrossViewLink";
import RouteLink from "../components/RouteLink";
import { useSharedArtworkStyle } from "../navigation/viewTransitions.ts";
import {
  SkeletonLibraryArtist,
  SkeletonLibraryGrid,
  SkeletonShape,
  SkeletonStatus,
  SkeletonText,
  SkeletonTrackList,
} from "../components/Skeletons";
import { useAuth } from "../contexts/AuthContext";
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
import {
  aurralAlbumStatusKey,
  describeAurralAlbumStatus,
  shouldPollAlbumStatuses,
} from "../utils/aurralAlbumStatus.ts";
import { canRemoveLibraryArtist } from "../utils/libraryDestination.ts";
import { useArtistMonitoring } from "../components/ArtistMonitoringButtons";
import { LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import {
  LIBRARY_DEFAULT_SORT,
  LIBRARY_PAGE_SIZE,
  LIBRARY_SORT_OPTIONS,
  libraryListParams,
  libraryTabForSection,
  libraryViewQueryOptions,
  resolveLibrarySection,
  type LibraryViewLibrary,
} from "./libraryViewQuery.ts";
import ArtistMbidModal from "./ArtistMbidModal";
import { getApiErrorMessage, getApiErrorText } from "./ArtistDetails/utils";
import { useResponsiveReleaseLimit } from "./ArtistDetails/hooks/useResponsiveReleaseLimit";
import { queryKeys } from "../queryClient.ts";
import Tooltip from "../components/Tooltip";
import { LIBRARY_SOURCE, useLibraryActions } from "./library/useLibraryActions.tsx";
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
} from "./library/libraryShared.tsx";

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
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
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

const TOP_ARTIST_TRACK_LIMIT = 10;

const QUERY_DEBOUNCE_MS = 250;

const wait = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

const trackRating = (track: LibraryPageTrack) => {
  const value = track?.metadata?.rating ?? nestedField(track?.metadata?.tags, "rating");
  const rating: unknown = Array.isArray(value) ? value[0] : value;
  const score = rating && typeof rating === "object" ? nestedField(rating, "rating") : rating;
  return Number.isFinite(Number(score)) ? Number(score) : null;
};

const trackRecency = (track: LibraryPageTrack, albumsById: Map<string, LibraryAlbum>) => {
  const fileTimes = (track?.files || [])
    .filter((file) => file.available)
    .map((file) => Number(file.mtimeMs))
    .filter(Number.isFinite);
  const albumTimes = (track?.albums || [])
    .map((relation) => albumsById.get(String(relation.albumId))?.releaseDate)
    .map((releaseDate) => Date.parse(String(releaseDate || "")))
    .filter(Number.isFinite);
  return Math.max(...fileTimes, ...albumTimes, 0);
};

const topArtistTracks = (tracks: LibraryPageTrack[], albumsById: Map<string, LibraryAlbum>) => {
  const hasRatings = tracks.some((track) => trackRating(track) !== null);
  return [...tracks]
    .sort((left, right) => {
      if (hasRatings) {
        const ratingDifference = (trackRating(right) ?? -1) - (trackRating(left) ?? -1);
        if (ratingDifference) return ratingDifference;
      }
      const recencyDifference = trackRecency(right, albumsById) - trackRecency(left, albumsById);
      return recencyDifference || text(left?.title).localeCompare(text(right?.title));
    })
    .slice(0, TOP_ARTIST_TRACK_LIMIT);
};

const artistAlbumTotal = (artist: LibraryArtist) =>
  ("albumCount" in artist ? artist.albumCount : undefined) ?? artist.albumIds?.length ?? 0;

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
  const { bootstrap } = useAuth();
  const { showError, showSuccess } = useToast();
  const navigationType = useNavigationType();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const queryTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
      while (true) {
        const status = await parseResponse(
          libraryClient.refresh[":jobId"].$get({ param: { jobId: encodeURIComponent(jobId) } }),
        );
        if (refreshAttemptRef.current !== attempt) return;
        if (status.status === "completed") {
          void invalidateLibraryViews();
          if (successMessage) showSuccess(successMessage);
          return;
        }
        if (status.status === "failed") {
          throw new Error(status.error || "Library refresh failed");
        }
        await wait(750);
      }
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
  const sharedArtworkStyle = useSharedArtworkStyle();
  const tab = libraryTabForSection(section);
  const selectedGenre = searchParams.get("genre") || "";
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";
  const sectionLabel = LIBRARY_VIEWS.find((view) => view.id === section)?.label || "Library";
  const sortOptions = LIBRARY_SORT_OPTIONS[section] || [];
  const {
    sort: sortMode,
    direction: sortDirection,
    pageIndex,
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
    setFiltersOpen(false);
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
        sort: sortMode,
        direction: sortDirection,
      }),
    [
      forcePreview,
      normalizedQuery,
      pageIndex,
      routeArtistId,
      section,
      selectedGenre,
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
  const loading = !forcePreview && libraryQuery.isPending;
  const error = forcePreview ? null : getApiErrorMessage(libraryQuery.error) || null;
  const pageData = useMemo(() => {
    if (!queryData || isPreviewLibrary || isDetail || section === "favorites") return null;
    if (section === "home") {
      const { pageResults } = queryData;
      if (!Array.isArray(pageResults)) return null;
      return {
        kind: "home",
        total: pageResults.reduce((count, page) => count + Number(page?.total || 0), 0),
      };
    }
    const { nextData } = queryData;
    return nextData && "kind" in nextData ? nextData : null;
  }, [isDetail, isPreviewLibrary, queryData, section]);
  const totalPages =
    pageData && "pageSize" in pageData && pageData.kind === tab && tab !== "genres"
      ? Math.ceil(pageData.total / pageData.pageSize)
      : 0;
  const lastPage = Math.max(totalPages, 1);

  useEffect(() => {
    if (pageData && pageIndex > lastPage) {
      updateViewParamsRef.current({ page: lastPage > 1 ? lastPage : null }, { replace: true });
    }
  }, [lastPage, pageData, pageIndex]);
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
      library.artists.filter(
        (artist) =>
          favoriteIds.has(favoriteId("artist", artist)) && entityMatches(artist, normalizedQuery),
      ),
    [favoriteIds, library.artists, normalizedQuery],
  );

  const favoriteAlbums = useMemo(
    () =>
      library.albums.filter((album) => {
        const artist = getArtistForAlbum(album);
        return (
          favoriteIds.has(favoriteId("album", album)) &&
          entityMatches({ ...album, artistName: artist?.name }, normalizedQuery)
        );
      }),
    [favoriteIds, getArtistForAlbum, library.albums, normalizedQuery],
  );

  const favoriteTracks = useMemo(
    () =>
      ownedLibraryTracks.filter((track) => {
        const album = getAlbumForTrack(track);
        const artist = getArtistForAlbum(album);
        return (
          favoriteIds.has(favoriteId("song", track)) &&
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
    [favoriteIds, getAlbumForTrack, getArtistForAlbum, normalizedQuery, ownedLibraryTracks],
  );

  // "Recently added" keeps the server's order, which already applies the
  // direction.
  const sortedArtists = useMemo(() => {
    if (sortMode === "newest") return filteredArtists;
    const items = [...filteredArtists];
    items.sort((left, right) => text(left.name).localeCompare(text(right.name)));
    return sortDirection === "asc" ? items : items.reverse();
  }, [filteredArtists, sortDirection, sortMode]);

  const sortedAlbums = useMemo(() => {
    if (sortMode === "newest") return filteredAlbums;
    const items = [...filteredAlbums];
    items.sort((left, right) => {
      if (sortMode === "artist") {
        return text(getArtistForAlbum(left)?.name).localeCompare(
          text(getArtistForAlbum(right)?.name),
        );
      }
      return text(left.title).localeCompare(text(right.title));
    });
    return sortDirection === "asc" ? items : items.reverse();
  }, [filteredAlbums, getArtistForAlbum, sortDirection, sortMode]);

  const sortedTracks = useMemo(() => {
    if (sortMode === "newest") return filteredTracks;
    const items = [...filteredTracks];
    items.sort((left, right) => {
      if (sortMode === "artist") {
        return text(
          left.artistName || getArtistForAlbum(getAlbumForTrack(left))?.name,
        ).localeCompare(text(right.artistName || getArtistForAlbum(getAlbumForTrack(right))?.name));
      }
      return text(left.title).localeCompare(text(right.title));
    });
    return sortDirection === "asc" ? items : items.reverse();
  }, [filteredTracks, getAlbumForTrack, getArtistForAlbum, sortDirection, sortMode]);

  const sortedGenres = useMemo(() => {
    const items = [...visibleGenreStats].sort((left, right) => left.name.localeCompare(right.name));
    return sortDirection === "asc" ? items : items.reverse();
  }, [sortDirection, visibleGenreStats]);

  const homeAlbums = useMemo(
    () => library.albums.slice(0, Math.max(2, homeAlbumColumns) * 2),
    [homeAlbumColumns, library.albums],
  );
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
  const homeTracks = ownedLibraryTracks.slice(0, 12);
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
    if (!libraryArtist?.mbid || isPreviewLibrary || !libraryArtistMonitoring.ready) return [];
    const { label, manager, monitoringItems, reason } = libraryArtistMonitoring;
    const submenuItems = reason
      ? [{ id: "monitoring-blocked", label: reason, disabled: true }]
      : monitoringItems;
    return submenuItems.length
      ? [
          {
            id: "monitoring",
            label: manager === "aurral" ? label : `Monitor: ${label}`,
            icon: Eye,
            separatorBefore: true,
            submenuItems,
          },
        ]
      : [];
  })();

  const aurralAlbumStatusKeys = useMemo(() => {
    if (isPreviewLibrary) return [];
    return library.albums
      .filter((album) => {
        if (album.managedBy !== "aurral") return false;
        const { total, available } = albumAvailability(album);
        return !total || available < total;
      })
      .map((album) => aurralAlbumStatusKey(album.id))
      .sort();
  }, [albumAvailability, isPreviewLibrary, library.albums]);
  const aurralAlbumStatusesQuery = useQuery({
    queryKey: queryKeys.downloadStatus(aurralAlbumStatusKeys),
    queryFn: ({ signal }) =>
      getDownloadStatus(aurralAlbumStatusKeys, { signal, bypassCache: true }),
    enabled: aurralAlbumStatusKeys.length > 0,
    staleTime: 0,
    refetchInterval: (query) => (shouldPollAlbumStatuses(query.state.data) ? 4000 : false),
    refetchIntervalInBackground: false,
  });
  const aurralAlbumStatuses = aurralAlbumStatusesQuery.data || {};

  useDocumentTitle(
    isDetail
      ? libraryArtist?.name || "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : "Library",
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
        .flatMap((page) => (Array.isArray(page?.items) ? page.items : []))
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

  const artistMbidMenuItems = (
    artist: LibraryArtist | null | undefined,
    { separatorBefore = false }: { separatorBefore?: boolean } = {},
  ) =>
    actions.canEditArtistMbid &&
    (artist && "providerId" in artist ? artist.providerId : undefined) == null
      ? [
          {
            id: "mbid",
            label: "Edit MusicBrainz ID",
            icon: Fingerprint,
            separatorBefore,
            onSelect: () => setMbidArtist(artist),
          },
        ]
      : [];

  const handleArtistMbidSaved: ComponentProps<typeof ArtistMbidModal>["onSaved"] = (result) => {
    const previousId = mbidArtist?.id;
    setMbidArtist(null);
    const previousName = mbidArtist?.name || "Artist";
    showSuccess(
      result.merged
        ? `Merged ${previousName} into ${result.name}`
        : result.mbid
          ? `Linked ${previousName} to ${result.musicbrainzName || "MusicBrainz"}`
          : `Removed the MusicBrainz ID from ${previousName}`,
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

  const handleDiscoverArtistOpen = (artist: LibraryArtist | null | undefined) => {
    if (!artist?.mbid) return;
    navigate("/artist/" + encodeURIComponent(artist.mbid), {
      state: actions.discoverArtistState(artist),
    });
  };

  const favoriteCount = favoriteArtists.length + favoriteAlbums.length + favoriteTracks.length;
  const activeCount =
    section === "home"
      ? (pageData?.total ?? library.albums.length + ownedLibraryTracks.length)
      : section === "favorites"
        ? favoriteCount
        : pageData && pageData.kind === tab
          ? pageData.total
          : tab === "artists"
            ? sortedArtists.length
            : tab === "albums"
              ? sortedAlbums.length
              : tab === "tracks"
                ? sortedTracks.length
                : sortedGenres.length;
  const collectionTracks = useMemo(() => {
    if (section === "favorites") return favoriteTracks;
    if (section === "albums") return sortedAlbums.flatMap(getAlbumTracks);
    if (section === "tracks") return sortedTracks;
    if (section === "genres" && selectedGenre) return filteredTracks;
    return ownedLibraryTracks;
  }, [
    favoriteTracks,
    filteredTracks,
    getAlbumTracks,
    ownedLibraryTracks,
    section,
    selectedGenre,
    sortedAlbums,
    sortedTracks,
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
              ...actions.collectionPlayItems(() => loadArtistTracks(artist)),
              actions.shareMenuItem({ kind: "artist", entity: artist }),
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => actions.openLibraryInfo({ kind: "artist", entity: artist }),
              },
              {
                id: "discover",
                label: "Open in Discover",
                icon: Sparkles,
                separatorBefore: true,
                onSelect: () => handleDiscoverArtistOpen(artist),
                disabled: !artist.mbid,
              },
              ...artistMbidMenuItems(artist),
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

  const renderAlbumCard = (album: LibraryAlbum) => {
    const artist = getArtistForAlbum(album);
    const albumEmpty =
      !getAlbumTracks(album).length && !album.trackCount && !album.trackIds?.length;
    const meta = albumCardMeta(album, albumAvailability(album));
    const isFavorite = favoriteIds.has(favoriteId("album", album));
    const aurralState =
      album.managedBy === "aurral"
        ? describeAurralAlbumStatus(aurralAlbumStatuses[aurralAlbumStatusKey(album.id)] || {})
        : null;
    // The yellow track count already shows a partial album, so the label would only crowd it out.
    const cardStatus =
      aurralState?.status === "complete" || aurralState?.status === "partial" ? null : aurralState;
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
              ...actions.collectionPlayItems(() => loadAlbumCollection(album), albumEmpty),
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
          {artist ? (
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
            {meta.details && meta.details + " · "}
            {meta.partial && aurralState?.status !== "unreleased" ? (
              <span className="native-library-card__status" data-tone="warning">
                {meta.count}
                <span className="sr-only"> available</span>
              </span>
            ) : (
              meta.count
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
      {homeAlbums.length > 0 && (
        <section className="native-library-section">
          {renderSectionHeader("Recently added", homeAlbums.length, "/library/albums")}
          <div ref={homeAlbumsGridRef} className="native-library-grid">
            {homeAlbums.map(renderAlbumCard)}
          </div>
        </section>
      )}
      {homeTracks.length > 0 && (
        <section className="native-library-section">
          {renderSectionHeader("Tracks", ownedLibraryTracks.length, "/library/tracks")}
          {renderTrackList(homeTracks, "Library tracks")}
        </section>
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
            {renderSectionHeader("Artists", favoriteArtists.length)}
            <div className="native-library-grid native-library-grid--artists">
              {favoriteArtists.map(renderArtistCard)}
            </div>
          </section>
        )}
        {favoriteAlbums.length > 0 && (
          <section className="native-library-section">
            {renderSectionHeader("Albums", favoriteAlbums.length)}
            <div className="native-library-grid">{favoriteAlbums.map(renderAlbumCard)}</div>
          </section>
        )}
        {favoriteTracks.length > 0 && (
          <section className="native-library-section">
            {renderSectionHeader("Tracks", favoriteTracks.length)}
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

  const renderLibraryArtistDetail = () => {
    if (!libraryArtist) return null;
    const { mbid } = libraryArtist;
    const ownedAlbums = library.albums.filter(
      (album) => String(album.artistId) === String(libraryArtist.id),
    );
    const sharedAlbums = mbid
      ? library.albums.filter(
          (album) => !ownedAlbums.includes(album) && album.creditedArtistMbids?.includes(mbid),
        )
      : [];
    const artistAlbums = [...ownedAlbums, ...sharedAlbums];
    const artistTracks = ownedAlbums.flatMap(getAlbumTracks);
    const artistTopTracks = topArtistTracks(artistTracks, actions.albumsById);
    const artistTrackTotal = ownedAlbums.reduce(
      (total, album) => total + Number(albumAvailability(album).total || 0),
      0,
    );
    const discoverArtist = hasMbid(libraryArtist) ? libraryArtist : null;
    const artistPlayable = artistTracks.some((track) => firstAvailableFile(track));
    const artistIsCurrent =
      actions.matchesSource(LIBRARY_SOURCE) &&
      artistTracks.some((track) => String(track.id) === String(actions.currentTrack?.id));
    return (
      <section className="native-library-detail">
        <div
          className="native-library-detail__hero native-library-detail__hero--artist"
          data-library-menu-target
        >
          <div className="native-library-detail__cover" style={sharedArtworkStyle}>
            <Cover src={libraryArtist.coverUrl} label={libraryArtist.name} thumbnail={false} />
          </div>
          <div className="native-library-detail__body">
            <h2>{libraryArtist.name || "Unknown Artist"}</h2>
            <p className="native-library-detail__meta">
              {[
                artistAlbums.length + (artistAlbums.length === 1 ? " album" : " albums"),
                artistTrackTotal
                  ? artistTrackTotal + (artistTrackTotal === 1 ? " track" : " tracks")
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="native-library-detail__actions">
              <CollectionPlayButtons
                label={libraryArtist.name || "artist"}
                disabled={!artistPlayable}
                isPlaying={artistIsCurrent && actions.isRunning}
                isShuffleEnabled={false}
                onPlay={() =>
                  artistIsCurrent
                    ? actions.togglePlayPause()
                    : playCollection(() => loadArtistTracks(libraryArtist))
                }
                onShuffle={() => playCollection(() => loadArtistTracks(libraryArtist), true)}
              />
              <FavoriteButton
                active={favoriteIds.has(favoriteId("artist", libraryArtist))}
                pending={Boolean(actions.pendingFavorite)}
                label={libraryArtist.name || "artist"}
                onClick={() => actions.toggleFavorite("artist", libraryArtist)}
              />
              {discoverArtist && (
                <CrossViewLink
                  view="discover"
                  to={"/artist/" + encodeURIComponent(discoverArtist.mbid)}
                  state={actions.discoverArtistState(discoverArtist)}
                />
              )}
              <LibraryItemMenu
                label={libraryArtist.name || "Artist"}
                {...artistMenuProps(libraryArtist)}
                items={[
                  ...actions.collectionQueueItems(
                    () => loadArtistTracks(libraryArtist),
                    !artistPlayable,
                  ),
                  actions.shareMenuItem({ kind: "artist", entity: libraryArtist }),
                  {
                    id: "info",
                    label: "View info",
                    icon: Info,
                    onSelect: () =>
                      actions.openLibraryInfo({ kind: "artist", entity: libraryArtist }),
                  },
                  ...artistMbidMenuItems(libraryArtist, { separatorBefore: true }),
                  ...libraryArtistMonitoringItems,
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
            </div>
          </div>
        </div>
        <section className="native-library-detail__section">
          <div className="native-library-detail__section-heading">
            <h3>Albums</h3>
            <span>{artistAlbums.length}</span>
          </div>
          {artistAlbums.length ? (
            <div className="native-library-grid">{artistAlbums.map(renderAlbumCard)}</div>
          ) : (
            <EmptyState title="No albums" message="No albums for this artist." />
          )}
        </section>
        <section className="native-library-detail__section">
          <div className="native-library-detail__section-heading">
            <h3>Top tracks</h3>
            <span>{artistTopTracks.length}</span>
          </div>
          {artistTopTracks.length ? (
            renderTrackList(artistTopTracks, libraryArtist.name + " top tracks")
          ) : (
            <EmptyState title="No tracks" message="No tracks for this artist." />
          )}
        </section>
      </section>
    );
  };

  const renderLibraryModals = () => (
    <>
      {libraryArtistMonitoring.dialog}
      {actions.renderModals()}
      <ArtistMbidModal
        artist={mbidArtist}
        onClose={() => setMbidArtist(null)}
        onSaved={handleArtistMbidSaved}
      />
    </>
  );

  const providerWarning = bootstrap?.lidarr?.circuitOpen === true;
  const renderStatus = () => (
    <>
      {providerWarning && (
        <p className="native-library-notice" role="status">
          Lidarr is unavailable. Showing the last indexed library.
        </p>
      )}
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
                  {renderSectionHeader("Recently added")}
                  <SkeletonLibraryGrid
                    ref={homeAlbumsGridRef}
                    count={Math.max(2, homeAlbumColumns) * 2}
                  />
                </section>
                <section className="native-library-section">
                  {renderSectionHeader("Tracks")}
                  <SkeletonTrackList count={10} />
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
        {sortedArtists.map(renderArtistCard)}
      </div>
    ) : tab === "albums" ? (
      <div className={"native-library-grid" + (viewMode === "list" ? " is-list" : "")}>
        {sortedAlbums.map(renderAlbumCard)}
      </div>
    ) : tab === "tracks" ? (
      renderTrackList(sortedTracks, "Library tracks")
    ) : (
      renderGenres()
    );

  const pageTitle =
    section === "home"
      ? "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : sectionLabel;
  const pageCount =
    section === "home"
      ? (pageData?.total ?? library.albums.length + ownedLibraryTracks.length)
      : activeCount;
  const showToolbar = section !== "home";
  const isSearchVisible = searchOpen || Boolean(query);
  const hasActiveFilters = Boolean(selectedGenre);

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
                          { sort: sort === LIBRARY_DEFAULT_SORT ? null : sort, page: null },
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
                  className={`native-library-icon-button${hasActiveFilters ? " is-active" : ""}`}
                  onClick={() => setFiltersOpen((value) => !value)}
                  label="Filters"
                  aria-label="Filter library"
                  aria-pressed={filtersOpen}
                >
                  <ListFilter aria-hidden="true" />
                </TooltipButton>
              )}
              {refreshControls}
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
            {filtersOpen && section !== "genres" && (
              <div className="native-library-filter-panel">
                <label>
                  <span>Genre</span>
                  <Select
                    className=""
                    value={selectedGenre}
                    onChange={updateGenreFilter}
                    aria-label="Filter by genre"
                    options={[
                      { value: "", label: "All genres" },
                      ...genreStats.map((genre) => ({ value: genre.name, label: genre.name })),
                    ]}
                  />
                </label>
                {selectedGenre && (
                  <button
                    type="button"
                    className="native-library-filter-reset"
                    onClick={() => updateGenreFilter("")}
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
            query || selectedGenre
              ? "No matches"
              : section === "favorites"
                ? "No favorites"
                : "Your library is empty"
          }
          message={
            query || selectedGenre
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
      {!loading && !error && totalPages > 1 && (
        <nav className="native-library-pagination" aria-label={sectionLabel + " pages"}>
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => setPageIndex(pageIndex - 1)}
            disabled={pageIndex === 1}
            label="Previous page"
            aria-label="Previous page"
          >
            <ArrowLeft aria-hidden="true" />
          </TooltipButton>
          <span>
            Page {pageIndex} of {totalPages}
          </span>
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => setPageIndex(Math.min(totalPages, pageIndex + 1))}
            disabled={pageIndex === totalPages}
            label="Next page"
            aria-label="Next page"
          >
            <ArrowRight aria-hidden="true" />
          </TooltipButton>
        </nav>
      )}
    </div>
  );
}

export default LibraryPage;
