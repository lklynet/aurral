import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from "react-router";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUpZA,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Fingerprint,
  Grid3X3,
  Heart,
  Info,
  List,
  ListFilter,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import ArtistImage from "../components/ArtistImage";
import { useAurralAlbumMonitoring } from "../components/AurralAlbumMonitoring";
import { useAurralTrackMonitoring } from "../components/AurralTrackMonitoring";
import { AurralAlbumStatus } from "../components/AurralAlbumStatus";
import { DotLoader } from "../components/DotLoader";
import { LibraryItemMenu } from "../components/LibraryItemMenu";
import TooltipButton from "../components/TooltipButton";
import { FavoriteButton, TrackList } from "../components/TrackList";
import {
  CollectionHeader,
  CollectionPlayButtons,
  useCollectionTint,
} from "../components/CollectionHeader";
import CrossViewLink from "../components/CrossViewLink";
import RouteLink from "../components/RouteLink";
import { readRouteSeed } from "../navigation/routeSeed.js";
import { useSharedArtworkStyle } from "../navigation/viewTransitions.js";
import {
  SkeletonCardGrid,
  SkeletonCollectionHeader,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeletons";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useStaticPlaylists } from "../hooks/useStaticPlaylists";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import {
  getReleaseGroupCoversBatch,
  getReleaseGroupTracks,
} from "../utils/api/endpoints/artists.js";
import {
  clearLibraryPageCache,
  deleteAlbumFromLibrary,
  deleteArtistFromLibrary,
  deleteAurralAlbumFromLibrary,
  deleteLidarrAlbumFromLibrary,
  deleteTrackFromLibrary,
  getActiveLibraryRefresh,
  getLibraryPage,
  getDownloadStatus,
  getLibraryRefreshStatus,
  getRequests,
  downloadTrackToLibrary,
  reSearchLibraryTrack,
  requestAlbumFromSearch,
  requestLibraryRefresh,
  updateLibraryAlbum,
  updateLibraryFavorites,
} from "../utils/api/endpoints/library.js";
import {
  addStaticPlaylistTracks,
  createStaticPlaylist,
  deleteStaticPlaylistTrack,
} from "../utils/api/endpoints/playlists.js";
import { buildAuthenticatedApiUrl } from "../utils/api/core.js";
import { mergeAlbumMetadataTracks } from "../utils/libraryTrackHydration.js";
import {
  EMPTY_LIBRARY,
  favoriteId,
  firstAvailableFile,
  getAlbumCoverId,
  getCachedAlbumTracks,
  mergeAlbumTrackPageIntoLibrary,
} from "../utils/libraryPageData.js";
import {
  aurralAlbumStatusKey,
  buildAurralAlbumRetryPayload,
  describeAurralAlbumStatus,
  shouldPollAlbumStatuses,
} from "../utils/aurralAlbumStatus.js";
import {
  canRemoveLibraryAlbum,
  resolveAlbumManager,
} from "../utils/libraryDestination.js";
import { describeAlbumRequestResult } from "../utils/albumAddAction.js";
import {
  canDownloadAurralAlbum,
  getMonitoringMenuAction,
} from "../utils/aurralMonitoring.js";
import { useArtistMonitoring } from "../components/ArtistMonitoringButtons";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { useQueueTrackActions } from "../hooks/useQueueTrackActions";
import { LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
import {
  LIBRARY_PAGE_SIZE,
  libraryTabForSection,
  libraryViewQueryOptions,
  resolveLibrarySection,
} from "./libraryViewQuery.js";
import {
  TrackPlaylistRemoveSubmenu,
  TrackPlaylistSubmenu,
} from "./ArtistDetails/components/TrackPlaylistMenu";
import { DeleteAlbumModal } from "./ArtistDetails/components/DeleteAlbumModal";
import { DeleteArtistModal } from "./ArtistDetails/components/DeleteArtistModal";
import { DeleteTrackModal } from "./ArtistDetails/components/DeleteTrackModal";
import LibraryInfoModal from "./LibraryInfoModal";
import ArtistMbidModal from "./ArtistMbidModal";
import {
  buildStaticPlaylistTrackPayload,
  reserveUniquePlaylistName,
} from "./ArtistDetails/utils";
import { useResponsiveReleaseLimit } from "./ArtistDetails/hooks/useResponsiveReleaseLimit";
import { queryClient, queryKeys } from "../queryClient.js";
import Tooltip from "../components/Tooltip";

const pageSize = LIBRARY_PAGE_SIZE;

const text = (value) => String(value || "").trim();

const metadataGenres = (entity) => {
  const metadata = entity?.metadata || {};
  return [metadata.genres, metadata.genre, metadata.common?.genre, metadata.tags?.genre]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => String(value || "").split(";"))
    .map(text)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
};

const hasGenre = (genre, ...entities) => {
  if (!genre) return true;
  const wanted = genre.toLocaleLowerCase();
  return entities.flatMap(metadataGenres).some((value) => value.toLocaleLowerCase() === wanted);
};

const yearOf = (value) => {
  const match = /^(\d{4})/.exec(text(value));
  return match ? match[1] : "";
};

const hasAurralTrackFile = (track) =>
  (track?.files || []).some((file) => file.source === "aurral");

const firstAvailableAurralFile = (track) =>
  (track?.files || []).find((file) => file.source === "aurral" && file.available) || null;

const trackDurationMs = (track) => {
  const fileDurationMs = (track?.files || []).find((file) => Number(file?.durationMs) > 0)
    ?.durationMs;
  if (fileDurationMs != null) return fileDurationMs;
  if (Number(track?.durationMs) > 0) return track.durationMs;
  const metadataDurationMs = Number(track?.metadata?.durationMs);
  if (metadataDurationMs > 0) return metadataDurationMs;
  const metadataDurationSeconds = Number(track?.metadata?.duration);
  return metadataDurationSeconds > 0 ? Math.round(metadataDurationSeconds * 1000) : null;
};

const formatDuration = (durationMs) => {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "";
  return (
    Math.floor(seconds / 60) +
    ":" +
    String(seconds % 60).padStart(2, "0")
  );
};

const formatLongDuration = (durationMs) => {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? hours + "h " + (minutes % 60) + "m"
    : minutes + "m " + (seconds % 60) + "s";
};

const TRACK_DOWNLOAD_ACTIVE_STATUSES = new Set([
  "submitting",
  "pending",
  "processing",
  "searching",
  "downloading",
  "moving",
  "blocked",
  "completed",
]);

const trackDownloadActionLabel = (status) => ({
  submitting: "Adding to search queue…",
  pending: "Queued for search",
  processing: "Searching for track…",
  searching: "Searching for track…",
  downloading: "Downloading track…",
  moving: "Adding to library…",
  blocked: "Needs review",
  completed: "Downloaded; waiting for library refresh",
  failed: "Retry download track",
}[status] || "Download track");

const activityDownloadStatus = (request) => {
  if (request?.status === "failed") return "failed";
  if (request?.status === "cancelled") return "cancelled";
  if (request?.status === "completed") return "completed";
  if (request?.status === "blocked") return "blocked";
  const label = text(request?.statusLabel).toLocaleLowerCase();
  if (label.includes("download")) return "downloading";
  if (label.includes("moving")) return "moving";
  if (request?.status === "pending") return "pending";
  return "searching";
};

const trackDownloadIdentity = (track, fallbackTitle = "") =>
  String(track?.id || track?.mbid || track?.trackMbid || track?.title || fallbackTitle);

const sameTrackText = (left, right) => {
  const first = text(left).toLocaleLowerCase();
  const second = text(right).toLocaleLowerCase();
  return Boolean(first) && Boolean(second) && first === second;
};

const TOP_ARTIST_TRACK_LIMIT = 10;

const NAME_SORT = { value: "name", label: "Name" };
const ARTIST_SORT = { value: "artist", label: "Artist" };
const NEWEST_SORT = { value: "newest", label: "Recently added" };
const SORT_OPTIONS_BY_SECTION = {
  albums: [NAME_SORT, ARTIST_SORT, NEWEST_SORT],
  tracks: [NAME_SORT, ARTIST_SORT, NEWEST_SORT],
  artists: [NAME_SORT, NEWEST_SORT],
  "album-artists": [NAME_SORT, NEWEST_SORT],
  genres: [NAME_SORT],
};
const QUERY_DEBOUNCE_MS = 250;

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const trackRating = (track) => {
  const value = track?.rating ?? track?.metadata?.rating ?? track?.metadata?.tags?.rating;
  const rating = Array.isArray(value) ? value[0] : value;
  const score = rating && typeof rating === "object" ? rating.rating : rating;
  return Number.isFinite(Number(score)) ? Number(score) : null;
};

const trackRecency = (track, albumsById) => {
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

const topArtistTracks = (tracks, albumsById) => {
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

const entityMatches = (entity, query) => {
  if (!query) return true;
  return [entity?.name, entity?.title, entity?.artistName, entity?.albumArtist, entity?.albumName]
    .some((value) => text(value).toLocaleLowerCase().includes(query));
};

function Cover({ src, label, round = false, compact = false }) {
  if (src) {
    return <img src={src} alt="" loading="lazy" decoding="async" />;
  }

  return (
    <span
      className={
        "native-library-cover-fallback" +
        (round ? " is-round" : "") +
        (compact ? " is-compact" : "")
      }
      role="img"
      aria-label={label || "Unknown artwork"}
    >
      {text(label).slice(0, 1).toUpperCase() || "—"}
    </span>
  );
}

function EmptyState({ title, message }) {
  return (
    <div className="native-library-state">
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

function LibraryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    section: routeSection,
    albumId: routeAlbumId,
    artistId: routeArtistId,
  } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { bootstrap, hasPermission, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading,
    playlistsError,
    setPlaylistsError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const { playQueue, currentTrack, isPlaying, isLoading, isStarting, togglePlayPause, matchesSource } =
    useAudioQueue();
  const isRunning = isPlaying || isStarting;
  const getQueueItems = useQueueTrackActions();
  const navigationType = useNavigationType();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const queryTimerRef = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [covers, setCovers] = useState({});
  const [pendingFavorite, setPendingFavorite] = useState(null);
  const favoriteMutationInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAttemptRef = useRef(0);
  const [playlistSavingKey, setPlaylistSavingKey] = useState("");
  const [trackDownloadStates, setTrackDownloadStates] = useState({});
  const [trackResearchStates, setTrackResearchStates] = useState({});
  const [libraryRemoval, setLibraryRemoval] = useState(null);
  const [libraryInfo, setLibraryInfo] = useState(null);
  const [mbidArtist, setMbidArtist] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deletingLibraryEntity, setDeletingLibraryEntity] = useState(false);
  const [homeAlbumsGridRef, homeAlbumColumns] = useResponsiveReleaseLimit({
    cardMinWidth: 152,
  });

  const handleLibraryScanMessage = useCallback((message) => {
    if (message?.type !== "library_scan_completed") return;
    clearLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, []);

  useWebSocketChannel("library", handleLibraryScanMessage);

  useEffect(() => () => {
    refreshAttemptRef.current += 1;
  }, []);

  const completeLibraryRefresh = useCallback(() => {
    clearLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, []);

  const pollLibraryRefresh = useCallback(async (jobId, attempt, successMessage = "") => {
    while (true) {
      const status = await getLibraryRefreshStatus(jobId);
      if (refreshAttemptRef.current !== attempt) return;
      if (status.status === "completed") {
        completeLibraryRefresh();
        if (successMessage) showSuccess(successMessage);
        return;
      }
      if (status.status === "failed") {
        throw new Error(status.error || "Library refresh failed");
      }
      await wait(750);
    }
  }, [completeLibraryRefresh, showSuccess]);

  useEffect(() => {
    let mounted = true;
    const restoreLibraryRefresh = async () => {
      try {
        const active = await getActiveLibraryRefresh();
        if (!mounted || !active?.jobId || !["queued", "running"].includes(active.status?.status)) return;
        const attempt = refreshAttemptRef.current + 1;
        refreshAttemptRef.current = attempt;
        setRefreshing(true);
        try {
          await pollLibraryRefresh(active.jobId, attempt);
        } catch (requestError) {
          if (refreshAttemptRef.current === attempt) {
            showError(requestError.response?.data?.message || requestError.message || "Library refresh failed");
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

  const refreshLibrary = useCallback(async (mode) => {
    if (refreshing) return;
    const attempt = refreshAttemptRef.current + 1;
    refreshAttemptRef.current = attempt;
    setRefreshing(true);
    try {
      clearLibraryPageCache();
      const queued = await requestLibraryRefresh(mode);
      const jobId = queued?.jobId;
      if (!jobId) throw new Error("Library refresh did not start");
      await pollLibraryRefresh(
        jobId,
        attempt,
        mode === "full" ? "Full scan complete" : "Library refreshed",
      );
    } catch (requestError) {
      if (refreshAttemptRef.current === attempt) {
        showError(requestError.response?.data?.message || requestError.message || "Library refresh failed");
      }
    } finally {
      if (refreshAttemptRef.current === attempt) setRefreshing(false);
    }
  }, [pollLibraryRefresh, refreshing, showError]);

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
  const isDetail = Boolean(routeAlbumId || routeArtistId);
  const albumSeed = routeAlbumId ? readRouteSeed(location.state) : null;
  const sharedArtworkStyle = useSharedArtworkStyle();
  const tab = libraryTabForSection(section);
  const selectedGenre = searchParams.get("genre") || "";
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";
  const sectionLabel = LIBRARY_VIEWS.find((view) => view.id === section)?.label || "Library";
  const librarySource = useMemo(
    () => ({ type: "native-library", id: "library", label: "Library" }),
    [],
  );
  const sortOptions = SORT_OPTIONS_BY_SECTION[section] || [];
  const requestedSort = searchParams.get("sort");
  const sortMode = sortOptions.some((option) => option.value === requestedSort)
    ? requestedSort
    : NAME_SORT.value;
  const sortDirection = searchParams.get("dir") === "desc" ? "desc" : "asc";
  const viewMode = searchParams.get("view") === "list" ? "list" : "grid";
  const requestedPage = Number(searchParams.get("page"));
  const pageIndex = Number.isSafeInteger(requestedPage) && requestedPage > 1 ? requestedPage : 1;
  const normalizedQuery = query.trim() ? urlQuery.trim().toLocaleLowerCase() : "";

  const updateViewParams = (changes, { replace = false } = {}) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    setSearchParams(next, { replace });
  };
  const updateViewParamsRef = useRef(updateViewParams);
  updateViewParamsRef.current = updateViewParams;

  const changeQuery = (value) => {
    setQuery(value);
    window.clearTimeout(queryTimerRef.current);
    const nextQuery = value.trim();
    const writeQuery = () =>
      updateViewParamsRef.current({ q: nextQuery, page: null }, { replace: true });
    if (!nextQuery) writeQuery();
    else queryTimerRef.current = window.setTimeout(writeQuery, QUERY_DEBOUNCE_MS);
  };

  useEffect(() => () => window.clearTimeout(queryTimerRef.current), []);

  useEffect(() => {
    if (navigationType === "REPLACE") return;
    window.clearTimeout(queryTimerRef.current);
    setQuery(urlQuery);
  }, [navigationType, urlQuery]);

  useEffect(() => {
    setSearchOpen(false);
    setFiltersOpen(false);
  }, [section]);

  const setPageIndex = (nextPage) =>
    updateViewParams({ page: nextPage > 1 ? nextPage : null });

  const libraryQueryOptions = useMemo(
    () => libraryViewQueryOptions({
      preview: forcePreview,
      section,
      albumId: routeAlbumId || null,
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
      routeAlbumId,
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
        previousView.albumId === view.albumId &&
        previousView.artistId === view.artistId
        ? previous
        : undefined;
    },
  });
  const libraryUpdating = libraryQuery.isPlaceholderData;

  const queryData = libraryQuery.data;
  const isPreviewLibrary = forcePreview || queryData?.isPreview === true;
  const library = queryData?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
  const favoriteIds = useMemo(
    () => queryData?.favoriteIds || (
      isPreviewLibrary ? new Set(libraryPreviewFavorites) : new Set()
    ),
    [isPreviewLibrary, queryData?.favoriteIds],
  );
  const loading = !forcePreview && libraryQuery.isPending;
  const error = forcePreview
    ? null
    : libraryQuery.error?.response?.data?.message ||
      libraryQuery.error?.response?.data?.error ||
      libraryQuery.error?.message ||
      null;
  const pageData = useMemo(() => {
    if (!queryData || isPreviewLibrary || isDetail || section === "favorites") return null;
    if (section === "home" && !Array.isArray(queryData.pageResults)) return null;
    return section === "home"
      ? {
          kind: "home",
          total: queryData.pageResults.reduce(
            (count, page) => count + Number(page?.total || 0),
            0,
          ),
        }
      : queryData.nextData;
  }, [isDetail, isPreviewLibrary, queryData, section]);
  const totalPages =
    pageData?.kind === tab && tab !== "genres"
      ? Math.ceil(pageData.total / pageData.pageSize)
      : 0;
  const lastPage = Math.max(totalPages, 1);

  useEffect(() => {
    if (pageData && pageIndex > lastPage) {
      updateViewParamsRef.current({ page: lastPage > 1 ? lastPage : null }, { replace: true });
    }
  }, [lastPage, pageData, pageIndex]);
  const setLibrary = useCallback((updater) => {
    queryClient.setQueryData(libraryQueryKey, (current) => {
      if (!current && !forcePreview) return current;
      const previous = current?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
      const next = typeof updater === "function" ? updater(previous) : updater;
      if (current && next === previous) return current;
      return { ...(current || {}), library: next };
    });
  }, [forcePreview, libraryQueryKey]);
  const setFavoriteIds = useCallback((updater) => {
    queryClient.setQueryData(libraryQueryKey, (current) => {
      if (!current && !forcePreview) return current;
      const previous = current?.favoriteIds || (
        forcePreview ? new Set(libraryPreviewFavorites) : new Set()
      );
      const next = typeof updater === "function" ? updater(previous) : updater;
      if (current && next === previous) return current;
      return { ...(current || {}), favoriteIds: next };
    });
  }, [forcePreview, libraryQueryKey]);

  const artistsById = useMemo(
    () => new Map(library.artists.map((artist) => [String(artist.id), artist])),
    [library.artists],
  );
  const albumsById = useMemo(
    () => new Map(library.albums.map((album) => [String(album.id), album])),
    [library.albums],
  );
  const tracksById = useMemo(
    () => new Map(library.tracks.map((track) => [String(track.id), track])),
    [library.tracks],
  );

  const getAlbumTracks = useCallback(
    (album) => getCachedAlbumTracks(album, tracksById),
    [tracksById],
  );

  const loadAlbumTracks = useCallback(async (album) => {
    if (!album?.id) return [];
    const releaseGroupMbid = album?.releaseGroupMbid || null;
    const result = await queryClient.fetchQuery({
      queryKey: queryKeys.libraryAlbumTracks(String(album.id), releaseGroupMbid),
      queryFn: async ({ signal }) => {
        const page = await getLibraryPage({
          kind: "tracks",
          albumId: album.id,
          page: 1,
          pageSize,
          // Full tracklist regardless of the library-wide availability setting;
          // availability is surfaced per-track via badges after merging metadata.
          availableOnly: false,
        }, { signal });
        const ownedTracks = Array.isArray(page?.items) ? page.items : [];
        const pageArtist = page?.artists?.[0] || null;
        if (!releaseGroupMbid) return { tracks: ownedTracks, page };
        try {
          const metadataTracks = await getReleaseGroupTracks(releaseGroupMbid, {
            artistMbid: album?.artistMbid || pageArtist?.mbid || "",
            artistName:
              album?.artistName || pageArtist?.name || album?.albumArtist || "",
            albumTitle: album?.title || album?.albumName || "",
            releaseDate: album?.releaseDate || "",
            signal,
          });
          return {
            tracks: mergeAlbumMetadataTracks(
              ownedTracks,
              metadataTracks,
              album,
              pageArtist,
            ),
            page,
          };
        } catch {
          return { tracks: ownedTracks, page };
        }
      },
      staleTime: 5 * 60 * 1000,
    });
    const tracks = result.tracks;
    const page = result.page;
    setLibrary((current) => mergeAlbumTrackPageIntoLibrary(current, page, album.id, tracks));
    return tracks;
  }, [setLibrary]);

  const getAlbumForTrack = useCallback(
    (track) => {
      const fileAlbumId = firstAvailableFile(track)?.albumId;
      const relation = track?.albums?.find((entry) => entry.albumId === fileAlbumId)
        || track?.albums?.[0];
      return relation ? albumsById.get(String(relation.albumId)) : null;
    },
    [albumsById],
  );

  const getArtistForAlbum = useCallback(
    (album) => (album ? artistsById.get(String(album.artistId)) : null),
    [artistsById],
  );

  const getDefaultTrackPlaylistName = useCallback(
    (track) =>
      reserveUniquePlaylistName(
        staticPlaylists,
        `${getArtistForAlbum(getAlbumForTrack(track))?.name || track?.artistName || "Artist"} Picks`,
      ),
    [getAlbumForTrack, getArtistForAlbum, staticPlaylists],
  );

  const addLibraryTrackToPlaylist = useCallback(
    async (track, target) => {
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const payload = buildStaticPlaylistTrackPayload({
        artistName: artist?.name || track?.artistName || "",
        trackName: track?.title || "",
        albumName: album?.title || "",
        artistMbid: artist?.mbid || "",
        albumMbid: album?.releaseGroupMbid || album?.mbid || "",
        trackMbid: track?.mbid || "",
        releaseYear: yearOf(album?.releaseDate),
        durationMs: trackDurationMs(track),
      });
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return;
      }
      const key = String(track?.id || "");
      setPlaylistSavingKey(key);
      setPlaylistsError("");
      try {
        if (target?.mode === "new") {
          const name =
            String(target?.name || "").trim() ||
            getDefaultTrackPlaylistName(track);
          await createStaticPlaylist({ name, tracks: [payload] });
          showSuccess(`Track saved to ${name}`);
        } else {
          const playlist = staticPlaylists.find(
            (candidate) => candidate.id === target?.playlistId,
          );
          await addStaticPlaylistTracks(target?.playlistId, { tracks: [payload] });
          showSuccess(`Track added to ${playlist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) setStaticPlaylists(nextPlaylists);
      } catch (requestError) {
        const message =
          requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          "Failed to save track to playlist";
        setPlaylistsError(message);
        showError(message);
      } finally {
        setPlaylistSavingKey("");
      }
    },
    [
      getAlbumForTrack,
      getArtistForAlbum,
      getDefaultTrackPlaylistName,
      loadStaticPlaylists,
      setPlaylistsError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const removeLibraryTrackFromPlaylist = useCallback(
    async (track, target) => {
      if (!target?.playlistId || !target?.jobId) return;
      const key = String(track?.id || "");
      setPlaylistSavingKey(key);
      setPlaylistsError("");
      try {
        const result = await deleteStaticPlaylistTrack(target.playlistId, target.jobId);
        showSuccess(
          result?.queued
            ? `Removal queued for ${track?.title || "track"}`
            : `Removed ${track?.title || "track"} from playlist`,
        );
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) setStaticPlaylists(nextPlaylists);
      } catch (requestError) {
        const message =
          requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          "Failed to remove track from playlist";
        setPlaylistsError(message);
        showError(message);
      } finally {
        setPlaylistSavingKey("");
      }
    },
    [loadStaticPlaylists, setPlaylistsError, setStaticPlaylists, showError, showSuccess],
  );

  const canDeleteArtist = hasPermission("deleteArtist");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const canDeleteTrack = hasPermission("deleteTrack") || canDeleteAlbum;
  const canAddTracks = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const libraryDestination = useLibraryDestination();
  const { isAlbumDownloading, isTrackDownloading } = useActiveDownloads();
  const canEditArtistMbid = hasPermission("addArtist");

  const openLibraryRemoval = useCallback((kind, entity, manager = null) => {
    setDeleteFiles(false);
    setLibraryRemoval({ kind, entity, manager });
  }, []);

  const removeLocalLibraryEntity = useCallback((removal) => {
    if (!removal?.entity) return;
    const entityId = String(removal.entity.id);
    setLibrary((current) => {
      if (removal.kind === "artist") {
        const removedAlbumIds = new Set(
          current.albums
            .filter((album) => String(album.artistId) === entityId)
            .map((album) => String(album.id)),
        );
        return {
          ...current,
          artists: current.artists.filter((artist) => String(artist.id) !== entityId),
          albums: current.albums.filter((album) => !removedAlbumIds.has(String(album.id))),
          tracks: current.tracks.filter(
            (track) =>
              String(track.artistId) !== entityId &&
              !removedAlbumIds.has(String(track.albumId)) &&
              !(track.albums || []).some((relation) => removedAlbumIds.has(String(relation.albumId))),
          ),
        };
      }
      if (removal.kind === "album") {
        return {
          ...current,
          albums: current.albums.filter((album) => String(album.id) !== entityId),
          tracks: current.tracks.filter(
            (track) =>
              String(track.albumId) !== entityId &&
              !(track.albums || []).some((relation) => String(relation.albumId) === entityId),
          ),
        };
      }
      return {
        ...current,
        tracks: current.tracks.filter((track) => String(track.id) !== entityId),
      };
    });
    clearLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, [setLibrary]);

  const handleLibraryRemovalConfirm = useCallback(async () => {
    if (!libraryRemoval?.entity || deletingLibraryEntity) return;
    const removal = libraryRemoval;
    const entity = removal.entity;
    const trackHasFile = removal.kind === "track" && Boolean(firstAvailableFile(entity));
    setDeletingLibraryEntity(true);
    try {
      if (!isPreviewLibrary) {
        if (removal.kind === "artist") {
          await deleteArtistFromLibrary(entity.mbid, deleteFiles);
        } else if (removal.kind === "album" && resolveAlbumManager(entity) === "aurral") {
          await deleteAurralAlbumFromLibrary(entity.canonicalId || entity.id, deleteFiles);
        } else if (removal.kind === "album" && /^\d+$/.test(String(entity.providerId ?? ""))) {
          await deleteAlbumFromLibrary(entity.providerId, deleteFiles);
        } else if (removal.kind === "album") {
          await deleteLidarrAlbumFromLibrary(entity.releaseGroupMbid || entity.mbid, deleteFiles);
        } else {
          await deleteTrackFromLibrary(entity.id);
        }
      }
      removeLocalLibraryEntity(removal);
      setLibraryRemoval(null);
      showSuccess(
        removal.kind === "artist"
          ? "Artist deleted"
          : removal.kind === "album"
            ? "Album deleted"
            : trackHasFile
              ? "Track deleted"
              : "Track removed from library",
      );
      if (
        (removal.kind === "artist" && String(routeArtistId) === String(entity.id)) ||
        (removal.kind === "album" && String(routeAlbumId) === String(entity.id))
      ) {
        navigate(
          removal.kind === "artist"
            ? "/library/artists" + previewQuery
            : "/library/albums" + previewQuery,
        );
      }
    } catch (requestError) {
      showError(
        requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          "Failed to update library",
      );
    } finally {
      setDeletingLibraryEntity(false);
    }
  }, [
    deleteFiles,
    deletingLibraryEntity,
    isPreviewLibrary,
    libraryRemoval,
    navigate,
    previewQuery,
    removeLocalLibraryEntity,
    routeAlbumId,
    routeArtistId,
    showError,
    showSuccess,
  ]);

  const refreshLibraryArtistMonitoring = useCallback(() => {
    clearLibraryPageCache();
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    return queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, []);

  const downloadMissingTrack = useCallback(
    async (track) => {
      if (!track || firstAvailableFile(track) || isPreviewLibrary) return null;
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const payload = {
        artistName: artist?.name || track?.artistName || "",
        trackName: track?.title || track?.trackName || "",
        albumName: album?.title || track?.albumName || "",
        artistMbid: artist?.mbid || track?.artistMbid || "",
        albumMbid: album?.releaseGroupMbid || album?.mbid || track?.albumMbid || "",
        trackMbid: track?.mbid || track?.trackMbid || "",
        releaseYear: yearOf(album?.releaseDate),
        durationMs: trackDurationMs(track),
        canonicalTrackId: /^\d+$/.test(String(track?.id ?? "")) ? String(track.id) : null,
      };
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return null;
      }
      const key = trackDownloadIdentity(track, payload.trackName);
      setTrackDownloadStates((current) => ({
        ...current,
        [key]: { jobId: null, status: "submitting" },
      }));
      try {
        const result = await downloadTrackToLibrary(payload);
        if (result?.alreadyOwned) {
          setTrackDownloadStates(({ [key]: _, ...rest }) => rest);
        } else {
          setTrackDownloadStates((current) => ({
            ...current,
            [key]: {
              jobId: result?.jobId || null,
              status: result?.reused ? "moving" : "searching",
            },
          }));
        }
        showSuccess(
          result?.alreadyOwned
            ? `${payload.trackName} is already in your library`
            : result?.queued
              ? `Queued ${payload.trackName} for your library`
              : `Added ${payload.trackName} to your library`,
        );
        return result;
      } catch (requestError) {
        setTrackDownloadStates(({ [key]: _, ...rest }) => rest);
        showError(
          requestError.response?.data?.message ||
            requestError.response?.data?.error ||
            requestError.message ||
            "Failed to add track to library",
        );
        return null;
      }
    },
    [getAlbumForTrack, getArtistForAlbum, isPreviewLibrary, showError, showSuccess],
  );

  const handleReSearchLibraryTrack = useCallback(
    async (track, album) => {
      if (!track?.id || !album?.id || isPreviewLibrary || !canAddTracks) return;
      const key = `${track.id}:${album.id}`;
      setTrackResearchStates((current) => ({ ...current, [key]: true }));
      try {
        await reSearchLibraryTrack(track.id, { albumId: album.id });
        showSuccess(`Queued a replacement search for ${track.title || "track"}`);
      } catch (requestError) {
        showError(
          requestError.response?.data?.message ||
            requestError.response?.data?.error ||
            requestError.message ||
            "Failed to queue a replacement search",
        );
      } finally {
        setTrackResearchStates((current) => {
          const { [key]: _, ...rest } = current;
          return rest;
        });
      }
    },
    [canAddTracks, isPreviewLibrary, showError, showSuccess],
  );

  const albumAvailability = useCallback(
    (album) => {
      const tracks = getAlbumTracks(album);
      const total = album?.trackCount || tracks.length || (album?.trackIds || []).length;
      const available = album?.availableTrackCount != null && tracks.length !== total
        ? album.availableTrackCount
        : tracks.filter((track) => firstAvailableFile(track)).length;
      return { total, available };
    },
    [getAlbumTracks],
  );

  const filteredArtists = useMemo(
    () =>
      library.artists.filter(
        (artist) =>
          hasGenre(selectedGenre, artist) && entityMatches(artist, normalizedQuery),
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
              artistName: artist?.name || track.artistName,
            },
            normalizedQuery,
          )
        );
      }),
    [getAlbumForTrack, getArtistForAlbum, normalizedQuery, ownedLibraryTracks, selectedGenre],
  );

  const genreStats = useMemo(() => {
    if (library.genres?.length) return library.genres;
    const stats = new Map();
    const add = (genre, kind) => {
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
        (genre) =>
          !normalizedQuery ||
          genre.name.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [genreStats, normalizedQuery],
  );

  const favoriteArtists = useMemo(
    () =>
      library.artists.filter(
        (artist) =>
          favoriteIds.has(favoriteId("artist", artist)) &&
          entityMatches(artist, normalizedQuery),
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
              artistName: artist?.name || track.artistName,
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
        return text(getArtistForAlbum(getAlbumForTrack(left))?.name).localeCompare(
          text(getArtistForAlbum(getAlbumForTrack(right))?.name),
        );
      }
      return text(left.title).localeCompare(text(right.title));
    });
    return sortDirection === "asc" ? items : items.reverse();
  }, [filteredTracks, getAlbumForTrack, getArtistForAlbum, sortDirection, sortMode]);

  const sortedGenres = useMemo(() => {
    const items = [...visibleGenreStats].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
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
  const libraryAlbum = routeAlbumId ? albumsById.get(String(routeAlbumId)) || null : null;
  const libraryArtist = routeArtistId ? artistsById.get(String(routeArtistId)) || null : null;
  const libraryArtistMonitoring = useArtistMonitoring({
    mbid: !isPreviewLibrary ? libraryArtist?.mbid : null,
    artistName: libraryArtist?.name,
    canChange: canChangeMonitoring,
    canAdd: canEditArtistMbid,
    onChanged: refreshLibraryArtistMonitoring,
  });
  const libraryArtistMonitoringItems = (() => {
    if (!libraryArtist?.mbid || isPreviewLibrary || !libraryArtistMonitoring.ready) return [];
    const { label, monitoringItems, reason } = libraryArtistMonitoring;
    const submenuItems = reason
      ? [{ id: "monitoring-blocked", label: reason, disabled: true }]
      : monitoringItems;
    return submenuItems.length
      ? [{
          id: "monitoring",
          label: `Monitor: ${label}`,
          icon: Eye,
          separatorBefore: true,
          submenuItems,
        }]
      : [];
  })();
  const hasMissingAlbumTracks = Boolean(
    libraryAlbum && getAlbumTracks(libraryAlbum).some((track) => !firstAvailableFile(track)),
  );
  const activityQueryKey = useMemo(
    () => queryKeys.libraryActivityRequests(user?.id),
    [user?.id],
  );
  const hasTrackDownloadPolling = Object.values(trackDownloadStates).some(
    (state) =>
      state?.jobId &&
      state.status !== "completed" &&
      TRACK_DOWNLOAD_ACTIVE_STATUSES.has(state.status),
  );
  const activityQuery = useQuery({
    queryKey: activityQueryKey,
    queryFn: ({ signal }) => getRequests({ refresh: true, signal }),
    enabled: Boolean(libraryAlbum && !isPreviewLibrary && hasMissingAlbumTracks),
    staleTime: 0,
    refetchInterval: hasTrackDownloadPolling ? 4000 : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!libraryAlbum || isPreviewLibrary) return;
    loadAlbumTracks(libraryAlbum).catch(() => {});
  }, [isPreviewLibrary, libraryAlbum, loadAlbumTracks]);

  const aurralAlbumStatusKeys = useMemo(() => {
    if (libraryAlbum || isPreviewLibrary) return [];
    return library.albums
      .filter((album) => {
        if (album.managedBy !== "aurral") return false;
        const { total, available } = albumAvailability(album);
        return !total || available < total;
      })
      .map((album) => aurralAlbumStatusKey(album.id))
      .sort();
  }, [albumAvailability, isPreviewLibrary, library.albums, libraryAlbum]);
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

  const refreshLibraryActivity = useCallback(
    () => queryClient.invalidateQueries({ queryKey: activityQueryKey }),
    [activityQueryKey],
  );
  const updateAlbumMonitoringState = useCallback(
    (albumId, result) => {
      const monitored = result?.monitored === true;
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(albumId)
            ? { ...entry, monitored, monitorMode: monitored ? "monitored" : "unmonitored" }
            : entry,
        ),
      }));
      clearLibraryPageCache();
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      refreshLibraryActivity();
    },
    [refreshLibraryActivity, setLibrary],
  );
  const albumMonitoring = useAurralAlbumMonitoring({
    album: libraryAlbum,
    enabled: Boolean(libraryAlbum) && !isPreviewLibrary,
    canChange: canChangeMonitoring,
    hasMissingTracks: hasMissingAlbumTracks,
    onChanged: updateAlbumMonitoringState,
  });
  const updateTrackMonitoringState = useCallback(
    (trackId, result) => {
      const monitored = result?.monitored !== false;
      const mark = (track) =>
        String(track.id) === String(trackId) ? { ...track, monitored } : track;
      setLibrary((current) => ({ ...current, tracks: current.tracks.map(mark) }));
      queryClient.setQueriesData({ queryKey: queryKeys.libraryAlbumTracksPrefix }, (data) =>
        Array.isArray(data?.tracks) ? { ...data, tracks: data.tracks.map(mark) } : data,
      );
      clearLibraryPageCache();
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      refreshLibraryActivity();
    },
    [refreshLibraryActivity, setLibrary],
  );
  const trackMonitoring = useAurralTrackMonitoring({
    canChange: canChangeMonitoring,
    onChanged: updateTrackMonitoringState,
  });

  const reloadLibraryAlbumTracks = useCallback(async () => {
    if (!libraryAlbum) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracks(String(libraryAlbum.id), libraryAlbum.releaseGroupMbid || null),
    });
    await loadAlbumTracks(libraryAlbum).catch(() => {});
  }, [libraryAlbum, loadAlbumTracks]);

  const [albumDownloadPending, setAlbumDownloadPending] = useState(false);
  const libraryAlbumDownloading =
    albumDownloadPending ||
    isAlbumDownloading(libraryAlbum?.releaseGroupMbid || libraryAlbum?.mbid);
  const albumManager = resolveAlbumManager(libraryAlbum);
  const activeManager = libraryDestination.primary;
  const lidarrAlbumId =
    albumManager === "lidarr" && /^\d+$/.test(String(libraryAlbum?.providerId ?? ""))
      ? libraryAlbum.providerId
      : null;
  const albumMonitored =
    albumManager === "aurral" ? albumMonitoring.monitored
      : lidarrAlbumId ? libraryAlbum.monitored === true
        : null;
  const canDownloadLibraryAlbum = (() => {
    if (!canAddTracks || isPreviewLibrary || !libraryAlbum || !hasMissingAlbumTracks) return false;
    if (!libraryDestination.ready || !(libraryAlbum.releaseGroupMbid || libraryAlbum.mbid)) return false;
    if (activeManager === "lidarr") return true;
    if (albumManager === "aurral") return canDownloadAurralAlbum(libraryAlbum, { hasMissingTracks: true });
    return albumManager !== "lidarr";
  })();
  const downloadLibraryAlbum = useCallback(async () => {
    if (!libraryAlbum) return;
    const title = libraryAlbum.title || "album";
    setAlbumDownloadPending(true);
    try {
      const result = await requestAlbumFromSearch({
        ...buildAurralAlbumRetryPayload({ album: libraryAlbum, artist: getArtistForAlbum(libraryAlbum) }),
        managedBy: activeManager,
        triggerSearch: activeManager === "lidarr",
      });
      const queued = result?.jobIds?.length || 0;
      showSuccess(
        activeManager === "lidarr"
          ? describeAlbumRequestResult(result, title, "lidarr").message
          : queued > 0
            ? `Queued ${queued} ${queued === 1 ? "track" : "tracks"} from ${title}`
            : `Monitoring ${title}`,
      );
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(libraryAlbum.id) ? { ...entry, managedBy: activeManager } : entry,
        ),
      }));
      updateAlbumMonitoringState(libraryAlbum.id, { monitored: true });
      await reloadLibraryAlbumTracks();
    } catch (requestError) {
      showError(
        requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          `Failed to download ${title}`,
      );
    } finally {
      setAlbumDownloadPending(false);
    }
  }, [activeManager, getArtistForAlbum, libraryAlbum, reloadLibraryAlbumTracks, setLibrary, showError, showSuccess, updateAlbumMonitoringState]);

  const setLidarrAlbumMonitored = useCallback(async (monitored) => {
    if (!lidarrAlbumId) return;
    const title = libraryAlbum.title || "Album";
    try {
      await updateLibraryAlbum(lidarrAlbumId, { monitored });
      updateAlbumMonitoringState(libraryAlbum.id, { monitored });
      showSuccess(monitored ? `${title} monitored in Lidarr` : `${title} unmonitored in Lidarr`);
    } catch (requestError) {
      showError(
        requestError.response?.data?.message ||
          requestError.response?.data?.error ||
          requestError.message ||
          "Could not update album monitoring",
      );
    }
  }, [libraryAlbum, lidarrAlbumId, showError, showSuccess, updateAlbumMonitoringState]);
  const lidarrAlbumAction =
    activeManager === "lidarr" && lidarrAlbumId && canChangeMonitoring
      ? getMonitoringMenuAction({ monitored: albumMonitored, hasMissing: hasMissingAlbumTracks })
      : null;
  const albumMonitoringMenuItem = albumManager === "lidarr"
    ? lidarrAlbumAction && {
        id: "monitoring",
        label: lidarrAlbumAction === "stop" ? "Stop monitoring album" : "Monitor album",
        icon: lidarrAlbumAction === "stop" ? EyeOff : Eye,
        separatorBefore: true,
        closeBeforeSelect: true,
        onSelect: () => setLidarrAlbumMonitored(lidarrAlbumAction !== "stop"),
      }
    : activeManager === "aurral" || albumMonitoring.monitored
      ? albumMonitoring.menuItem
      : albumMonitoring.menuItem && { ...albumMonitoring.menuItem, onSelect: downloadLibraryAlbum };

  useEffect(() => {
    if (!libraryAlbum || isPreviewLibrary) return undefined;
    const tracks = getAlbumTracks(libraryAlbum);
    if (!tracks.length) return undefined;
    if (!Array.isArray(activityQuery.data)) return undefined;
    const requests = activityQuery.data;
    const activeRequests = requests.filter(
      (request) =>
        request?.kind === "track_download" &&
        request?.playlistId === "library" &&
        ["pending", "processing", "blocked"].includes(request?.status),
    );
    const nextStates = {};
    const requestsByJobId = new Map(
      requests
        .filter((request) => request?.jobId)
        .map((request) => [String(request.jobId), request]),
    );
    for (const track of tracks) {
      if (firstAvailableFile(track)) continue;
      const request = activeRequests.find(
        (candidate) =>
          sameTrackText(candidate.trackName, track.title) &&
          sameTrackText(candidate.artistName, track.artistName || libraryAlbum.albumArtist) &&
          (!candidate.albumName || sameTrackText(candidate.albumName, libraryAlbum.title)),
      );
      if (request?.jobId) {
        nextStates[trackDownloadIdentity(track)] = {
          jobId: request.jobId,
          status: activityDownloadStatus(request),
        };
      }
    }
    setTrackDownloadStates((current) => {
      const next = { ...current };
      for (const track of tracks) {
        const key = trackDownloadIdentity(track);
        if (nextStates[key]) next[key] = nextStates[key];
        else if (next[key]?.status !== "submitting") delete next[key];
      }
      Object.entries(current).forEach(([key, state]) => {
        const request = state?.jobId ? requestsByJobId.get(String(state.jobId)) : null;
        if (request && activityDownloadStatus(request) !== state.status) {
          next[key] = { ...state, status: activityDownloadStatus(request) };
        }
      });
      return next;
    });
  }, [activityQuery.data, getAlbumTracks, isPreviewLibrary, libraryAlbum, library.tracks]);

  useDocumentTitle(
    isDetail
      ? libraryAlbum?.title || libraryArtist?.name || "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : "Library",
  );

  const coverItems = useMemo(() => {
    const items = library.albums
      .map((album) => ({
        mbid: getAlbumCoverId(album),
        coverUrl: album.coverUrl,
        artistName: getArtistForAlbum(album)?.name || album.albumArtist,
        albumTitle: album.title,
      }))
      .filter((item) => item.mbid && !item.coverUrl);
    return items
      .filter(
        (item, index, values) =>
          values.findIndex((candidate) => candidate.mbid === item.mbid) === index,
      )
      .slice(0, 80);
  }, [getArtistForAlbum, library.albums]);

  useEffect(() => {
    if (!coverItems.length) return undefined;
    let cancelled = false;
    getReleaseGroupCoversBatch(coverItems)
      .then((result) => {
        if (cancelled) return;
        const next = {};
        coverItems.forEach((item) => {
          if (result?.[item.mbid]?.image) next[item.mbid] = result[item.mbid].image;
        });
        if (Object.keys(next).length) setCovers((current) => ({ ...current, ...next }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [coverItems]);

  const getAlbumCover = useCallback(
    (album) => album?.coverUrl || covers[getAlbumCoverId(album)] || "",
    [covers],
  );
  const albumTint = useCollectionTint(libraryAlbum ? getAlbumCover(libraryAlbum) : null);

  const buildPlayableTrack = useCallback(
    (track) => {
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const file = firstAvailableFile(track, album?.id);
      return {
        id: track.id,
        title: track.title,
        artist: artist?.name || track.artistName || "Unknown Artist",
        album: album?.title || track.albumName || track.album || "Unknown Album",
        src:
          file?.previewUrl ||
          (file && album
            ? buildAuthenticatedApiUrl(
                `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
              )
            : ""),
        streamFormat: file?.format || null,
        quality: file?.quality || null,
        artistMbid: artist?.mbid || null,
        albumMbid: album?.releaseGroupMbid || album?.mbid || null,
        trackMbid: track.mbid || track.trackMbid || null,
        durationMs: Number(track.durationMs || file?.durationMs || 0) || null,
        recordHistory: true,
        artwork: getAlbumCover(album),
      };
    },
    [getAlbumCover, getAlbumForTrack, getArtistForAlbum],
  );

  const playTracks = useCallback(
    (tracks, startTrack = null, shuffle = false) => {
      const playable = tracks.map(buildPlayableTrack).filter((track) => track.src);
      if (!playable.length) {
        showError("No playable files are available in this selection.");
        return;
      }
      playQueue(playable, {
        startTrackId: startTrack?.id ?? null,
        shuffle,
        source: librarySource,
      });
    },
    [buildPlayableTrack, librarySource, playQueue, showError],
  );

  const playAlbum = useCallback(async (album) => {
    try {
      const tracks = await loadAlbumTracks(album);
      playTracks(tracks);
    } catch (requestError) {
      showError(requestError.response?.data?.message || "Failed to load album tracks");
    }
  }, [loadAlbumTracks, playTracks, showError]);

  const toggleFavorite = useCallback(
    async (kind, entity) => {
      const id = favoriteId(kind, entity);
      if (!id || id.endsWith(":") || favoriteMutationInFlightRef.current) return;
      const nextStarred = !favoriteIds.has(id);
      if (isPreviewLibrary) {
        setFavoriteIds((current) => {
          const next = new Set(current);
          if (nextStarred) next.add(id);
          else next.delete(id);
          return next;
        });
        return;
      }
      const previous = favoriteIds;
      favoriteMutationInFlightRef.current = true;
      setPendingFavorite(id);
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (nextStarred) next.add(id);
        else next.delete(id);
        return next;
      });
      try {
        const result = await updateLibraryFavorites([id], nextStarred);
        if (Array.isArray(result?.changedIds)) {
          setFavoriteIds((current) => {
            const next = new Set(current);
            for (const changedId of result.changedIds) {
              if (nextStarred) next.add(changedId);
              else next.delete(changedId);
            }
            return next;
          });
        }
      } catch (requestError) {
        setFavoriteIds(previous);
        showError(requestError.response?.data?.message || "Failed to update favorites");
      } finally {
        favoriteMutationInFlightRef.current = false;
        setPendingFavorite(null);
      }
    },
    [favoriteIds, isPreviewLibrary, setFavoriteIds, showError],
  );

  const playTrack = useCallback(
    (track, context) => {
      const playable = buildPlayableTrack(track);
      if (!playable.src) return;
      if (
        String(currentTrack?.id) === String(playable.id) &&
        matchesSource(librarySource)
      ) {
        togglePlayPause();
        return;
      }
      playTracks(context || [track], track);
    },
    [
      buildPlayableTrack,
      currentTrack?.id,
      librarySource,
      matchesSource,
      playTracks,
      togglePlayPause,
    ],
  );

  const libraryArtistPath = (artist) =>
    artist?.id ? "/library/artist/" + encodeURIComponent(artist.id) + previewQuery : null;
  const libraryAlbumPath = (album) =>
    album?.id ? "/library/album/" + encodeURIComponent(album.id) + previewQuery : null;

  const handleArtistOpen = (artist) => {
    const path = libraryArtistPath(artist);
    if (path) navigate(path);
  };

  const artistMbidMenuItems = (artist) =>
    canEditArtistMbid && artist?.providerId == null
      ? [
          {
            id: "mbid",
            label: "Edit MusicBrainz ID",
            icon: Fingerprint,
            onSelect: () => setMbidArtist(artist),
          },
        ]
      : [];

  const handleArtistMbidSaved = (result) => {
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

  const openLibraryInfo = (kind, entity, context = {}) => {
    setLibraryInfo({ kind, entity, ...context });
  };

  const discoverArtistState = (artist) => ({
    artistName: artist.name,
    inLibrary: true,
    libraryArtist: artist,
  });

  const handleDiscoverArtistOpen = (artist) => {
    if (!artist?.mbid) return;
    navigate("/artist/" + encodeURIComponent(artist.mbid), {
      state: discoverArtistState(artist),
    });
  };

  const handleAlbumOpen = (album) => {
    const path = libraryAlbumPath(album);
    if (path) navigate(path);
  };

  const handleDiscoverAlbumOpen = (album) => {
    handleDiscoverArtistOpen(getArtistForAlbum(album));
  };

  const favoriteCount =
    favoriteArtists.length + favoriteAlbums.length + favoriteTracks.length;
  const activeCount =
    section === "home"
          ? pageData?.total ?? library.albums.length + ownedLibraryTracks.length
      : section === "favorites"
        ? favoriteCount
        : pageData?.kind === tab
          ? pageData.total
        : tab === "artists"
          ? sortedArtists.length
          : tab === "albums"
            ? sortedAlbums.length
            : tab === "tracks"
              ? sortedTracks.length
              : sortedGenres.length;
  const collectionTracks = useMemo(() => {
    if (libraryAlbum) return getAlbumTracks(libraryAlbum);
    if (section === "favorites") return favoriteTracks;
    if (section === "albums") return sortedAlbums.flatMap(getAlbumTracks);
    if (section === "tracks") return sortedTracks;
    if (section === "genres" && selectedGenre) return filteredTracks;
      return ownedLibraryTracks;
  }, [
    favoriteTracks,
    filteredTracks,
    getAlbumTracks,
    libraryAlbum,
    ownedLibraryTracks,
    section,
    selectedGenre,
    sortedAlbums,
    sortedTracks,
  ]);

  const collectionPlayable = collectionTracks.some((track) => firstAvailableFile(track));

  const updateGenreFilter = (genre) => updateViewParams({ genre, page: null });

  const renderTrackList = (tracks, label, { variant = "collection" } = {}) => (
    <TrackList
      label={label}
      variant={variant}
      rows={tracks.map((track, index) => {
        const album = getAlbumForTrack(track);
        const artist = getArtistForAlbum(album);
        const file = firstAvailableFile(track);
        const researchFile = firstAvailableAurralFile(track);
        const researchAlbumRelation = track?.albums?.find(
          (entry) => String(entry.albumId) === String(researchFile?.albumId),
        );
        const researchAlbum = researchAlbumRelation
          ? albumsById.get(String(researchAlbumRelation.albumId))
          : null;
        const downloadKey = trackDownloadIdentity(track);
        const downloadState = trackDownloadStates[downloadKey];
        const backgroundDownload =
          !file &&
          (isTrackDownloading({ ...track, artistName: artist?.name || track.artistName }) ||
            isAlbumDownloading(album?.releaseGroupMbid || album?.mbid));
        const downloadPending =
          TRACK_DOWNLOAD_ACTIVE_STATUSES.has(downloadState?.status) || backgroundDownload;
        const downloadLabel = trackDownloadActionLabel(
          downloadState?.status || (backgroundDownload ? "downloading" : null),
        );
        const active =
          String(currentTrack?.id) === String(track.id) &&
          matchesSource(librarySource);
        const artistName = artist?.name || track.artistName || "Unknown Artist";
        const albumName = album?.title || track.albumName || track.album || "Unknown Album";
        const trackNumber = track.albums?.find(
          (entry) => String(entry.albumId) === String(album?.id),
        )?.trackNumber;
        const isFavorite = favoriteIds.has(favoriteId("song", track));
        const monitoringItem = trackMonitoring.getMenuItem(track, {
          aurral: album?.managedBy === "aurral" || hasAurralTrackFile(track) || downloadPending,
          hasFile: Boolean(file),
          downloadPending,
        });
        const downloadTrack = () =>
          downloadMissingTrack(track).then((result) => {
            if (result?.monitored) updateTrackMonitoringState(track.id, result);
          });
        const queueItems = file
          ? getQueueItems(buildPlayableTrack(track), { source: librarySource })
          : [];
        const trackMenuItems = [
          {
            id: "play",
            label: active && isRunning ? "Pause" : "Play",
            icon: active && isRunning ? Pause : Play,
            onSelect: () => playTrack(track, tracks),
            disabled: !file,
          },
          ...queueItems,
          {
            id: "info",
            label: "View info",
            icon: Info,
            onSelect: () => openLibraryInfo("track", track, { artist, album, trackNumber }),
          },
          {
            id: "favorite",
            label: isFavorite ? "Remove from favorites" : "Add to favorites",
            icon: Heart,
            selected: isFavorite,
            separatorBefore: true,
            onSelect: () => toggleFavorite("song", track),
          },
          ...(!file
            ? [
                {
                  id: "download",
                  label: downloadLabel,
                  icon: Download,
                  separatorBefore: true,
                  onSelect: downloadTrack,
                  disabled: isPreviewLibrary || downloadPending,
                },
              ]
            : []),
          ...(researchAlbum?.id && researchFile && canAddTracks
            ? [
                {
                  id: "research",
                  label: "Re-search",
                  icon: RefreshCw,
                  separatorBefore: true,
                  disabled: isPreviewLibrary || trackResearchStates[`${track.id}:${researchAlbum.id}`] === true,
                  onSelect: () => handleReSearchLibraryTrack(track, researchAlbum),
                },
              ]
            : []),
          ...(monitoringItem ? [monitoringItem] : []),
          ...(album
            ? [
                {
                  id: "album",
                  label: "Go to album",
                  icon: ExternalLink,
                  separatorBefore: true,
                  onSelect: () => handleAlbumOpen(album),
                },
              ]
            : []),
          ...(artist
            ? [
                {
                  id: "artist",
                  label: "Go to artist",
                  icon: UserRound,
                  onSelect: () => handleArtistOpen(artist),
                },
              ]
            : []),
          ...(canDeleteTrack && (file || hasAurralTrackFile(track))
            ? [
                {
                  id: "delete",
                  label: file ? "Delete track file" : "Remove track from library",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => openLibraryRemoval("track", track),
                },
              ]
            : []),
        ];
        return {
          key: track.id,
          number: variant === "release" && trackNumber ? trackNumber : index + 1,
          title: track.title || "Unknown Track",
          badge: track.monitored === false ? (
            <span className="native-library-track__unmonitored" role="img" aria-label="Not monitored">
              <EyeOff aria-hidden="true" />
            </span>
          ) : null,
          subtitle: artistName,
          artist: { label: artistName, to: libraryArtistPath(artist) },
          album: { label: albumName, to: libraryAlbumPath(album) },
          cover: {
            src: album ? getAlbumCover(album) : "",
            label: albumName,
            to: libraryAlbumPath(album),
          },
          time: formatDuration(trackDurationMs(track)) || "Unavailable",
          timeMissing: !file,
          active,
          playing: active && isRunning,
          loading: active && isLoading,
          missing: !file,
          onPlay: file ? () => playTrack(track, tracks) : null,
          trailing: !file ? (
            <TooltipButton
              className="native-library-track__download"
              onClick={downloadTrack}
              disabled={downloadPending}
              label={downloadLabel}
              aria-label={downloadLabel}
            >
              {downloadPending ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
            </TooltipButton>
          ) : null,
          menu: {
            items: trackMenuItems,
            additionalItemsAfter: queueItems.at(-1)?.id ?? "play",
            onMenuOpen: loadStaticPlaylists,
            renderAdditionalItems: ({ closeMenu }) => (
              <>
                <div className="native-library-item-menu__separator" />
                <TrackPlaylistSubmenu
                  label="Add to playlist"
                  track={track}
                  playlists={staticPlaylists}
                  loading={playlistsLoading}
                  saving={playlistSavingKey === String(track.id)}
                  error={playlistsError}
                  defaultNewPlaylistName={getDefaultTrackPlaylistName(track)}
                  onSelect={(target) => addLibraryTrackToPlaylist(track, target)}
                  onClose={closeMenu}
                  toggleOnClick
                />
                <TrackPlaylistRemoveSubmenu
                  track={track}
                  playlists={staticPlaylists}
                  saving={playlistSavingKey === String(track.id)}
                  error={playlistsError}
                  onSelect={(target) => removeLibraryTrackFromPlaylist(track, target)}
                  onClose={closeMenu}
                  toggleOnClick
                />
              </>
            ),
          },
          favorite: {
            active: isFavorite,
            pending: Boolean(pendingFavorite),
            onToggle: () => toggleFavorite("song", track),
          },
        };
      })}
    />
  );

  const renderArtistCard = (artist) => {
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
            to={libraryArtistPath(artist)}
            className="native-library-card__cover native-library-card__cover--round"
            data-artwork
            aria-label={"Open " + (artist.name || "artist")}
          >
            {artist.mbid ? (
              <ArtistImage
                mbid={artist.mbid}
                artistName={artist.name}
                alt={artist.name || ""}
                className="native-library-artist-image"
                showLoading={false}
                enablePreviewPlayback={false}
                isInLibrary
              />
            ) : (
              <Cover label={artist.name} round />
            )}
          </RouteLink>
          <LibraryItemMenu
            label={artist.name || "Artist"}
            items={[
              {
                id: "open",
                label: "Open artist",
                icon: UserRound,
                onSelect: () => handleArtistOpen(artist),
              },
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => openLibraryInfo("artist", artist),
              },
              ...artistMbidMenuItems(artist),
              {
                id: "favorite",
                label: isFavorite ? "Remove from favorites" : "Add to favorites",
                icon: Heart,
                selected: isFavorite,
                separatorBefore: true,
                onSelect: () => toggleFavorite("artist", artist),
              },
              {
                id: "discover",
                label: "Open in Discover",
                icon: Sparkles,
                separatorBefore: true,
                onSelect: () => handleDiscoverArtistOpen(artist),
                disabled: !artist.mbid,
              },
              ...(canDeleteArtist && artist.mbid
                ? [
                    {
                      id: "delete",
                      label: "Delete artist",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval("artist", artist),
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <Tooltip content={artist.name}>
              <RouteLink to={libraryArtistPath(artist)} className="native-library-card__title">
                {artist.name || "Unknown Artist"}
              </RouteLink>
            </Tooltip>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(pendingFavorite)}
              label={artist.name || "artist"}
              onClick={() => toggleFavorite("artist", artist)}
            />
          </div>
          <span className="native-library-card__meta">
            {artist.albumCount ?? artist.albumIds?.length ?? 0} album{(artist.albumCount ?? artist.albumIds?.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
      </article>
    );
  };

  const renderAlbumCard = (album) => {
    const artist = getArtistForAlbum(album);
    const albumTracks = getAlbumTracks(album);
    const availability = albumAvailability(album);
    const meta =
      availability.total && availability.available < availability.total
        ? availability.available + "/" + availability.total + " available"
        : (yearOf(album.releaseDate) ? yearOf(album.releaseDate) + " · " : "") +
          (availability.total || 0) +
          " tracks";
    const isFavorite = favoriteIds.has(favoriteId("album", album));
    const aurralState = album.managedBy === "aurral"
      ? describeAurralAlbumStatus(aurralAlbumStatuses[aurralAlbumStatusKey(album.id)] || {})
      : null;
    const cardStatus = aurralState?.status === "complete" ? null : aurralState;
    const albumLinkState = {
      seed: {
        title: album.title || "",
        artistName: artist?.name || album.albumArtist || "",
        coverUrl: getAlbumCover(album) || null,
      },
    };
    return (
      <article className="native-library-card" data-library-menu-target data-artwork-scope key={album.id}>
        <div className="native-library-card__cover-wrap">
          <RouteLink
            to={libraryAlbumPath(album)}
            state={albumLinkState}
            className="native-library-card__cover"
            data-artwork
            aria-label={"Open " + (album.title || "album")}
          >
            <Cover src={getAlbumCover(album)} label={album.title} />
          </RouteLink>
          <TooltipButton
            className="native-library-card__play"
            onClick={() => playAlbum(album)}
            disabled={!albumTracks.length && !album.trackCount && !album.trackIds?.length}
            label={"Play " + (album.title || "album")}
            aria-label={"Play " + (album.title || "album")}
          >
            <Play aria-hidden="true" fill="currentColor" />
          </TooltipButton>
          <LibraryItemMenu
            label={album.title || "Album"}
            items={[
              {
                id: "play",
                label: "Play album",
                icon: Play,
                onSelect: () => playAlbum(album),
                disabled: !albumTracks.length && !album.trackCount && !album.trackIds?.length,
              },
              {
                id: "open",
                label: "Open album",
                icon: ExternalLink,
                onSelect: () => handleAlbumOpen(album),
              },
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => openLibraryInfo("album", album, { artist }),
              },
              {
                id: "favorite",
                label: isFavorite ? "Remove from favorites" : "Add to favorites",
                icon: Heart,
                selected: isFavorite,
                separatorBefore: true,
                onSelect: () => toggleFavorite("album", album),
              },
              ...(artist
                ? [
                    {
                      id: "artist",
                      label: "Go to artist",
                      icon: UserRound,
                      separatorBefore: true,
                      onSelect: () => handleArtistOpen(artist),
                    },
                  ]
                : []),
              {
                id: "discover",
                label: "Open in Discover",
                icon: Sparkles,
                separatorBefore: true,
                onSelect: () => handleDiscoverAlbumOpen(album),
                disabled: !artist?.mbid,
              },
              ...(canDeleteAlbum && canRemoveLibraryAlbum(album, { lidarrConnected: libraryDestination.primary === "lidarr" })
                ? [
                    {
                      id: "delete",
                      label: "Delete album",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval("album", album),
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <Tooltip content={album.title}>
              <RouteLink
                to={libraryAlbumPath(album)}
                state={albumLinkState}
                className="native-library-card__title"
              >
                {album.title || "Unknown Album"}
              </RouteLink>
            </Tooltip>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(pendingFavorite)}
              label={album.title || "album"}
              onClick={() => toggleFavorite("album", album)}
            />
          </div>
          {artist ? (
            <RouteLink to={libraryArtistPath(artist)} className="native-library-card__artist">
              {artist.name}
            </RouteLink>
          ) : (
            <span className="native-library-card__artist">
              {artist?.name || album.albumArtist || "Unknown Artist"}
            </span>
          )}
          <span className="native-library-card__meta">
            {cardStatus && (
              <span className="native-library-card__status" data-tone={cardStatus.tone}>
                {cardStatus.label + " · "}
              </span>
            )}
            {meta}
          </span>
        </div>
      </article>
    );
  };

  const renderSectionHeader = (title, count, path = "", actionLabel = "View all") => (
    <div className="native-library-section-heading">
      <div>
        <h2>{title}</h2>
        {count != null && <span>{count}</span>}
      </div>
      {path && (
        <RouteLink to={path} className="btn">
          {actionLabel}
        </RouteLink>
      )}
    </div>
  );

  const renderHome = () => (
    <div className="native-library-home">
      {homeGenres.length > 0 && (
        <section className="native-library-section">
          {renderSectionHeader("Genres", null, "/library/genres" + previewQuery, "View more")}
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
      return (
        <EmptyState
          title="No favorites"
          message="Artists, albums, and tracks you favorite will appear here."
        />
      );
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

  const renderLibraryAlbumDetail = () => {
    if (!libraryAlbum) return null;
    const artist = getArtistForAlbum(libraryAlbum);
    const albumTracks = getAlbumTracks(libraryAlbum);
    const availability = albumAvailability(libraryAlbum);
    const discoverArtist = artist?.mbid ? artist : null;
    const durationMs = albumTracks.reduce(
      (total, track) => total + Number(firstAvailableFile(track)?.durationMs || 0),
      0,
    );
    const albumPlayable = albumTracks.some((track) => firstAvailableFile(track));
    const albumIsCurrent =
      matchesSource(librarySource) &&
      albumTracks.some((track) => String(track.id) === String(currentTrack?.id));
    return (
      <section className="native-library-detail">
        <CollectionHeader
          cover={<Cover src={getAlbumCover(libraryAlbum)} label={libraryAlbum.title} />}
          kicker="Album"
          title={libraryAlbum.title || "Unknown Album"}
          subtitle={
            artist ? (
              <RouteLink to={libraryArtistPath(artist)} className="native-library-detail__artist">
                {artist.name}
              </RouteLink>
            ) : (
              <p>{libraryAlbum.albumArtist || "Unknown Artist"}</p>
            )
          }
          meta={
            <>
            {[
              yearOf(libraryAlbum.releaseDate),
              availability.total + " tracks",
              formatLongDuration(durationMs),
            ]
              .filter(Boolean)
              .join(" · ")}
            {albumMonitored === false && (
              <>
                {" · "}
                <Tooltip content="Not monitored">
                  <span className="native-library-detail__manager" data-unmonitored role="img" aria-label="Not monitored">
                    <EyeOff aria-hidden="true" />
                  </span>
                </Tooltip>
              </>
            )}
            </>
          }
          status={
            albumMonitoring.monitored && !isPreviewLibrary ? (
              <AurralAlbumStatus
                key={libraryAlbum.id}
                album={libraryAlbum}
                artist={artist}
                canManage={canAddTracks}
                canRetry={activeManager === "aurral"}
                onChanged={refreshLibraryActivity}
                onSettled={reloadLibraryAlbumTracks}
              />
            ) : null
          }
          actions={
            <>
              <CollectionPlayButtons
                label={libraryAlbum.title || "album"}
                disabled={!albumPlayable}
                isPlaying={albumIsCurrent && isRunning}
                isShuffleEnabled={false}
                onPlay={() => (albumIsCurrent ? togglePlayPause() : playTracks(albumTracks))}
                onShuffle={() => playTracks(albumTracks, null, true)}
              />
              <FavoriteButton
                active={favoriteIds.has(favoriteId("album", libraryAlbum))}
                pending={Boolean(pendingFavorite)}
                label={libraryAlbum.title || "album"}
                onClick={() => toggleFavorite("album", libraryAlbum)}
              />
              {canDownloadLibraryAlbum && (
                <TooltipButton
                  className="native-library-favorite"
                  onClick={downloadLibraryAlbum}
                  disabled={libraryAlbumDownloading}
                  label={libraryAlbumDownloading
                    ? "Downloading album"
                    : albumManager === "lidarr" && albumMonitored ? "Search for album" : "Download album"}
                  aria-label={
                    (libraryAlbumDownloading
                      ? "Downloading "
                      : albumManager === "lidarr" && albumMonitored ? "Search for " : "Download ") +
                    (libraryAlbum.title || "album")
                  }
                >
                  {libraryAlbumDownloading ? (
                    <DotLoader size="sm" label={null} />
                  ) : albumManager === "lidarr" && albumMonitored ? (
                    <Search aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                </TooltipButton>
              )}
              {discoverArtist && (
                <CrossViewLink
                  view="discover"
                  to={"/artist/" + encodeURIComponent(discoverArtist.mbid)}
                  state={discoverArtistState(discoverArtist)}
                />
              )}
              <LibraryItemMenu
                label={libraryAlbum.title || "Album"}
                items={[
                  {
                    id: "play",
                    label: "Play album",
                    icon: Play,
                    onSelect: () => playTracks(albumTracks),
                    disabled: !albumTracks.some((track) => firstAvailableFile(track)),
                  },
                  {
                    id: "info",
                    label: "View info",
                    icon: Info,
                    onSelect: () => openLibraryInfo("album", libraryAlbum, { artist }),
                  },
                  {
                    id: "favorite",
                    label: favoriteIds.has(favoriteId("album", libraryAlbum))
                      ? "Remove from favorites"
                      : "Add to favorites",
                    icon: Heart,
                    selected: favoriteIds.has(favoriteId("album", libraryAlbum)),
                    separatorBefore: true,
                    onSelect: () => toggleFavorite("album", libraryAlbum),
                  },
                  ...(albumMonitoringMenuItem ? [albumMonitoringMenuItem] : []),
                  ...(artist
                    ? [
                        {
                          id: "artist",
                          label: "Go to artist",
                          icon: UserRound,
                          separatorBefore: true,
                          onSelect: () => handleArtistOpen(artist),
                        },
                      ]
                    : []),
                  ...(canDeleteAlbum && canRemoveLibraryAlbum(libraryAlbum, { lidarrConnected: activeManager === "lidarr" })
                    ? [
                        {
                          id: "delete",
                          label: "Delete album",
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          onSelect: () => openLibraryRemoval("album", libraryAlbum),
                        },
                      ]
                    : []),
                ]}
              />
            </>
          }
        />
        {renderTrackList(albumTracks, libraryAlbum.title + " tracks", {
          variant: "release",
        })}
        {albumMonitoring.dialog}
      </section>
    );
  };

  const renderLibraryArtistDetail = () => {
    if (!libraryArtist) return null;
    const artistAlbums = library.albums.filter(
      (album) => String(album.artistId) === String(libraryArtist.id),
    );
    const artistTracks = artistAlbums.flatMap(getAlbumTracks);
    const artistTopTracks = topArtistTracks(artistTracks, albumsById);
    const artistTrackTotal = artistAlbums.reduce(
      (total, album) => total + Number(albumAvailability(album).total || 0),
      0,
    );
    const discoverArtist = libraryArtist.mbid ? libraryArtist : null;
    return (
      <section className="native-library-detail">
        <div
          className="native-library-detail__hero native-library-detail__hero--artist"
          data-library-menu-target
        >
          <div className="native-library-detail__cover" style={sharedArtworkStyle}>
            {libraryArtist.mbid ? (
              <ArtistImage
                mbid={libraryArtist.mbid}
                artistName={libraryArtist.name}
                alt={libraryArtist.name || ""}
                className="native-library-detail__artist-image"
                showLoading={false}
                enablePreviewPlayback={false}
                isInLibrary
              />
            ) : (
              <Cover label={libraryArtist.name} />
            )}
          </div>
          <div className="native-library-detail__body">
            <p className="native-library-kicker">Artist</p>
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
              <button
                type="button"
                className="native-library-page-play"
                onClick={() => playTracks(artistTracks)}
                disabled={!artistTracks.some((track) => firstAvailableFile(track))}
              >
                <Play aria-hidden="true" fill="currentColor" /> Play
              </button>
              <FavoriteButton
                active={favoriteIds.has(favoriteId("artist", libraryArtist))}
                pending={Boolean(pendingFavorite)}
                label={libraryArtist.name || "artist"}
                onClick={() => toggleFavorite("artist", libraryArtist)}
              />
              {discoverArtist && (
                <CrossViewLink
                  view="discover"
                  to={"/artist/" + encodeURIComponent(discoverArtist.mbid)}
                  state={discoverArtistState(discoverArtist)}
                />
              )}
              <LibraryItemMenu
                label={libraryArtist.name || "Artist"}
                items={[
                  {
                    id: "play",
                    label: "Play artist",
                    icon: Play,
                    onSelect: () => playTracks(artistTracks),
                    disabled: !artistTracks.some((track) => firstAvailableFile(track)),
                  },
                  {
                    id: "info",
                    label: "View info",
                    icon: Info,
                    onSelect: () => openLibraryInfo("artist", libraryArtist),
                  },
                  ...artistMbidMenuItems(libraryArtist),
                  {
                    id: "favorite",
                    label: favoriteIds.has(favoriteId("artist", libraryArtist))
                      ? "Remove from favorites"
                      : "Add to favorites",
                    icon: Heart,
                    selected: favoriteIds.has(favoriteId("artist", libraryArtist)),
                    separatorBefore: true,
                    onSelect: () => toggleFavorite("artist", libraryArtist),
                  },
                  ...libraryArtistMonitoringItems,
                  ...(canDeleteArtist && libraryArtist.mbid
                    ? [{
                        id: "delete",
                        label: "Delete artist",
                        icon: Trash2,
                        danger: true,
                        separatorBefore: true,
                        onSelect: () => openLibraryRemoval("artist", libraryArtist),
                      }]
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
            <EmptyState title="No albums" message="No indexed albums belong to this artist." />
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
            <EmptyState title="No tracks" message="No indexed tracks belong to this artist." />
          )}
        </section>
      </section>
    );
  };

  const renderLibraryDetail = () =>
    libraryAlbum ? renderLibraryAlbumDetail() : renderLibraryArtistDetail();

  const renderLibraryModals = () => (
    <>
      <DeleteArtistModal
        show={libraryRemoval?.kind === "artist"}
        artistName={libraryRemoval?.entity?.name}
        libraryArtistName={libraryRemoval?.entity?.artistName}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        deleting={deletingLibraryEntity}
      />
      {trackMonitoring.dialog}
      <DeleteAlbumModal
        show={libraryRemoval?.kind === "album"}
        title={libraryRemoval?.entity?.title || libraryRemoval?.entity?.albumName}
        managedBy={resolveAlbumManager(libraryRemoval?.entity)}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        removing={deletingLibraryEntity}
      />
      <DeleteTrackModal
        show={libraryRemoval?.kind === "track"}
        title={libraryRemoval?.entity?.title || libraryRemoval?.entity?.trackName}
        hasFile={Boolean(firstAvailableFile(libraryRemoval?.entity))}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        deleting={deletingLibraryEntity}
      />
      <LibraryInfoModal item={libraryInfo} onClose={() => setLibraryInfo(null)} />
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
      {loading && (
        isDetail ? (
          <div className="native-library-content">
            <section className="native-library-detail">
              {routeAlbumId && albumSeed?.title ? (
                <CollectionHeader
                  cover={<Cover src={albumSeed.coverUrl} label={albumSeed.title} />}
                  kicker="Album"
                  title={albumSeed.title}
                  subtitle={albumSeed.artistName ? <p>{albumSeed.artistName}</p> : null}
                  actions={
                    <CollectionPlayButtons label={albumSeed.title} disabled isPlaying={false} />
                  }
                />
              ) : null}
              <SkeletonStatus label="Loading library">
                {routeAlbumId && albumSeed?.title ? null : <SkeletonCollectionHeader />}
                <SkeletonRows count={10} />
              </SkeletonStatus>
            </section>
          </div>
        ) : viewMode === "list" || tab === "tracks" || tab === "genres" ? (
          <SkeletonStatus label="Loading library">
            <SkeletonRows count={12} />
          </SkeletonStatus>
        ) : (
          <SkeletonStatus label="Loading library">
            <SkeletonCardGrid className="native-library-grid" square={tab !== "artists"} />
          </SkeletonStatus>
        )
      )}
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
      <main
        className={`library-page native-library-page${libraryAlbum ? " collection-page" : ""}`}
        style={libraryAlbum && albumTint ? { "--collection-tint": albumTint } : undefined}
      >
        {renderLibraryModals()}
        {renderStatus()}
        {!loading && !error && !libraryAlbum && !libraryArtist && (
          <EmptyState title="Not found" message="This library item is no longer indexed." />
        )}
        {!loading && !error && (libraryAlbum || libraryArtist) && (
          <div className="native-library-content">{renderLibraryDetail()}</div>
        )}
      </main>
    );
  }

  const content =
    section === "home"
      ? renderHome()
      : section === "favorites"
        ? renderFavorites()
        : tab === "artists"
          ? (
            <div
              className={
                "native-library-grid native-library-grid--artists" +
                (viewMode === "list" ? " is-list" : "")
              }
            >
              {sortedArtists.map(renderArtistCard)}
            </div>
          )
          : tab === "albums"
            ? (
              <div
                className={
                  "native-library-grid" + (viewMode === "list" ? " is-list" : "")
                }
              >
                {sortedAlbums.map(renderAlbumCard)}
              </div>
            )
            : tab === "tracks"
              ? renderTrackList(sortedTracks, "Library tracks")
              : renderGenres();

  const pageTitle =
    section === "home"
      ? "Library"
      : section === "albums" && selectedGenre
        ? selectedGenre
        : sectionLabel;
  const pageCount =
    section === "home"
      ? pageData?.total ?? library.albums.length + ownedLibraryTracks.length
      : activeCount;
  const showToolbar = section !== "home";
  const isSearchVisible = searchOpen || Boolean(query);
  const hasActiveFilters = Boolean(selectedGenre);

  return (
    <main className="library-page native-library-page">
      {renderLibraryModals()}
      <header className={`native-library-header${section === "home" ? " native-library-header--home" : ""}`}>
        <div className="native-library-title-row">
          <div className="native-library-title">
            <TooltipButton
              className="native-library-title-play"
              onClick={() => playTracks(collectionTracks)}
              disabled={!collectionPlayable}
              label={"Play " + pageTitle}
            >
              <Play aria-hidden="true" fill="currentColor" />
            </TooltipButton>
            <h1 className="page-title">
              {pageTitle}
              {pageCount != null && (
                <span className="native-library-count">{pageCount}</span>
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
                aria-label={isSearchVisible ? "Close search" : "Search " + sectionLabel.toLocaleLowerCase()}
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
                     className="btn">
                      <X aria-hidden="true" />
                    </TooltipButton>
                  )}
                </label>
              )}
              {sortOptions.length > 0 && (
                <>
                  <label className="native-library-sort">
                    <span className="sr-only">Sort {sectionLabel.toLocaleLowerCase()} by</span>
                    <select
                      value={sortMode}
                      onChange={(event) =>
                        updateViewParams(
                          {
                            sort: event.target.value === NAME_SORT.value ? null : event.target.value,
                            page: null,
                          },
                          { replace: true },
                        )
                      }
                      aria-label={"Sort " + sectionLabel.toLocaleLowerCase()}
                    >
                      {sortOptions.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <select
                    value={selectedGenre}
                    onChange={(event) => updateGenreFilter(event.target.value)}
                    aria-label="Filter by genre"
                  >
                    <option value="">All genres</option>
                    {genreStats.map((genre) => (
                      <option value={genre.name} key={genre.name}>
                        {genre.name}
                      </option>
                    ))}
                  </select>
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
              : "Indexed music will appear here when the library is ready."
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
    </main>
  );
}

export default LibraryPage;
