import ArtworkImage from "../components/ArtworkImage";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUpZA,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  Grid3X3,
  ImagePlus,
  Info,
  List,
  ListEnd,
  ListFilter,
  ListStart,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  Share,
  Shuffle,
  Sparkles,
  Trash2,
  X,
} from "../components/icons";

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
import { readRouteSeed } from "../navigation/routeSeed.ts";
import { useSharedArtworkStyle } from "../navigation/viewTransitions.ts";
import {
  SkeletonAlbumDetail,
  SkeletonLibraryArtist,
  SkeletonLibraryGrid,
  SkeletonShape,
  SkeletonStatus,
  SkeletonText,
  SkeletonTrackList,
} from "../components/Skeletons";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useLibraryShareAction } from "../hooks/useShareAction";
import { useStaticPlaylists } from "../hooks/useStaticPlaylists";
import {
  useHiddenPlaylistTracks,
  usePlaylistBulkActions,
} from "./playlists/usePlaylistBulkActions.ts";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { getReleaseGroupCoversBatch } from "../utils/api/endpoints/artists.ts";
import { libraryClient } from "../utils/api/clients/library.ts";
import { libraryAlbumsClient } from "../utils/api/clients/libraryAlbums.ts";
import { libraryArtistsClient } from "../utils/api/clients/libraryArtists.ts";
import { libraryArtworkClient } from "../utils/api/clients/libraryArtwork.ts";
import { libraryTracksClient } from "../utils/api/clients/libraryTracks.ts";
import { requestsClient } from "../utils/api/clients/requests.ts";
import {
  clearLibraryPageCache,
  getLibraryCustomArtworkUrl,
  getLibraryPage,
  getDownloadStatus,
  downloadTrackToLibrary,
  reSearchLibraryTrack,
  requestAlbumFromSearch,
  updateLibraryFavorites,
  type AurralMonitoringResult,
  type CustomArtworkResult,
} from "../utils/api/endpoints/library.ts";
import { addStaticPlaylistTracks, createStaticPlaylist } from "../utils/api/endpoints/playlists.ts";
import { asApiError, buildAuthenticatedApiUrl } from "../utils/api/core.ts";
import {
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
  albumCardMeta,
  EMPTY_LIBRARY,
  favoriteId,
  firstAvailableFile,
  getAlbumCoverId,
  getCachedAlbumTracks,
  mergeAlbumTrackPageIntoLibrary,
  releaseTypeOf,
  yearOf,
} from "../utils/libraryPageData.ts";
import {
  aurralAlbumStatusKey,
  buildAurralAlbumRetryPayload,
  describeAurralAlbumStatus,
  shouldPollAlbumStatuses,
} from "../utils/aurralAlbumStatus.ts";
import {
  canRemoveLibraryAlbum,
  canRemoveLibraryArtist,
  resolveAlbumManager,
} from "../utils/libraryDestination.ts";
import { describeAlbumRequestResult } from "../utils/albumAddAction.ts";
import { canDownloadAurralAlbum, getMonitoringMenuAction } from "../utils/aurralMonitoring.ts";
import { useArtistMonitoring } from "../components/ArtistMonitoringButtons";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { useQueueTrackActions } from "../hooks/useQueueTrackActions";
import { LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
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
  getApiErrorMessage,
  getApiErrorText,
  reserveUniquePlaylistName,
} from "./ArtistDetails/utils";
import { useResponsiveReleaseLimit } from "./ArtistDetails/hooks/useResponsiveReleaseLimit";
import { queryClient, queryKeys } from "../queryClient.ts";
import Tooltip from "../components/Tooltip";
import { showFavoriteRemoved } from "../utils/favoriteUndo.ts";
import ArtworkEditorModal from "../components/ArtworkEditorModal.tsx";
import type { WebSocketChannelMessage } from "../../../backend/services/websocketService.ts";
import type { ActivityRequest } from "./activity/activityListUtils.ts";

type LibraryPageTrack = LibraryTrack & {
  durationMs?: number | null;
  albumName?: string | null;
};

type LibraryData = LibraryViewLibrary;

type LibraryGenre = LibraryData["genres"][number];

type LibraryEntityByKind = {
  artist: LibraryArtist;
  album: LibraryAlbum;
  track: LibraryPageTrack;
};

type LibraryTarget = {
  [Kind in keyof LibraryEntityByKind]: { kind: Kind; entity: LibraryEntityByKind[Kind] };
}[keyof LibraryEntityByKind];

type LibraryRemoval = LibraryTarget & { manager?: string | null };

type LibraryInfoState = LibraryTarget & {
  artist?: LibraryArtist | null;
  album?: LibraryAlbum | null;
  trackNumber?: number | null;
};

type ArtworkEditorState = {
  kind: "album" | "track";
  id: string | number;
  title: string;
  currentArtwork: string;
  hasCustomArtwork: boolean;
  fallbackArtwork: string;
};

type TrackDownloadState = { jobId: string | null; status: string };

type LibraryLookup = {
  albumsById: Map<string, LibraryAlbum>;
  artistsById: Map<string, LibraryArtist>;
};

type LibraryCollection = { tracks: LibraryPageTrack[]; lookup: LibraryLookup | null };

type LibraryPageResult = Awaited<ReturnType<typeof getLibraryPage>>;

type PlaylistTarget = { mode: "new"; name: string } | { mode: "existing"; playlistId: string };

type PlaylistRemoveTarget = { playlistId?: string; jobId?: string };

type SaveTracksOptions = {
  key: string;
  label: string;
  defaultName: string;
  lookup?: LibraryLookup | null;
};

const pageSize = LIBRARY_PAGE_SIZE;

type GenreSource = { metadata?: object | null };

const text = (value: unknown) => String(value || "").trim();

const nestedField = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, key) : undefined;

const isAlbumArtistCredit = (track: LibraryTrack, artist: LibraryArtist | null | undefined) =>
  !text(track?.artistName) ||
  text(track.artistName).toLowerCase() === text(artist?.name).toLowerCase();

const trackArtistMbid = (track: LibraryTrack, artist: LibraryArtist | null | undefined) =>
  isAlbumArtistCredit(track, artist) ? artist?.mbid || null : null;

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

const hasAurralTrackFile = (track: LibraryTrack) =>
  (track?.files || []).some((file) => file.source === "aurral");

const hasDeletableTrackFile = (track: LibraryTrack) =>
  (track?.files || []).some((file) => file.available && file.source !== "readonly");

const firstAvailableAurralFile = (track: LibraryTrack) =>
  (track?.files || []).find((file) => file.source === "aurral" && file.available) || null;

const trackDurationMs = (track: LibraryPageTrack) => {
  const fileDurationMs = (track?.files || []).find(
    (file) => Number(file?.durationMs) > 0,
  )?.durationMs;
  if (fileDurationMs != null) return fileDurationMs;
  if (Number(track?.durationMs) > 0) return track.durationMs;
  const metadataDurationMs = Number(track?.metadata?.durationMs);
  if (metadataDurationMs > 0) return metadataDurationMs;
  const metadataDurationSeconds = Number(track?.metadata?.duration);
  return metadataDurationSeconds > 0 ? Math.round(metadataDurationSeconds * 1000) : null;
};

const formatDuration = (durationMs: number | null | undefined) => {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "";
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};

const formatLongDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? hours + "h " + (minutes % 60) + "m" : minutes + "m " + (seconds % 60) + "s";
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

const TRACK_DOWNLOAD_ACTION_LABELS: Partial<Record<string, string>> = {
  submitting: "Adding to search queue…",
  pending: "Queued for search",
  processing: "Searching for track…",
  searching: "Searching for track…",
  downloading: "Downloading track…",
  moving: "Adding to library…",
  blocked: "Needs review",
  completed: "Downloaded; waiting for library refresh",
  failed: "Retry download track",
};

const trackDownloadActionLabel = (status: string | null | undefined) =>
  TRACK_DOWNLOAD_ACTION_LABELS[status ?? ""] || "Download track";

const activityDownloadStatus = (
  request: { status?: string; statusLabel?: unknown } | null | undefined,
) => {
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

const trackDownloadIdentity = (track: LibraryPageTrack, fallbackTitle = "") =>
  String(track?.id || track?.mbid || track?.title || fallbackTitle);

const sameTrackText = (left: unknown, right: unknown) => {
  const first = text(left).toLocaleLowerCase();
  const second = text(right).toLocaleLowerCase();
  return Boolean(first) && Boolean(second) && first === second;
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

const hasMbid = (
  artist: LibraryArtist | null | undefined,
): artist is LibraryArtist & { mbid: string } => Boolean(artist?.mbid);

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

function Cover({
  src,
  label,
  round = false,
  compact = false,
  thumbnail = true,
}: {
  src?: string | null;
  label?: string | null;
  round?: boolean;
  compact?: boolean;
  thumbnail?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && src !== failedSrc) {
    return (
      <ArtworkImage
        src={src}
        thumbnail={thumbnail}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
      />
    );
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

function EmptyState({ title, message }: { title: string; message: string }) {
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
  const { section: routeSection, albumId: routeAlbumId, artistId: routeArtistId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { bootstrap, hasPermission, user } = useAuth();
  const toast = useToast();
  const shareLibrary = useLibraryShareAction();
  const { showError, showSuccess } = toast;
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading,
    playlistsError,
    setPlaylistsError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const {
    playQueue,
    queueNext,
    addToQueue,
    currentTrack,
    isPlaying,
    isLoading,
    isStarting,
    togglePlayPause,
    matchesSource,
    updateQueueArtwork,
  } = useAudioQueue();
  const isRunning = isPlaying || isStarting;
  const getQueueItems = useQueueTrackActions();
  const navigationType = useNavigationType();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const queryTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [pendingFavorite, setPendingFavorite] = useState<string | null>(null);
  const favoriteMutationInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAttemptRef = useRef(0);
  const [playlistSavingKey, setPlaylistSavingKey] = useState("");
  const [trackDownloadStates, setTrackDownloadStates] = useState<
    Record<string, TrackDownloadState>
  >({});
  const [trackResearchStates, setTrackResearchStates] = useState<Record<string, boolean>>({});
  const [libraryRemoval, setLibraryRemoval] = useState<LibraryRemoval | null>(null);
  const [libraryInfo, setLibraryInfo] = useState<LibraryInfoState | null>(null);
  const [artworkEditor, setArtworkEditor] = useState<ArtworkEditorState | null>(null);
  const [mbidArtist, setMbidArtist] = useState<LibraryArtist | null | undefined>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deletingLibraryEntity, setDeletingLibraryEntity] = useState(false);
  const [homeAlbumsGridRef, homeAlbumColumns] = useResponsiveReleaseLimit({
    cardMinWidth: 152,
  });

  const handleLibraryScanMessage = useCallback((message: WebSocketChannelMessage) => {
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

  useEffect(
    () => () => {
      refreshAttemptRef.current += 1;
    },
    [],
  );

  const completeLibraryRefresh = useCallback(() => {
    clearLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, []);

  const pollLibraryRefresh = useCallback(
    async (jobId: number, attempt: number, successMessage = "") => {
      while (true) {
        const status = await parseResponse(
          libraryClient.refresh[":jobId"].$get({ param: { jobId: encodeURIComponent(jobId) } }),
        );
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
    },
    [completeLibraryRefresh, showSuccess],
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
  const library: LibraryData =
    queryData?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
  const favoriteIds = useMemo(
    () =>
      queryData?.favoriteIds ||
      (isPreviewLibrary ? new Set(libraryPreviewFavorites) : new Set<string>()),
    [isPreviewLibrary, queryData?.favoriteIds],
  );
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
  const setLibrary = useCallback(
    (updater: LibraryData | ((current: LibraryData) => LibraryData)) => {
      queryClient.setQueryData(libraryQueryKey, (current) => {
        if (!current && !forcePreview) return current;
        const previous = current?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
        const next = typeof updater === "function" ? updater(previous) : updater;
        if (current && next === previous) return current;
        return { ...(current || {}), library: next };
      });
    },
    [forcePreview, libraryQueryKey],
  );
  const setFavoriteIds = useCallback(
    (updater: Set<string> | ((current: Set<string>) => Set<string>)) => {
      queryClient.setQueryData(libraryQueryKey, (current) => {
        if (!current && !forcePreview) return current;
        const previous =
          current?.favoriteIds ||
          (forcePreview ? new Set(libraryPreviewFavorites) : new Set<string>());
        const next = typeof updater === "function" ? updater(previous) : updater;
        if (current && next === previous) return current;
        return { ...(current || {}), favoriteIds: next };
      });
    },
    [forcePreview, libraryQueryKey],
  );

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
    (album: LibraryAlbum | null | undefined) => getCachedAlbumTracks(album, tracksById),
    [tracksById],
  );

  const loadAlbumTracks = useCallback(
    async (album: LibraryAlbum | null | undefined) => {
      if (!album?.id) return [];
      const releaseGroupMbid = album?.releaseGroupMbid || null;
      const result = await queryClient.fetchQuery({
        queryKey: queryKeys.libraryAlbumTracks(String(album.id), releaseGroupMbid),
        queryFn: async ({ signal }) => {
          const pages = [];
          for (let number = 1; ; number += 1) {
            const page = await getLibraryPage(
              {
                kind: "tracks",
                albumId: album.id,
                page: number,
                pageSize,
                availableOnly: false,
              },
              { signal },
            );
            pages.push(page);
            if (!page?.hasMore || !page?.items?.length) break;
          }
          return {
            tracks: pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : [])),
            page: {
              ...pages[0],
              artists: pages.flatMap((page) => page?.artists || []),
              albums: pages.flatMap((page) => page?.albums || []),
            },
          };
        },
        staleTime: 5 * 60 * 1000,
      });
      const tracks = result.tracks;
      const page = result.page;
      setLibrary((current) => mergeAlbumTrackPageIntoLibrary(current, page, album.id, tracks));
      return tracks;
    },
    [setLibrary],
  );

  const getAlbumForTrack = useCallback(
    (track: LibraryPageTrack, albums = albumsById) => {
      const fileAlbumId = firstAvailableFile(track)?.albumId;
      const relation =
        track?.albums?.find((entry) => entry.albumId === fileAlbumId) || track?.albums?.[0];
      return relation ? albums.get(String(relation.albumId)) : null;
    },
    [albumsById],
  );

  const getArtistForAlbum = useCallback(
    (album: LibraryAlbum | null | undefined, artists = artistsById) =>
      album ? artists.get(String(album.artistId)) : null,
    [artistsById],
  );

  const lookupWithPages = useCallback(
    (pages: LibraryPageResult[]) => ({
      albumsById: new Map<string, LibraryAlbum>([
        ...albumsById,
        ...pages
          .flatMap((page) => page?.albums || [])
          .map((album) => [String(album.id), album] as const),
      ]),
      artistsById: new Map<string, LibraryArtist>([
        ...artistsById,
        ...pages
          .flatMap((page) => page?.artists || [])
          .map((artist) => [String(artist.id), artist] as const),
      ]),
    }),
    [albumsById, artistsById],
  );

  const getDefaultTrackPlaylistName = useCallback(
    (track: LibraryPageTrack) =>
      reserveUniquePlaylistName(
        staticPlaylists,
        `${track?.artistName || getArtistForAlbum(getAlbumForTrack(track))?.name || "Artist"} Picks`,
      ),
    [getAlbumForTrack, getArtistForAlbum, staticPlaylists],
  );

  const saveLibraryTracksToPlaylist = useCallback(
    async (
      tracks: LibraryPageTrack[],
      target: PlaylistTarget,
      { key, label, defaultName, lookup = null }: SaveTracksOptions,
    ) => {
      const payloads = tracks
        .map((track) => {
          const album = getAlbumForTrack(track, lookup?.albumsById);
          const artist = getArtistForAlbum(album, lookup?.artistsById);
          return buildStaticPlaylistTrackPayload({
            artistName: artist?.name || track?.artistName || "",
            trackName: track?.title || "",
            albumName: album?.title || "",
            artistMbid: artist?.mbid || "",
            albumMbid: album?.releaseGroupMbid || album?.mbid || "",
            trackMbid: track?.mbid || "",
            releaseYear: yearOf(album?.releaseDate),
            durationMs: trackDurationMs(track),
          });
        })
        .filter((payload) => payload.artistName && payload.trackName);
      if (!payloads.length) {
        showError(
          tracks.length === 1 ? "Track details are incomplete" : "No Library tracks to add",
        );
        return;
      }
      setPlaylistSavingKey(key);
      setPlaylistsError("");
      try {
        if (target?.mode === "new") {
          const name = String(target?.name || "").trim() || defaultName;
          await createStaticPlaylist({ name, tracks: payloads });
          showSuccess(`${label} saved to ${name}`);
        } else {
          const playlist = staticPlaylists.find((candidate) => candidate.id === target?.playlistId);
          await addStaticPlaylistTracks(target?.playlistId, { tracks: payloads });
          showSuccess(`${label} added to ${playlist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) setStaticPlaylists(nextPlaylists);
      } catch (requestError) {
        const message = getApiErrorMessage(requestError) || "Failed to save to playlist";
        setPlaylistsError(message);
        showError(message);
      } finally {
        setPlaylistSavingKey("");
      }
    },
    [
      getAlbumForTrack,
      getArtistForAlbum,
      loadStaticPlaylists,
      setPlaylistsError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const addLibraryTrackToPlaylist = useCallback(
    (track: LibraryPageTrack, target: PlaylistTarget) =>
      saveLibraryTracksToPlaylist([track], target, {
        key: String(track?.id || ""),
        label: "Track",
        defaultName: getDefaultTrackPlaylistName(track),
      }),
    [getDefaultTrackPlaylistName, saveLibraryTracksToPlaylist],
  );

  const { removeTracks: removePlaylistTracks } = usePlaylistBulkActions();
  const hiddenPlaylistTracks = useHiddenPlaylistTracks();
  const removablePlaylists = useMemo(
    () =>
      hiddenPlaylistTracks.size
        ? staticPlaylists.map((playlist) => {
            const hiddenIds = hiddenPlaylistTracks.get(playlist.id);
            return hiddenIds && Array.isArray(playlist.trackEntries)
              ? {
                  ...playlist,
                  trackEntries: playlist.trackEntries.filter((entry) => !hiddenIds.has(entry.id)),
                }
              : playlist;
          })
        : staticPlaylists,
    [hiddenPlaylistTracks, staticPlaylists],
  );

  const removeLibraryTrackFromPlaylist = useCallback(
    (track: LibraryPageTrack, target: PlaylistRemoveTarget | null | undefined) => {
      if (!target?.playlistId || !target?.jobId) return;
      const playlist = staticPlaylists.find((candidate) => candidate.id === target.playlistId);
      removePlaylistTracks({ id: target.playlistId, name: playlist?.name }, [
        { id: target.jobId, trackName: track?.title },
      ]);
    },
    [removePlaylistTracks, staticPlaylists],
  );

  const canDeleteArtist = hasPermission("deleteArtist");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const canDeleteTrack = hasPermission("deleteTrack") || canDeleteAlbum;
  const canAddTracks = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const canEditArtwork = !isPreviewLibrary && (canAddTracks || canChangeMonitoring);
  const libraryDestination = useLibraryDestination();
  const { isAlbumDownloading, isTrackDownloading } = useActiveDownloads();
  const canEditArtistMbid = hasPermission("addArtist");

  const openArtworkEditor = useCallback(
    (
      kind: "album" | "track",
      entity: LibraryAlbum | LibraryPageTrack,
      currentArtwork: string | null | undefined,
      fallbackArtwork = "",
    ) => {
      setArtworkEditor({
        kind,
        id: entity.id,
        title: entity.title,
        currentArtwork: currentArtwork || "",
        hasCustomArtwork: Boolean(entity.customArtworkUrl),
        fallbackArtwork,
      });
    },
    [],
  );

  const handleArtworkSaved = useCallback(
    async (result: CustomArtworkResult) => {
      const editor = artworkEditor;
      if (editor) {
        const artwork = result?.updatedAt
          ? getLibraryCustomArtworkUrl(editor.kind, editor.id, result.updatedAt)
          : editor.fallbackArtwork || null;
        updateQueueArtwork(
          editor.kind === "album" ? { libraryAlbumId: editor.id } : { libraryTrackId: editor.id },
          artwork,
          editor.kind === "track" && result?.updatedAt ? "track" : "album",
        );
      }
      clearLibraryPageCache();
      queryClient.invalidateQueries({
        queryKey: queryKeys.libraryAlbumTracksPrefix,
        refetchType: "none",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix }),
        queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix }),
      ]);
      showSuccess("Artwork updated");
    },
    [artworkEditor, showSuccess, updateQueueArtwork],
  );

  const openLibraryRemoval = useCallback((target: LibraryTarget, manager: string | null = null) => {
    setDeleteFiles(false);
    setLibraryRemoval({ ...target, manager });
  }, []);

  const removeLocalLibraryEntity = useCallback(
    (removal: LibraryRemoval) => {
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
                !(track.albums || []).some((relation) =>
                  removedAlbumIds.has(String(relation.albumId)),
                ),
            ),
          };
        }
        if (removal.kind === "album") {
          return {
            ...current,
            albums: current.albums.filter((album) => String(album.id) !== entityId),
            tracks: current.tracks.filter(
              (track) =>
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
    },
    [setLibrary],
  );

  const handleLibraryRemovalConfirm = useCallback(async () => {
    if (!libraryRemoval?.entity || deletingLibraryEntity) return;
    const removal = libraryRemoval;
    const trackHasFile = removal.kind === "track" && Boolean(firstAvailableFile(removal.entity));
    setDeletingLibraryEntity(true);
    try {
      if (!isPreviewLibrary) {
        if (removal.kind === "artist") {
          await parseResponse(
            libraryArtistsClient.artists[":mbid"].$delete({
              param: { mbid: encodeURIComponent(removal.entity.mbid || removal.entity.id) },
              query: { deleteFiles: String(deleteFiles) },
            }),
          );
        } else if (removal.kind === "album") {
          const { entity } = removal;
          if (resolveAlbumManager(entity) === "aurral") {
            await parseResponse(
              libraryAlbumsClient.albums.aurral[":canonicalId"].$delete({
                param: { canonicalId: encodeURIComponent(entity.canonicalId || entity.id) },
                query: { deleteFiles: String(deleteFiles) },
              }),
            );
          } else if (entity.providerId != null && /^\d+$/.test(String(entity.providerId))) {
            await parseResponse(
              libraryAlbumsClient.albums[":id"].$delete({
                param: { id: encodeURIComponent(entity.providerId) },
                query: { deleteFiles: String(deleteFiles) },
              }),
            );
          } else {
            await parseResponse(
              libraryAlbumsClient.albums.lidarr[":mbid"].$delete({
                param: { mbid: encodeURIComponent(String(entity.releaseGroupMbid || entity.mbid)) },
                query: { deleteFiles: String(deleteFiles) },
              }),
            );
          }
        } else {
          await parseResponse(
            libraryTracksClient.tracks[":id"].$delete({
              param: { id: encodeURIComponent(removal.entity.id) },
            }),
          );
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
        (removal.kind === "artist" && String(routeArtistId) === String(removal.entity.id)) ||
        (removal.kind === "album" && String(routeAlbumId) === String(removal.entity.id))
      ) {
        navigate(
          removal.kind === "artist"
            ? "/library/artists" + previewQuery
            : "/library/albums" + previewQuery,
        );
      }
    } catch (requestError) {
      showError(getApiErrorMessage(requestError) || "Failed to update library");
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
    async (track: LibraryPageTrack) => {
      if (!track || firstAvailableFile(track) || isPreviewLibrary) return null;
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const relation = track?.albums?.find((entry) => String(entry.albumId) === String(album?.id));
      const payload = {
        artistName: artist?.name || track?.artistName || "",
        trackName: track?.title || "",
        albumName: album?.title || track?.albumName || "",
        artistMbid: artist?.mbid || "",
        albumMbid: album?.releaseGroupMbid || album?.mbid || "",
        trackMbid: track?.mbid || "",
        releaseYear: yearOf(album?.releaseDate),
        durationMs: trackDurationMs(track),
        trackNumber: relation?.trackNumber || null,
        discNumber: relation?.discNumber || null,
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
              status: "reused" in result && result.reused ? "moving" : "searching",
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
        showError(getApiErrorMessage(requestError) || "Failed to add track to library");
        return null;
      }
    },
    [getAlbumForTrack, getArtistForAlbum, isPreviewLibrary, showError, showSuccess],
  );

  const handleReSearchLibraryTrack = useCallback(
    async (track: LibraryPageTrack, album: LibraryAlbum) => {
      if (!track?.id || !album?.id || isPreviewLibrary || !canAddTracks) return;
      const key = `${track.id}:${album.id}`;
      setTrackResearchStates((current) => ({ ...current, [key]: true }));
      try {
        await reSearchLibraryTrack(track.id, { albumId: album.id });
        showSuccess(`Queued a replacement search for ${track.title || "track"}`);
      } catch (requestError) {
        showError(getApiErrorMessage(requestError) || "Failed to queue a replacement search");
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
    (album: LibraryAlbum | null | undefined) => {
      const tracks = getAlbumTracks(album);
      const total = album?.trackCount || tracks.length || (album?.trackIds || []).length;
      const available =
        album?.availableTrackCount != null && tracks.length !== total
          ? album.availableTrackCount
          : tracks.filter((track) => firstAvailableFile(track)).length;
      return { total, available };
    },
    [getAlbumTracks],
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
  const hasMissingAlbumTracks = Boolean(
    libraryAlbum && getAlbumTracks(libraryAlbum).some((track) => !firstAvailableFile(track)),
  );
  const activityQueryKey = useMemo(() => queryKeys.libraryActivityRequests(user?.id), [user?.id]);
  const hasTrackDownloadPolling = Object.values(trackDownloadStates).some(
    (state) =>
      state?.jobId &&
      state.status !== "completed" &&
      TRACK_DOWNLOAD_ACTIVE_STATUSES.has(state.status),
  );
  const activityQuery = useQuery({
    queryKey: activityQueryKey,
    queryFn: ({ signal }): Promise<ActivityRequest[]> =>
      parseResponse(requestsClient.$get({ query: { refresh: "1" } }, { init: { signal } })),
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
    (albumId: string | number, result: AurralMonitoringResult) => {
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
  const patchLibraryTrack = useCallback(
    (trackId: string | number, patch: Partial<LibraryTrack>) => {
      const mark = (track: LibraryTrack) =>
        String(track.id) === String(trackId) ? { ...track, ...patch } : track;
      setLibrary((current) => ({ ...current, tracks: current.tracks.map(mark) }));
      queryClient.setQueriesData({ queryKey: queryKeys.libraryAlbumTracksPrefix }, (data) => {
        if (
          !data ||
          typeof data !== "object" ||
          !("tracks" in data) ||
          !Array.isArray(data.tracks)
        ) {
          return data;
        }
        return { ...data, tracks: data.tracks.map(mark) };
      });
      clearLibraryPageCache();
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      refreshLibraryActivity();
    },
    [refreshLibraryActivity, setLibrary],
  );
  const updateTrackMonitoringState = useCallback(
    (trackId: string | number, result: AurralMonitoringResult) =>
      patchLibraryTrack(trackId, { monitored: result?.monitored !== false }),
    [patchLibraryTrack],
  );
  const trackMonitoring = useAurralTrackMonitoring({
    canChange: canChangeMonitoring,
    onChanged: updateTrackMonitoringState,
    onKeepFileChanged: (trackId, result) =>
      patchLibraryTrack(trackId, { keepFile: result?.keepFile === true }),
  });

  const reloadLibraryAlbumTracks = useCallback(async () => {
    if (!libraryAlbum) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracks(
        String(libraryAlbum.id),
        libraryAlbum.releaseGroupMbid || null,
      ),
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
      ? libraryAlbum!.providerId
      : null;
  const [lidarrMonitoredOverride, setLidarrMonitoredOverride] = useState<{
    albumId: string | number;
    monitored: boolean;
  } | null>(null);
  const albumMonitored =
    albumManager === "aurral"
      ? albumMonitoring.monitored
      : lidarrAlbumId
        ? lidarrMonitoredOverride?.albumId === lidarrAlbumId
          ? lidarrMonitoredOverride!.monitored
          : libraryAlbum!.monitored === true
        : null;
  const canDownloadLibraryAlbum = (() => {
    if (!canAddTracks || isPreviewLibrary || !libraryAlbum || !hasMissingAlbumTracks) return false;
    if (!libraryDestination.ready || !(libraryAlbum.releaseGroupMbid || libraryAlbum.mbid))
      return false;
    if (activeManager === "lidarr") return true;
    if (albumManager === "aurral")
      return canDownloadAurralAlbum(libraryAlbum, { hasMissingTracks: true });
    return albumManager !== "lidarr";
  })();
  const downloadLibraryAlbum = useCallback(async () => {
    if (!libraryAlbum) return;
    const title = libraryAlbum.title || "album";
    setAlbumDownloadPending(true);
    try {
      const result = await requestAlbumFromSearch({
        ...buildAurralAlbumRetryPayload({
          album: libraryAlbum,
          artist: getArtistForAlbum(libraryAlbum),
        }),
        managedBy: activeManager,
        triggerSearch: activeManager === "lidarr",
      });
      const queued = result?.jobIds?.length || 0;
      showSuccess(
        activeManager === "lidarr"
          ? describeAlbumRequestResult(result, title).message
          : queued > 0
            ? `Queued ${queued} ${queued === 1 ? "track" : "tracks"} from ${title}`
            : `Monitoring ${title}`,
      );
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(libraryAlbum.id)
            ? { ...entry, managedBy: activeManager }
            : entry,
        ),
      }));
      updateAlbumMonitoringState(libraryAlbum.id, { monitored: true });
      await reloadLibraryAlbumTracks();
    } catch (requestError) {
      showError(getApiErrorMessage(requestError) || `Failed to download ${title}`);
    } finally {
      setAlbumDownloadPending(false);
    }
  }, [
    activeManager,
    getArtistForAlbum,
    libraryAlbum,
    reloadLibraryAlbumTracks,
    setLibrary,
    showError,
    showSuccess,
    updateAlbumMonitoringState,
  ]);

  const setLidarrAlbumMonitored = useCallback(
    async (monitored: boolean) => {
      if (!lidarrAlbumId || lidarrMonitoredOverride) return;
      const title = libraryAlbum!.title || "Album";
      setLidarrMonitoredOverride({ albumId: lidarrAlbumId, monitored });
      try {
        await parseResponse(
          libraryAlbumsClient.albums[":id"].$put({
            param: { id: encodeURIComponent(lidarrAlbumId) },
            json: { monitored },
          }),
        );
        updateAlbumMonitoringState(libraryAlbum!.id, { monitored });
        showSuccess(monitored ? `${title} monitored in Lidarr` : `${title} unmonitored in Lidarr`);
      } catch (requestError) {
        showError(
          `Could not ${monitored ? "monitor" : "unmonitor"} ${title} in Lidarr. Nothing changed. ${
            getApiErrorMessage(requestError) || "Try again."
          }`,
        );
      } finally {
        setLidarrMonitoredOverride(null);
      }
    },
    [
      libraryAlbum,
      lidarrAlbumId,
      lidarrMonitoredOverride,
      showError,
      showSuccess,
      updateAlbumMonitoringState,
    ],
  );
  const lidarrAlbumAction =
    activeManager === "lidarr" && lidarrAlbumId && canChangeMonitoring
      ? getMonitoringMenuAction({ monitored: albumMonitored, hasMissing: hasMissingAlbumTracks })
      : null;
  const albumMonitoringMenuItem =
    albumManager === "lidarr"
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
        : albumMonitoring.menuItem && {
            ...albumMonitoring.menuItem,
            onSelect: downloadLibraryAlbum,
          };

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
    const nextStates: Record<string, TrackDownloadState> = {};
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
          sameTrackText(
            candidate.artistName,
            getArtistForAlbum(libraryAlbum)?.name || libraryAlbum.albumArtist || track.artistName,
          ) &&
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
  }, [
    activityQuery.data,
    getAlbumTracks,
    getArtistForAlbum,
    isPreviewLibrary,
    libraryAlbum,
    library.tracks,
  ]);

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
      .filter((item): item is typeof item & { mbid: string } =>
        Boolean(item.mbid && !item.coverUrl),
      );
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
        const next: Record<string, string> = {};
        coverItems.forEach((item) => {
          const image = result?.[item.mbid]?.image;
          if (image) next[item.mbid] = image;
        });
        if (Object.keys(next).length) setCovers((current) => ({ ...current, ...next }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [coverItems]);

  const getAlbumCover = useCallback(
    (album: LibraryAlbum | null | undefined) => {
      const coverId = getAlbumCoverId(album);
      const url = album?.coverUrl || (coverId ? covers[coverId] : undefined) || "";
      return url.startsWith("/api/library/albums/")
        ? buildAuthenticatedApiUrl(url.replace(/^\/api/, ""))
        : url;
    },
    [covers],
  );
  const [artistHeroImage, setArtistHeroImage] = useState<string | null | undefined>(null);
  useEffect(() => setArtistHeroImage(null), [libraryArtist?.id]);
  const detailTint = useCollectionTint(
    libraryAlbum ? getAlbumCover(libraryAlbum) : libraryArtist ? artistHeroImage : null,
  );

  const buildPlayableTrack = useCallback(
    (track: LibraryPageTrack, lookup: LibraryLookup | null = null) => {
      const album = getAlbumForTrack(track, lookup?.albumsById);
      const artist = getArtistForAlbum(album, lookup?.artistsById);
      const file = firstAvailableFile(track, album?.id);
      return {
        id: track.id,
        title: track.title,
        artist: track.artistName || artist?.name || "Unknown Artist",
        album: album?.title || track.albumName || "Unknown Album",
        src:
          file?.previewUrl ||
          (file && album
            ? buildAuthenticatedApiUrl(
                `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
              )
            : ""),
        streamFormat: file?.format || null,
        quality: file?.quality || null,
        artistMbid: trackArtistMbid(track, artist),
        albumMbid: album?.releaseGroupMbid || album?.mbid || null,
        trackMbid: track.mbid || null,
        libraryTrackId: file && album ? track.id : null,
        libraryAlbumId: file && album ? album.id : null,
        durationMs: Number(track.durationMs || file?.durationMs || 0) || null,
        recordHistory: true,
        artwork: track.artworkUrl || getAlbumCover(album),
        artworkSource: track.artworkUrl ? "track" : "album",
      };
    },
    [getAlbumCover, getAlbumForTrack, getArtistForAlbum],
  );

  const playableTracks = useCallback(
    (tracks: LibraryPageTrack[], lookup: LibraryLookup | null = null) => {
      const playable = tracks
        .map((track) => buildPlayableTrack(track, lookup))
        .filter((track) => track.src);
      if (!playable.length) showError("No playable tracks in this selection.");
      return playable;
    },
    [buildPlayableTrack, showError],
  );

  const playTracks = useCallback(
    (
      tracks: LibraryPageTrack[],
      startTrack: LibraryPageTrack | null = null,
      shuffle = false,
      lookup: LibraryLookup | null = null,
    ) => {
      const playable = playableTracks(tracks, lookup);
      if (!playable.length) return;
      playQueue(playable, {
        startTrackId: startTrack?.id ?? null,
        shuffle,
        source: librarySource,
      });
    },
    [librarySource, playQueue, playableTracks],
  );

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
          pageSize,
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

  const loadAlbumCollection = useCallback(
    async (album: LibraryAlbum) => ({ tracks: await loadAlbumTracks(album), lookup: null }),
    [loadAlbumTracks],
  );

  const withCollection = useCallback(
    async (
      load: () => Promise<LibraryCollection>,
      action: (collection: LibraryCollection) => unknown,
    ) => {
      let collection;
      try {
        collection = await load();
      } catch (requestError) {
        showError(getApiErrorText(requestError, "message") || "Failed to load tracks");
        return;
      }
      await action(collection);
    },
    [showError],
  );

  const playCollection = useCallback(
    (load: () => Promise<LibraryCollection>, shuffle = false) =>
      withCollection(load, ({ tracks, lookup }) => playTracks(tracks, null, shuffle, lookup)),
    [playTracks, withCollection],
  );

  const queueCollection = useCallback(
    (load: () => Promise<LibraryCollection>, position: "next" | "end") =>
      withCollection(load, ({ tracks, lookup }) => {
        const playable = playableTracks(tracks, lookup);
        if (!playable.length) return;
        const insert = position === "next" ? queueNext : addToQueue;
        if (insert(playable, { source: librarySource }) === "queued") {
          showSuccess(position === "next" ? "Playing next" : "Added to queue");
        }
      }),
    [addToQueue, librarySource, playableTracks, queueNext, showSuccess, withCollection],
  );

  const playAlbum = useCallback(
    (album: LibraryAlbum) => playCollection(() => loadAlbumCollection(album)),
    [loadAlbumCollection, playCollection],
  );

  const toggleFavorite = useCallback(
    async (
      kind: "artist" | "album" | "song",
      entity: LibraryArtist | LibraryAlbum | LibraryPageTrack,
    ) => {
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
      const name = entity && ("name" in entity ? entity.name : entity.title);
      try {
        const result = await updateLibraryFavorites([id], nextStarred);
        const changedIds = Array.isArray(result?.changedIds) ? result.changedIds : [];
        const applyFavorite = (starred: boolean) =>
          setFavoriteIds((current) => {
            const next = new Set(current);
            for (const changedId of changedIds) {
              if (starred) next.add(changedId);
              else next.delete(changedId);
            }
            return next;
          });
        applyFavorite(nextStarred);
        if (!nextStarred) {
          showFavoriteRemoved(toast, {
            name,
            removed: result?.removed,
            restore: () => applyFavorite(true),
            revert: () => applyFavorite(false),
            onRestored: () =>
              queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix }),
          });
        }
      } catch (requestError) {
        setFavoriteIds(previous);
        showError(
          `Could not ${nextStarred ? "add" : "remove"} ${name || "this item"} ${nextStarred ? "to" : "from"} favorites. Nothing changed. ${
            getApiErrorText(requestError, "message") || "Try again."
          }`,
        );
      } finally {
        favoriteMutationInFlightRef.current = false;
        setPendingFavorite(null);
      }
    },
    [favoriteIds, isPreviewLibrary, setFavoriteIds, showError, toast],
  );

  const playTrack = useCallback(
    (track: LibraryPageTrack, context?: LibraryPageTrack[] | null) => {
      const playable = buildPlayableTrack(track);
      if (!playable.src) return;
      if (String(currentTrack?.id) === String(playable.id) && matchesSource(librarySource)) {
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

  function libraryArtistPath(artist: Pick<LibraryArtist, "id">): string;
  function libraryArtistPath(artist: Pick<LibraryArtist, "id"> | null | undefined): string | null;
  function libraryArtistPath(artist: Pick<LibraryArtist, "id"> | null | undefined) {
    return artist?.id ? "/library/artist/" + encodeURIComponent(artist.id) + previewQuery : null;
  }
  function libraryAlbumPath(album: LibraryAlbum): string;
  function libraryAlbumPath(album: LibraryAlbum | null | undefined): string | null;
  function libraryAlbumPath(album: LibraryAlbum | null | undefined) {
    return album?.id ? "/library/album/" + encodeURIComponent(album.id) + previewQuery : null;
  }

  const handleArtistOpen = (artist: Pick<LibraryArtist, "id">) => {
    const path = libraryArtistPath(artist);
    if (path) navigate(path);
  };

  const artistMbidMenuItems = (
    artist: LibraryArtist | null | undefined,
    { separatorBefore = false }: { separatorBefore?: boolean } = {},
  ) =>
    canEditArtistMbid && (artist && "providerId" in artist ? artist.providerId : undefined) == null
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

  const shareLibraryItem = (
    target: LibraryTarget,
    {
      artist = null,
      album = null,
    }: { artist?: LibraryArtist | null; album?: LibraryAlbum | null } = {},
  ) => {
    if (target.kind === "artist") {
      const { entity } = target;
      shareLibrary(
        {
          kind: target.kind,
          libraryArtistId: entity.id,
          artistMbid: entity.mbid,
          artistName: entity.name,
        },
        entity.name,
      );
      return;
    }
    if (target.kind === "album") {
      const { entity } = target;
      shareLibrary(
        {
          kind: target.kind,
          libraryAlbumId: entity.id,
          albumMbid: entity.releaseGroupMbid || entity.mbid,
          artistMbid: artist?.mbid,
          title: entity.title,
          artistName: artist?.name || entity.albumArtist || album?.albumArtist,
        },
        entity.title,
      );
      return;
    }
    const { entity } = target;
    shareLibrary(
      {
        kind: target.kind,
        libraryTrackId: entity.id,
        libraryAlbumId: album?.id,
        trackMbid: entity.mbid,
        albumMbid: album?.releaseGroupMbid || album?.mbid,
        artistMbid: trackArtistMbid(entity, artist),
        title: entity.title,
        artistName: entity.artistName || artist?.name || album?.albumArtist,
        albumTitle: album?.title,
      },
      entity.title,
    );
  };

  const shareMenuItem = (
    target: LibraryTarget,
    context?: { artist?: LibraryArtist | null; album?: LibraryAlbum | null },
  ) => ({
    id: "share",
    label: "Share",
    icon: Share,
    onSelect: () => shareLibraryItem(target, context),
    disabled: isPreviewLibrary,
  });

  const collectionQueueItems = (load: () => Promise<LibraryCollection>, disabled = false) => [
    {
      id: "queue-next",
      label: "Play next",
      icon: ListStart,
      disabled,
      onSelect: () => queueCollection(load, "next"),
    },
    {
      id: "queue-add",
      label: "Add to queue",
      icon: ListEnd,
      disabled,
      onSelect: () => queueCollection(load, "end"),
    },
  ];

  const collectionPlayItems = (load: () => Promise<LibraryCollection>, disabled = false) => [
    { id: "play", label: "Play", icon: Play, disabled, onSelect: () => playCollection(load) },
    {
      id: "shuffle",
      label: "Shuffle",
      icon: Shuffle,
      disabled,
      onSelect: () => playCollection(load, true),
    },
    ...collectionQueueItems(load, disabled),
  ];

  const collectionPlaylistMenu = ({
    key,
    label,
    defaultName,
    load,
  }: {
    key: string;
    label: string;
    defaultName: string;
    load: () => Promise<LibraryCollection>;
  }) => ({
    additionalItemsAfter: "queue-add",
    onMenuOpen: loadStaticPlaylists,
    renderAdditionalItems: ({ closeMenu }: { closeMenu: () => void }) => (
      <>
        <div className="native-library-item-menu__separator" />
        <TrackPlaylistSubmenu
          label="Add to playlist"
          playlists={staticPlaylists}
          loading={playlistsLoading}
          saving={playlistSavingKey === key}
          error={playlistsError}
          defaultNewPlaylistName={reserveUniquePlaylistName(staticPlaylists, defaultName)}
          onSelect={(target: PlaylistTarget) =>
            withCollection(load, ({ tracks, lookup }) =>
              saveLibraryTracksToPlaylist(
                tracks.filter((track) => firstAvailableFile(track)),
                target,
                { key, label, defaultName, lookup },
              ),
            )
          }
          onClose={closeMenu}
          toggleOnClick
        />
      </>
    ),
  });

  const albumMenuProps = (album: LibraryAlbum, load: () => Promise<LibraryCollection>) =>
    collectionPlaylistMenu({
      key: "album:" + album.id,
      label: album.title || "Album",
      defaultName: album.title || "Album",
      load,
    });

  const artistMenuProps = (artist: LibraryArtist) =>
    collectionPlaylistMenu({
      key: "artist:" + artist.id,
      label: artist.name || "Artist",
      defaultName: `${artist.name || "Artist"} Picks`,
      load: () => loadArtistTracks(artist),
    });

  const openLibraryInfo = (
    target: LibraryTarget,
    context: Omit<LibraryInfoState, "kind" | "entity"> = {},
  ) => {
    setLibraryInfo({ ...target, ...context });
  };

  const discoverArtistState = (artist: LibraryArtist) => ({
    artistName: artist.name,
    inLibrary: true,
    libraryArtist: artist,
  });

  const handleDiscoverArtistOpen = (artist: LibraryArtist | null | undefined) => {
    if (!artist?.mbid) return;
    navigate("/artist/" + encodeURIComponent(artist.mbid), {
      state: discoverArtistState(artist),
    });
  };

  const handleDiscoverAlbumOpen = (album: LibraryAlbum) => {
    handleDiscoverArtistOpen(getArtistForAlbum(album));
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

  const updateGenreFilter = (genre: string) => updateViewParams({ genre, page: null });

  const renderTrackList = (
    tracks: LibraryPageTrack[],
    label: string,
    { variant = "collection" }: { variant?: "collection" | "release" } = {},
  ) => (
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
          String(currentTrack?.id) === String(track.id) && matchesSource(librarySource);
        const artistName = track.artistName || artist?.name || "Unknown Artist";
        const albumName = album?.title || track.albumName || "Unknown Album";
        const trackNumber = track.albums?.find(
          (entry) => String(entry.albumId) === String(album?.id),
        )?.trackNumber;
        const isFavorite = favoriteIds.has(favoriteId("song", track));
        const monitoringItem = trackMonitoring.getMenuItem(track, {
          aurral:
            (album?.managedBy === "aurral" && (!file || hasDeletableTrackFile(track))) ||
            hasAurralTrackFile(track) ||
            downloadPending,
          hasFile: Boolean(file),
          downloadPending,
        });
        const keepFileItem = trackMonitoring.getKeepFileItem(track, {
          aurral: hasAurralTrackFile(track),
          hasFile: Boolean(file),
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
          shareMenuItem({ kind: "track", entity: track }, { artist, album }),
          {
            id: "info",
            label: "View info",
            icon: Info,
            onSelect: () =>
              openLibraryInfo({ kind: "track", entity: track }, { artist, album, trackNumber }),
          },
          ...(canEditArtwork
            ? [
                {
                  id: "artwork",
                  label: "Change artwork",
                  icon: ImagePlus,
                  onSelect: () =>
                    openArtworkEditor(
                      "track",
                      track,
                      track.artworkUrl || (album ? getAlbumCover(album) : ""),
                      album ? getAlbumCover(album) : "",
                    ),
                },
              ]
            : []),
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
                  disabled:
                    isPreviewLibrary ||
                    trackResearchStates[`${track.id}:${researchAlbum.id}`] === true,
                  onSelect: () => handleReSearchLibraryTrack(track, researchAlbum),
                },
              ]
            : []),
          ...(monitoringItem ? [monitoringItem] : []),
          ...(keepFileItem ? [{ ...keepFileItem, separatorBefore: !monitoringItem }] : []),
          ...(canDeleteTrack && (hasDeletableTrackFile(track) || hasAurralTrackFile(track))
            ? [
                {
                  id: "delete",
                  label: file ? "Delete track file" : "Remove track from library",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => openLibraryRemoval({ kind: "track", entity: track }),
                },
              ]
            : []),
        ];
        return {
          key: track.id,
          number: variant === "release" && trackNumber ? trackNumber : index + 1,
          title: track.title || "Unknown Track",
          badge: !trackMonitoring.isMonitored(track) ? (
            <span
              className="native-library-track__unmonitored"
              role="img"
              aria-label="Not monitored"
            >
              <EyeOff aria-hidden="true" />
            </span>
          ) : null,
          subtitle: artistName,
          artist: {
            label: artistName,
            to: isAlbumArtistCredit(track, artist) ? libraryArtistPath(artist) : null,
          },
          album: { label: albumName, to: libraryAlbumPath(album) },
          cover: {
            src: track.artworkUrl || (album ? getAlbumCover(album) : ""),
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
              {downloadPending ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <Download aria-hidden="true" />
              )}
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
                  onSelect={(target: PlaylistTarget) => addLibraryTrackToPlaylist(track, target)}
                  onClose={closeMenu}
                  toggleOnClick
                />
                <TrackPlaylistRemoveSubmenu
                  track={track}
                  playlists={removablePlaylists}
                  saving={playlistSavingKey === String(track.id)}
                  error={playlistsError}
                  onSelect={(target: PlaylistRemoveTarget) =>
                    removeLibraryTrackFromPlaylist(track, target)
                  }
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
                onImageLoad={setArtistHeroImage}
              />
            ) : (
              <Cover label={artist.name} round />
            )}
          </RouteLink>
          <LibraryItemMenu
            label={artist.name || "Artist"}
            {...artistMenuProps(artist)}
            items={[
              ...collectionPlayItems(() => loadArtistTracks(artist)),
              shareMenuItem({ kind: "artist", entity: artist }),
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => openLibraryInfo({ kind: "artist", entity: artist }),
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
              ...(canDeleteArtist && canRemoveLibraryArtist(artist)
                ? [
                    {
                      id: "delete",
                      label: "Delete artist",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval({ kind: "artist", entity: artist }),
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
      seed: {
        title: album.title || "",
        artistName: artist?.name || album.albumArtist || "",
        coverUrl: getAlbumCover(album) || null,
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
            disabled={albumEmpty}
            label={"Play " + (album.title || "album")}
            aria-label={"Play " + (album.title || "album")}
          >
            <Play aria-hidden="true" fill="currentColor" />
          </TooltipButton>
          <LibraryItemMenu
            label={album.title || "Album"}
            {...albumMenuProps(album, () => loadAlbumCollection(album))}
            items={[
              ...collectionPlayItems(() => loadAlbumCollection(album), albumEmpty),
              shareMenuItem({ kind: "album", entity: album }, { artist }),
              {
                id: "info",
                label: "View info",
                icon: Info,
                onSelect: () => openLibraryInfo({ kind: "album", entity: album }, { artist }),
              },
              ...(canEditArtwork
                ? [
                    {
                      id: "artwork",
                      label: "Change artwork",
                      icon: ImagePlus,
                      onSelect: () =>
                        openArtworkEditor(
                          "album",
                          album,
                          getAlbumCover(album),
                          album.defaultCoverUrl || "",
                        ),
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
              ...(canDeleteAlbum &&
              canRemoveLibraryAlbum(album, {
                lidarrConnected: libraryDestination.primary === "lidarr",
              })
                ? [
                    {
                      id: "delete",
                      label: "Delete album",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval({ kind: "album", entity: album }),
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
            {meta.partial ? (
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

  const renderSectionHeader = (
    title: string,
    count?: number | null,
    path = "",
    actionLabel = "View all",
  ) => (
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

  const renderLibraryAlbumDetail = () => {
    if (!libraryAlbum) return null;
    const artist = getArtistForAlbum(libraryAlbum);
    const albumTracks = getAlbumTracks(libraryAlbum);
    const availability = albumAvailability(libraryAlbum);
    const discoverArtist = hasMbid(artist) ? artist : null;
    const durationMs = albumTracks.reduce(
      (total, track) => total + Number(firstAvailableFile(track)?.durationMs || 0),
      0,
    );
    const albumPlayable = albumTracks.some((track) => firstAvailableFile(track));
    const loadAlbumDetail = async () => ({ tracks: albumTracks, lookup: null });
    const albumIsCurrent =
      matchesSource(librarySource) &&
      albumTracks.some((track) => String(track.id) === String(currentTrack?.id));
    return (
      <section className="native-library-detail">
        <CollectionHeader
          cover={
            <Cover src={getAlbumCover(libraryAlbum)} label={libraryAlbum.title} thumbnail={false} />
          }
          kicker={releaseTypeOf(libraryAlbum) || "Album"}
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
                    <span
                      className="native-library-detail__manager"
                      data-unmonitored
                      role="img"
                      aria-label="Not monitored"
                    >
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
                  label={
                    libraryAlbumDownloading
                      ? "Downloading album"
                      : albumManager === "lidarr" && albumMonitored
                        ? "Search for album"
                        : "Download album"
                  }
                  aria-label={
                    (libraryAlbumDownloading
                      ? "Downloading "
                      : albumManager === "lidarr" && albumMonitored
                        ? "Search for "
                        : "Download ") + (libraryAlbum.title || "album")
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
                {...albumMenuProps(libraryAlbum, loadAlbumDetail)}
                items={[
                  ...collectionQueueItems(loadAlbumDetail, !albumPlayable),
                  shareMenuItem({ kind: "album", entity: libraryAlbum }, { artist }),
                  {
                    id: "info",
                    label: "View info",
                    icon: Info,
                    onSelect: () =>
                      openLibraryInfo({ kind: "album", entity: libraryAlbum }, { artist }),
                  },
                  ...(canEditArtwork
                    ? [
                        {
                          id: "artwork",
                          label: "Change artwork",
                          icon: ImagePlus,
                          onSelect: () =>
                            openArtworkEditor(
                              "album",
                              libraryAlbum,
                              getAlbumCover(libraryAlbum),
                              libraryAlbum.defaultCoverUrl || "",
                            ),
                        },
                      ]
                    : []),
                  ...(albumMonitoringMenuItem ? [albumMonitoringMenuItem] : []),
                  ...(canDeleteAlbum &&
                  canRemoveLibraryAlbum(libraryAlbum, {
                    lidarrConnected: activeManager === "lidarr",
                  })
                    ? [
                        {
                          id: "delete",
                          label: "Delete album",
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          onSelect: () =>
                            openLibraryRemoval({ kind: "album", entity: libraryAlbum }),
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
    const artistTopTracks = topArtistTracks(artistTracks, albumsById);
    const artistTrackTotal = ownedAlbums.reduce(
      (total, album) => total + Number(albumAvailability(album).total || 0),
      0,
    );
    const discoverArtist = hasMbid(libraryArtist) ? libraryArtist : null;
    const artistPlayable = artistTracks.some((track) => firstAvailableFile(track));
    const artistIsCurrent =
      matchesSource(librarySource) &&
      artistTracks.some((track) => String(track.id) === String(currentTrack?.id));
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
                thumbnail={false}
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
              <CollectionPlayButtons
                label={libraryArtist.name || "artist"}
                disabled={!artistPlayable}
                isPlaying={artistIsCurrent && isRunning}
                isShuffleEnabled={false}
                onPlay={() =>
                  artistIsCurrent
                    ? togglePlayPause()
                    : playCollection(() => loadArtistTracks(libraryArtist))
                }
                onShuffle={() => playCollection(() => loadArtistTracks(libraryArtist), true)}
              />
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
                {...artistMenuProps(libraryArtist)}
                items={[
                  ...collectionQueueItems(() => loadArtistTracks(libraryArtist), !artistPlayable),
                  shareMenuItem({ kind: "artist", entity: libraryArtist }),
                  {
                    id: "info",
                    label: "View info",
                    icon: Info,
                    onSelect: () => openLibraryInfo({ kind: "artist", entity: libraryArtist }),
                  },
                  ...artistMbidMenuItems(libraryArtist, { separatorBefore: true }),
                  ...libraryArtistMonitoringItems,
                  ...(canDeleteArtist && canRemoveLibraryArtist(libraryArtist)
                    ? [
                        {
                          id: "delete",
                          label: "Delete artist",
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          onSelect: () =>
                            openLibraryRemoval({ kind: "artist", entity: libraryArtist }),
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

  const renderLibraryDetail = () =>
    libraryAlbum ? renderLibraryAlbumDetail() : renderLibraryArtistDetail();

  const renderLibraryModals = () => (
    <>
      <DeleteArtistModal
        show={libraryRemoval?.kind === "artist"}
        artistName={libraryRemoval?.kind === "artist" ? libraryRemoval.entity.name : undefined}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        deleting={deletingLibraryEntity}
      />
      {trackMonitoring.dialog}
      {libraryArtistMonitoring.dialog}
      <DeleteAlbumModal
        show={libraryRemoval?.kind === "album"}
        title={libraryRemoval?.kind === "album" ? libraryRemoval.entity.title : undefined}
        managedBy={resolveAlbumManager(libraryRemoval?.entity)}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        removing={deletingLibraryEntity}
      />
      <DeleteTrackModal
        show={libraryRemoval?.kind === "track"}
        title={libraryRemoval?.kind === "track" ? libraryRemoval.entity.title : undefined}
        hasFile={Boolean(
          firstAvailableFile(libraryRemoval?.kind === "track" ? libraryRemoval.entity : null),
        )}
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
      <ArtworkEditorModal
        open={Boolean(artworkEditor)}
        title={artworkEditor?.title || "Library item"}
        currentArtwork={artworkEditor?.currentArtwork}
        hasCustomArtwork={artworkEditor?.hasCustomArtwork}
        onClose={() => setArtworkEditor(null)}
        onUpload={(file) =>
          parseResponse(
            libraryArtworkClient.artwork[":kind"][":id"].$put(
              { param: { kind: artworkEditor!.kind, id: encodeURIComponent(artworkEditor!.id) } },
              {
                init: { body: file },
                headers: { "Content-Type": file.type || "application/octet-stream" },
              },
            ),
          )
        }
        onSaveUrl={(url) =>
          parseResponse(
            libraryArtworkClient.artwork[":kind"][":id"].url.$put({
              param: { kind: artworkEditor!.kind, id: encodeURIComponent(artworkEditor!.id) },
              json: { url },
            }),
          )
        }
        onRemove={() =>
          parseResponse(
            libraryArtworkClient.artwork[":kind"][":id"].$delete({
              param: { kind: artworkEditor!.kind, id: encodeURIComponent(artworkEditor!.id) },
            }),
          )
        }
        onSaved={handleArtworkSaved}
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
            {routeArtistId ? (
              <SkeletonLibraryArtist label="Loading library" />
            ) : albumSeed?.title ? (
              <section className="native-library-detail">
                <CollectionHeader
                  cover={
                    <Cover src={albumSeed.coverUrl} label={albumSeed.title} thumbnail={false} />
                  }
                  kicker="Album"
                  title={albumSeed.title}
                  subtitle={
                    albumSeed.artistName ? (
                      <span className="native-library-detail__artist">{albumSeed.artistName}</span>
                    ) : null
                  }
                  meta={<SkeletonText width="11em" />}
                  actions={
                    <CollectionPlayButtons label={albumSeed.title} disabled isPlaying={false} />
                  }
                />
                <SkeletonStatus label="Loading library">
                  <SkeletonTrackList count={12} variant="release" />
                </SkeletonStatus>
              </section>
            ) : (
              <SkeletonAlbumDetail label="Loading library" />
            )}
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
        className={`library-page native-library-page${libraryAlbum || libraryArtist ? " collection-page" : ""}`}
        style={detailTint ? { "--collection-tint": detailTint } : undefined}
      >
        {renderLibraryModals()}
        {renderStatus()}
        {!loading && !error && !libraryAlbum && !libraryArtist && (
          <EmptyState title="Not found" message="This item is no longer in the Library." />
        )}
        {!loading && !error && (libraryAlbum || libraryArtist) && (
          <div className="native-library-content">{renderLibraryDetail()}</div>
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
              onClick={() => playTracks(collectionTracks)}
              disabled={!collectionPlayable}
              label={"Play " + pageTitle}
            >
              <Play aria-hidden="true" fill="currentColor" />
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
                  <label className="native-library-sort">
                    <span className="sr-only">Sort {sectionLabel.toLocaleLowerCase()} by</span>
                    <select
                      value={sortMode}
                      onChange={(event) =>
                        updateViewParams(
                          {
                            sort:
                              event.target.value === LIBRARY_DEFAULT_SORT
                                ? null
                                : event.target.value,
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
