import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUpZA,
  Download,
  ExternalLink,
  Grid3X3,
  Heart,
  List,
  ListFilter,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import ArtistImage from "../components/ArtistImage";
import { DotLoader } from "../components/DotLoader";
import { LibraryItemMenu, LibraryItemSubmenu } from "../components/LibraryItemMenu";
import TooltipButton from "../components/TooltipButton";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSharedPlaylists } from "../hooks/useSharedPlaylists";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import {
  getReleaseGroupCoversBatch,
  getReleaseGroupTracks,
} from "../utils/api/endpoints/artists.js";
import {
  clearCanonicalLibraryPageCache,
  deleteAlbumFromLibrary,
  deleteArtistFromLibrary,
  deleteTrackFromLibrary,
  getCanonicalLibraryPage,
  getLibraryRefreshStatus,
  getLibraryFavorites,
  getRequests,
  downloadTrackToLibrary,
  requestLibraryRefresh,
  updateLibraryArtist,
  updateLibraryFavorites,
} from "../utils/api/endpoints/library.js";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
  deleteSharedPlaylistTrack,
} from "../utils/api/endpoints/playlists.js";
import { buildAuthenticatedApiUrl } from "../utils/api/core.js";
import { mergeAlbumMetadataTracks } from "../utils/libraryTrackHydration.js";
import { navigateToLibraryAlbum } from "../utils/searchNavigation";
import { DEFAULT_LIBRARY_VIEW, LIBRARY_VIEWS } from "../navigation/libraryNavConfig";
import { libraryPreviewData, libraryPreviewFavorites } from "./libraryPreviewData";
import {
  TrackPlaylistRemoveSubmenu,
  TrackPlaylistSubmenu,
} from "./ArtistDetails/components/TrackPlaylistMenu";
import { DeleteAlbumModal } from "./ArtistDetails/components/DeleteAlbumModal";
import { DeleteArtistModal } from "./ArtistDetails/components/DeleteArtistModal";
import { DeleteTrackModal } from "./ArtistDetails/components/DeleteTrackModal";
import {
  buildSharedPlaylistTrackPayload,
  reserveUniquePlaylistName,
} from "./ArtistDetails/utils";
import { useResponsiveReleaseLimit } from "./ArtistDetails/hooks/useResponsiveReleaseLimit";
import { queryClient, queryKeys } from "../queryClient.js";

const LIBRARY_VIEW_IDS = new Set(LIBRARY_VIEWS.map((view) => view.id));

const text = (value) => String(value || "").trim();

const metadataGenres = (entity) => {
  const metadata = entity?.metadata || {};
  return [metadata.genres, metadata.genre, metadata.common?.genre, metadata.tags?.genre]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
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

const favoriteId = (kind, entity) =>
  kind + ":" + encodeURIComponent(text(entity?.identityKey));

const firstAvailableFile = (track, albumId = null) =>
  (track?.files || []).find((file) => file.available && file.albumId === albumId)
  || (track?.files || []).find((file) => file.available && file.albumId == null)
  || (albumId == null ? (track?.files || []).find((file) => file.available) : null)
  || null;

const EMPTY_LIBRARY = { artists: [], albums: [], tracks: [], genres: [] };

const normalizeLibraryPages = (pages) => pages.reduce(
  (result, page) => {
    ["artists", "albums", "tracks"].forEach((kind) => {
      (Array.isArray(page?.[kind]) ? page[kind] : []).forEach((entity) => {
        if (!result[kind].some((candidate) => String(candidate.id) === String(entity.id))) {
          result[kind].push(entity);
        }
      });
    });
    if (Array.isArray(page?.genres) && page.genres.length > result.genres.length) {
      result.genres = page.genres;
    }
    return result;
  },
  { artists: [], albums: [], tracks: [], genres: [] },
);

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

export const mergeAlbumTrackPageIntoLibrary = (current, page, albumId, tracks) => {
  const merge = (kind) => {
    const existing = current[kind] || [];
    const merged = [
      ...existing,
      ...(Array.isArray(page?.[kind]) ? page[kind] : []),
    ].filter((entity, index, values) =>
      values.findIndex((candidate) => String(candidate.id) === String(entity.id)) === index,
    );
    return merged.length === existing.length &&
      merged.every((entity, index) => entity === existing[index])
      ? existing
      : merged;
  };
  const artists = merge("artists");
  const mergedAlbums = merge("albums");
  const availableTrackCount = tracks.filter((track) => firstAvailableFile(track)).length;
  let albumsChanged = mergedAlbums !== current.albums;
  const albums = mergedAlbums.map((entity) => {
    if (String(entity.id) !== String(albumId)) return entity;
    if (
      entity.trackCount === tracks.length &&
      entity.availableTrackCount === availableTrackCount
    ) {
      return entity;
    }
    albumsChanged = true;
    return {
      ...entity,
      trackCount: tracks.length,
      availableTrackCount,
    };
  });
  const nextTracks = merge("tracks");
  if (artists === current.artists && !albumsChanged && nextTracks === current.tracks) {
    return current;
  }
  return {
    ...current,
    artists,
    albums,
    tracks: nextTracks,
  };
};

export const getCachedAlbumTracks = (album, tracksById) => {
  const queryKey = queryKeys.libraryAlbumTracks(String(album?.id), album?.releaseGroupMbid);
  const cached = queryClient.getQueryState(queryKey)?.isInvalidated
    ? null
    : queryClient.getQueryData(queryKey)?.tracks;
  return cached || album?.trackIds?.map((id) => tracksById.get(String(id))).filter(Boolean) || [];
};

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
const LIBRARY_REFRESH_TIMEOUT_MS = 120000;

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

function FavoriteButton({ active, pending, label, onClick, className = "" }) {
  return (
    <TooltipButton
      className={"native-library-favorite " + className + (active ? " is-active" : "")}
      onClick={onClick}
      disabled={pending}
      label={active ? "Remove from favorites" : "Add to favorites"}
      aria-label={active ? "Remove " + label + " from favorites" : "Add " + label + " to favorites"}
      aria-pressed={active}
    >
      <Heart aria-hidden="true" fill={active ? "currentColor" : "none"} />
    </TooltipButton>
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
  const navigateToDiscover = useDiscoverNavigation();
  const {
    section: routeSection,
    albumId: routeAlbumId,
    artistId: routeArtistId,
  } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { bootstrap, hasPermission, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading,
    playlistsError,
    setPlaylistsError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const { playQueue, currentTrack, isPlaying, isLoading, togglePlayPause, matchesSource } =
    useAudioQueue();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [viewMode, setViewMode] = useState("grid");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [covers, setCovers] = useState({});
  const [pendingFavorite, setPendingFavorite] = useState(null);
  const favoriteMutationInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pageIndex, setPageIndex] = useState(1);
  const refreshAttemptRef = useRef(0);
  const [playlistSavingKey, setPlaylistSavingKey] = useState("");
  const [trackDownloadStates, setTrackDownloadStates] = useState({});
  const [libraryRemoval, setLibraryRemoval] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deletingLibraryEntity, setDeletingLibraryEntity] = useState(false);
  const [homeAlbumsGridRef, homeAlbumColumns] = useResponsiveReleaseLimit({
    cardMinWidth: 152,
  });

  const handleLibraryScanMessage = useCallback((message) => {
    if (message?.type !== "library_scan_completed") return;
    clearCanonicalLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryCanonicalPrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
  }, []);

  useWebSocketChannel("library", handleLibraryScanMessage);

  const pageSize = 100;

  useEffect(() => () => {
    refreshAttemptRef.current += 1;
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (refreshing) return;
    const attempt = refreshAttemptRef.current + 1;
    refreshAttemptRef.current = attempt;
    setRefreshing(true);
    try {
      clearCanonicalLibraryPageCache();
      const queued = await requestLibraryRefresh();
      const jobId = queued?.jobId;
      if (!jobId) throw new Error("Library refresh did not start");

      const deadline = Date.now() + LIBRARY_REFRESH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = await getLibraryRefreshStatus(jobId);
        if (refreshAttemptRef.current !== attempt) return;
        if (status.status === "completed") {
          clearCanonicalLibraryPageCache();
          queryClient.invalidateQueries({
            queryKey: queryKeys.libraryAlbumTracksPrefix,
            refetchType: "none",
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.libraryCanonicalPrefix });
          void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
          showSuccess("Library refreshed");
          return;
        }
        if (status.status === "failed") {
          throw new Error(status.error || "Library refresh failed");
        }
        await wait(750);
      }
      throw new Error("Library refresh timed out");
    } catch (requestError) {
      if (refreshAttemptRef.current === attempt) {
        showError(requestError.response?.data?.message || requestError.message || "Library refresh failed");
      }
    } finally {
      if (refreshAttemptRef.current === attempt) setRefreshing(false);
    }
  }, [refreshing, showError, showSuccess]);

  const section = LIBRARY_VIEW_IDS.has(routeSection) ? routeSection : DEFAULT_LIBRARY_VIEW;
  const isDetail = Boolean(routeAlbumId || routeArtistId);
  const tab = section === "home" || section === "album-artists" ? "artists" : section;
  const selectedGenre = searchParams.get("genre") || "";
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";
  const sectionLabel = LIBRARY_VIEWS.find((view) => view.id === section)?.label || "Library";
  const librarySource = useMemo(() => ({ type: "native-library", id: "library" }), []);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    setQuery("");
    setSortMode("name");
    setSortDirection("asc");
    setViewMode(section === "tracks" || section === "genres" ? "list" : "grid");
    setSearchOpen(false);
    setFiltersOpen(false);
    setPageIndex(1);
  }, [section]);

  const libraryQueryKey = useMemo(
    () => queryKeys.libraryView({
      preview: forcePreview,
      section,
      tab,
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
      tab,
    ],
  );
  const libraryQuery = useQuery({
    queryKey: libraryQueryKey,
    enabled: !forcePreview,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const nextData = isDetail
        ? routeAlbumId
          ? await getCanonicalLibraryPage({
              kind: "tracks",
              albumId: routeAlbumId,
              page: 1,
              pageSize,
            }, { signal })
          : await Promise.all([
              getCanonicalLibraryPage({
                kind: "albums",
                artistId: routeArtistId,
                page: 1,
                pageSize,
              }, { signal }),
              getCanonicalLibraryPage({
                kind: "tracks",
                artistId: routeArtistId,
                page: 1,
                pageSize,
                availableOnly: true,
              }, { signal }),
            ])
        : section === "favorites"
          ? await getLibraryFavorites({ signal })
          : section === "home"
            ? await Promise.all([
                getCanonicalLibraryPage({
                  kind: "albums",
                  page: 1,
                  pageSize,
                  sort: "newest",
                }, { signal }),
                getCanonicalLibraryPage({
                  kind: "tracks",
                  page: 1,
                  pageSize: 12,
                  sort: "newest",
                  availableOnly: true,
                }, { signal }),
              ])
            : await getCanonicalLibraryPage({
                kind: tab,
                page: pageIndex,
                pageSize,
                query: normalizedQuery,
                genre: selectedGenre,
                sort: sortMode,
                direction: sortDirection,
                availableOnly: tab === "tracks",
              }, { signal });
      const pageResults = section === "favorites"
        ? [nextData?.library || EMPTY_LIBRARY]
        : Array.isArray(nextData) ? nextData : [nextData];
      const normalizedLibrary = normalizeLibraryPages(pageResults);
      const usePreview =
        import.meta.env.DEV &&
        pageResults.every((page) => Number(page?.total || 0) === 0) &&
        !normalizedQuery &&
        !selectedGenre &&
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
          : section === "favorites"
            ? favoriteIdsFromFavorites(nextData)
            : favoriteIdsFromPages(pageResults),
      };
    },
  });

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
        const page = await getCanonicalLibraryPage({
          kind: "tracks",
          albumId: album.id,
          page: 1,
          pageSize,
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
        sharedPlaylists,
        `${getArtistForAlbum(getAlbumForTrack(track))?.name || track?.artistName || "Artist"} Picks`,
      ),
    [getAlbumForTrack, getArtistForAlbum, sharedPlaylists],
  );

  const addLibraryTrackToPlaylist = useCallback(
    async (track, target) => {
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const payload = buildSharedPlaylistTrackPayload({
        artistName: artist?.name || track?.artistName || "",
        trackName: track?.title || "",
        albumName: album?.title || "",
        artistMbid: artist?.mbid || "",
        albumMbid: album?.mbid || album?.releaseGroupMbid || "",
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
          await createSharedPlaylist({ name, tracks: [payload] });
          showSuccess(`Track saved to ${name}`);
        } else {
          const playlist = sharedPlaylists.find(
            (candidate) => candidate.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target?.playlistId, { tracks: [payload] });
          showSuccess(`Track added to ${playlist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) setSharedPlaylists(nextPlaylists);
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
      loadSharedPlaylists,
      setPlaylistsError,
      setSharedPlaylists,
      sharedPlaylists,
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
        await deleteSharedPlaylistTrack(target.playlistId, target.jobId);
        showSuccess(`Removed ${track?.title || "track"} from playlist`);
        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) setSharedPlaylists(nextPlaylists);
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
    [loadSharedPlaylists, setPlaylistsError, setSharedPlaylists, showError, showSuccess],
  );

  const canDeleteArtist = hasPermission("deleteArtist");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const canDeleteTrack = hasPermission("deleteTrack") || canDeleteAlbum;
  const canChangeMonitoring = hasPermission("changeMonitoring");

  const openLibraryRemoval = useCallback((kind, entity) => {
    setDeleteFiles(false);
    setLibraryRemoval({ kind, entity });
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
    clearCanonicalLibraryPageCache();
    queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracksPrefix,
      refetchType: "none",
    });
  }, [setLibrary]);

  const handleLibraryRemovalConfirm = useCallback(async () => {
    if (!libraryRemoval?.entity || deletingLibraryEntity) return;
    const removal = libraryRemoval;
    const entity = removal.entity;
    setDeletingLibraryEntity(true);
    try {
      if (!isPreviewLibrary) {
        if (removal.kind === "artist") {
          await deleteArtistFromLibrary(entity.mbid, deleteFiles);
        } else if (removal.kind === "album") {
          await deleteAlbumFromLibrary(entity.providerId || entity.id, deleteFiles);
        } else {
          await deleteTrackFromLibrary(entity.id);
        }
      }
      removeLocalLibraryEntity(removal);
      setLibraryRemoval(null);
      showSuccess(
        removal.kind === "artist"
          ? "Artist removed from library"
          : removal.kind === "album"
            ? "Album removed from library"
            : "Track deleted",
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

  const updateArtistMonitoring = useCallback(
    async (artist, monitorOption) => {
      if (!artist?.mbid || !canChangeMonitoring) return;
      try {
        if (!isPreviewLibrary) {
          await updateLibraryArtist(artist.mbid, {
            monitored: true,
            monitorOption,
            addOptions: { ...(artist.addOptions || {}), monitor: monitorOption },
          });
        }
        setLibrary((current) => ({
          ...current,
          artists: current.artists.map((entry) =>
            String(entry.id) === String(artist.id)
              ? { ...entry, monitored: true, monitorOption }
              : entry,
          ),
        }));
        showSuccess(`Artist monitoring set to ${monitorOption}`);
      } catch (requestError) {
        showError(
          requestError.response?.data?.message ||
            requestError.response?.data?.error ||
            requestError.message ||
            "Failed to update artist monitoring",
        );
      }
    },
    [canChangeMonitoring, isPreviewLibrary, setLibrary, showError, showSuccess],
  );

  const artistMonitorItems = (artist) => {
    const currentOption = artist?.monitorOption || artist?.addOptions?.monitor || "none";
    return [
      ["none", "None (artist only)"],
      ["existing", "Existing albums"],
      ["all", "All albums"],
      ["future", "Future albums"],
      ["missing", "Missing albums"],
      ["latest", "Latest album"],
      ["first", "First album"],
    ].map(([value, label]) => ({
      id: value,
      label,
      selected: currentOption === value,
      onSelect: () => updateArtistMonitoring(artist, value),
    }));
  };

  const downloadMissingTrack = useCallback(
    async (track) => {
      if (!track || firstAvailableFile(track) || isPreviewLibrary) return;
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const payload = {
        artistName: artist?.name || track?.artistName || "",
        trackName: track?.title || track?.trackName || "",
        albumName: album?.title || track?.albumName || "",
        artistMbid: artist?.mbid || track?.artistMbid || "",
        albumMbid: album?.mbid || album?.releaseGroupMbid || track?.albumMbid || "",
        trackMbid: track?.mbid || track?.trackMbid || "",
        releaseYear: yearOf(album?.releaseDate),
        durationMs: trackDurationMs(track),
      };
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return;
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
      } catch (requestError) {
        setTrackDownloadStates(({ [key]: _, ...rest }) => rest);
        showError(
          requestError.response?.data?.message ||
            requestError.response?.data?.error ||
            requestError.message ||
            "Failed to add track to library",
        );
      }
    },
    [getAlbumForTrack, getArtistForAlbum, isPreviewLibrary, showError, showSuccess],
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

  const sortedArtists = useMemo(() => {
    const items = [...filteredArtists];
    items.sort((left, right) => text(left.name).localeCompare(text(right.name)));
    return sortDirection === "asc" ? items : items.reverse();
  }, [filteredArtists, sortDirection]);

  const sortedAlbums = useMemo(() => {
    const items = [...filteredAlbums];
    items.sort((left, right) => {
      if (sortMode === "newest") {
        return text(right.releaseDate).localeCompare(text(left.releaseDate));
      }
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
    () =>
      [...library.albums]
        .sort((left, right) => text(right.releaseDate).localeCompare(text(left.releaseDate)))
        .slice(0, Math.max(2, homeAlbumColumns) * 2),
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
        mbid: album.mbid || album.releaseGroupMbid,
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
    (album) => album?.coverUrl || covers[album?.mbid || album?.releaseGroupMbid] || "",
    [covers],
  );

  const buildPlayableTrack = useCallback(
    (track) => {
      const album = getAlbumForTrack(track);
      const artist = getArtistForAlbum(album);
      const file = firstAvailableFile(track, album?.id);
      return {
        id: track.id,
        title: track.title,
        artist: artist?.name || track.artistName || "Unknown Artist",
        album: album?.title || "Unknown Album",
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
        albumMbid: album?.mbid || album?.releaseGroupMbid || null,
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
      const startIndex = startTrack
        ? Math.max(
            0,
            playable.findIndex((track) => String(track.id) === String(startTrack.id)),
          )
        : 0;
      playQueue(playable, {
        startIndex: startIndex < 0 ? 0 : startIndex,
        shuffle,
        source: librarySource,
        updateShufflePreference: false,
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

  const handleArtistOpen = (artist) => {
    if (!artist?.id) return;
    navigate("/library/artist/" + encodeURIComponent(artist.id) + previewQuery);
  };

  const handleDiscoverArtistOpen = (artist) => {
    if (!artist?.mbid) return;
    navigate("/artist/" + encodeURIComponent(artist.mbid), {
      state: { artistName: artist.name, inLibrary: true, libraryArtist: artist },
    });
  };

  const handleAlbumOpen = (album) => {
    if (!album?.id) return;
    navigate("/library/album/" + encodeURIComponent(album.id) + previewQuery);
  };

  const handleDiscoverAlbumOpen = (album) => {
    const artist = getArtistForAlbum(album);
    if (artist?.mbid && (album?.releaseGroupMbid || album?.mbid)) {
      navigateToLibraryAlbum(navigate, album, {
        artistMbid: artist.mbid,
        artistName: artist.name,
        coverUrl: getAlbumCover(album),
      });
    }
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
  const sortOptions =
    section === "albums"
      ? [
          { value: "name", label: "Name" },
          { value: "artist", label: "Artist" },
          { value: "newest", label: "Newest" },
        ]
      : section === "tracks"
        ? [
            { value: "name", label: "Name" },
            { value: "artist", label: "Artist" },
          ]
        : section === "artists" || section === "album-artists"
          ? [{ value: "name", label: "Name" }]
          : section === "genres"
            ? [{ value: "name", label: "Name" }]
            : [];

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

  const updateGenreFilter = (genre) => {
    setPageIndex(1);
    const next = new URLSearchParams(searchParams);
    if (genre) next.set("genre", genre);
    else next.delete("genre");
    setSearchParams(next);
  };

  const renderTrackList = (tracks, label) => (
    <div className="native-library-track-list">
      <div
        className="native-library-track native-library-track--heading"
        aria-hidden="true"
      >
        <span />
        <span className="native-library-track__number">#</span>
        <span />
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span className="native-library-track__time">Time</span>
        <span />
        <span />
      </div>
      <div role="list" aria-label={label}>
        {tracks.map((track, index) => {
          const album = getAlbumForTrack(track);
          const artist = getArtistForAlbum(album);
          const file = firstAvailableFile(track);
          const downloadKey = trackDownloadIdentity(track);
          const downloadState = trackDownloadStates[downloadKey];
          const downloadPending = TRACK_DOWNLOAD_ACTIVE_STATUSES.has(downloadState?.status);
          const downloadLabel = trackDownloadActionLabel(downloadState?.status);
          const active =
            String(currentTrack?.id) === String(track.id) &&
            matchesSource(librarySource);
          const artistName = artist?.name || track.artistName || "Unknown Artist";
          const albumName = album?.title || "Unknown Album";
          const isFavorite = favoriteIds.has(favoriteId("song", track));
          const trackMenuItems = [
            {
              id: "play",
              label: active && isPlaying ? "Pause" : "Play",
              icon: active && isPlaying ? Pause : Play,
              onSelect: () => playTrack(track, tracks),
              disabled: !file || (active && isLoading),
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
                    onSelect: () => downloadMissingTrack(track),
                    disabled: isPreviewLibrary || downloadPending,
                  },
                ]
              : []),
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
            ...(file && canDeleteTrack
              ? [
                  {
                    id: "delete",
                    label: "Delete track file",
                    icon: Trash2,
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => openLibraryRemoval("track", track),
                  },
                ]
              : []),
          ];
          return (
            <div
              className={
                "native-library-track" +
                (active ? " is-active" : "") +
                (file ? "" : " is-missing")
              }
              data-library-menu-target
              key={track.id}
              role="listitem"
            >
            {file ? (
              <TooltipButton
                className="native-library-track__play"
                onClick={() => playTrack(track, tracks)}
                disabled={active && isLoading}
                label={(active && isPlaying ? "Pause " : "Play ") + track.title}
                aria-label={(active && isPlaying ? "Pause " : "Play ") + track.title}
              >
                {active && isPlaying ? (
                  <span aria-hidden="true">Ⅱ</span>
                ) : (
                  <Play aria-hidden="true" fill="currentColor" />
                )}
              </TooltipButton>
            ) : (
              <span aria-hidden="true" />
            )}
            <span className="native-library-track__number" aria-hidden="true">
              {index + 1}
            </span>
            {album ? (
              <button
                type="button"
                className="native-library-track__cover"
                onClick={() => handleAlbumOpen(album)}
                aria-label={"Open " + albumName}
              >
                <Cover src={getAlbumCover(album)} label={albumName} compact />
              </button>
            ) : (
              <span className="native-library-track__cover">
                <Cover label={albumName} compact />
              </span>
            )}
            <button
              type="button"
              className="native-library-track__title"
              onClick={() => playTrack(track, tracks)}
              title={track.title || "Unknown Track"}
            >
              <span>{track.title || "Unknown Track"}</span>
              <small>{artistName}</small>
            </button>
            {artist ? (
              <button
                type="button"
                className="native-library-track__link native-library-track__artist"
                onClick={() => handleArtistOpen(artist)}
              >
                {artistName}
              </button>
            ) : (
              <span className="native-library-track__link native-library-track__artist">{artistName}</span>
            )}
            {album ? (
              <button
                type="button"
                className="native-library-track__link native-library-track__album"
                onClick={() => handleAlbumOpen(album)}
              >
                {albumName}
              </button>
            ) : (
              <span className="native-library-track__link native-library-track__album">{albumName}</span>
            )}
            <span className={"native-library-track__time" + (!file ? " is-missing" : "")}>
              {formatDuration(trackDurationMs(track)) || "Unavailable"}
            </span>
            {!file ? (
              <TooltipButton
                className="native-library-track__download"
                onClick={() => downloadMissingTrack(track)}
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
            ) : (
              <span />
            )}
            <LibraryItemMenu
              label={track.title || "Track"}
              items={trackMenuItems}
              additionalItemsAfter="play"
              onMenuOpen={loadSharedPlaylists}
              renderAdditionalItems={({ closeMenu }) => (
                <>
                  <div className="native-library-item-menu__separator" />
                  <TrackPlaylistSubmenu
                    label="Add to playlist"
                    track={track}
                    playlists={sharedPlaylists}
                    loading={playlistsLoading}
                    saving={playlistSavingKey === String(track.id)}
                    error={playlistsError}
                    defaultNewPlaylistName={getDefaultTrackPlaylistName(track)}
                    onSelect={(target) => addLibraryTrackToPlaylist(track, target)}
                    onClose={closeMenu}
                  />
                  <TrackPlaylistRemoveSubmenu
                    track={track}
                    playlists={sharedPlaylists}
                    saving={playlistSavingKey === String(track.id)}
                    error={playlistsError}
                    onSelect={(target) => removeLibraryTrackFromPlaylist(track, target)}
                    onClose={closeMenu}
                    toggleOnClick
                  />
                </>
              )}
            />
            <FavoriteButton
              className="native-library-track__favorite"
              active={favoriteIds.has(favoriteId("song", track))}
              pending={Boolean(pendingFavorite)}
              label={track.title || "track"}
              onClick={() => toggleFavorite("song", track)}
            />
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderArtistCard = (artist) => {
    const isFavorite = favoriteIds.has(favoriteId("artist", artist));
    return (
      <article
        className="native-library-card native-library-card--artist"
        data-library-menu-target
        key={artist.id}
      >
        <div className="native-library-card__cover-wrap">
          <button
            type="button"
            className="native-library-card__cover native-library-card__cover--round"
            onClick={() => handleArtistOpen(artist)}
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
          </button>
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
                id: "favorite",
                label: isFavorite ? "Remove from favorites" : "Add to favorites",
                icon: Heart,
                selected: isFavorite,
                separatorBefore: true,
                onSelect: () => toggleFavorite("artist", artist),
              },
              ...(canDeleteArtist && artist.mbid
                ? [
                    {
                      id: "delete",
                      label: "Remove from library",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval("artist", artist),
                    },
                  ]
                : []),
              {
                id: "discover",
                label: "Explore in Discover",
                icon: ExternalLink,
                separatorBefore: true,
                onSelect: () => handleDiscoverArtistOpen(artist),
                disabled: !artist.mbid,
              },
            ]}
            additionalItemsAfter="favorite"
            renderAdditionalItems={({ closeMenu }) =>
              canChangeMonitoring && artist.mbid ? (
                <>
                  <div className="native-library-item-menu__separator" />
                  <LibraryItemSubmenu
                    label="Monitoring"
                    icon={Radio}
                    items={artistMonitorItems(artist)}
                    onClose={closeMenu}
                  />
                </>
              ) : null
            }
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <button
              type="button"
              className="native-library-card__title"
              onClick={() => handleArtistOpen(artist)}
              title={artist.name}
            >
              {artist.name || "Unknown Artist"}
            </button>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(pendingFavorite)}
              label={artist.name || "artist"}
              onClick={() => toggleFavorite("artist", artist)}
            />
          </div>
          <span className="native-library-card__meta">
            {artist.albumIds?.length || 0} album{artist.albumIds?.length === 1 ? "" : "s"}
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
    return (
      <article className="native-library-card" data-library-menu-target key={album.id}>
        <div className="native-library-card__cover-wrap">
          <button
            type="button"
            className="native-library-card__cover"
            onClick={() => handleAlbumOpen(album)}
            aria-label={"Open " + (album.title || "album")}
          >
            <Cover src={getAlbumCover(album)} label={album.title} />
          </button>
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
              ...(canDeleteAlbum && album.providerId
                ? [
                    {
                      id: "delete",
                      label: "Remove from library",
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => openLibraryRemoval("album", album),
                    },
                  ]
                : []),
              {
                id: "discover",
                label: "Explore in Discover",
                icon: ExternalLink,
                separatorBefore: true,
                onSelect: () => handleDiscoverAlbumOpen(album),
                disabled: !artist?.mbid || !(album.releaseGroupMbid || album.mbid),
              },
            ]}
          />
        </div>
        <div className="native-library-card__body">
          <div className="native-library-card__title-row">
            <button
              type="button"
              className="native-library-card__title"
              onClick={() => handleAlbumOpen(album)}
              title={album.title}
            >
              {album.title || "Unknown Album"}
            </button>
            <FavoriteButton
              active={isFavorite}
              pending={Boolean(pendingFavorite)}
              label={album.title || "album"}
              onClick={() => toggleFavorite("album", album)}
            />
          </div>
          {artist ? (
            <button
              type="button"
              className="native-library-card__artist"
              onClick={() => handleArtistOpen(artist)}
            >
              {artist.name}
            </button>
          ) : (
            <span className="native-library-card__artist">
              {artist?.name || album.albumArtist || "Unknown Artist"}
            </span>
          )}
          <span className="native-library-card__meta">{meta}</span>
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
        <button type="button" onClick={() => navigate(path)}>
          {actionLabel}
        </button>
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
            <button
              type="button"
              className="native-library-genre-row"
              onClick={() =>
                navigate("/library/albums?genre=" + encodeURIComponent(genre.name))
              }
            >
              <strong>{genre.name}</strong>
              <span>{genre.artists}</span>
              <span>{genre.albums}</span>
              <span>{genre.tracks}</span>
            </button>
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
    const durationMs = albumTracks.reduce(
      (total, track) => total + Number(firstAvailableFile(track)?.durationMs || 0),
      0,
    );
    return (
      <section className="native-library-detail">
        <div className="native-library-detail__hero" data-library-menu-target>
          <div className="native-library-detail__cover">
            <Cover src={getAlbumCover(libraryAlbum)} label={libraryAlbum.title} />
          </div>
          <div className="native-library-detail__body">
            <p className="native-library-kicker">Album</p>
            <h2>{libraryAlbum.title || "Unknown Album"}</h2>
            {artist ? (
              <button
                type="button"
                className="native-library-detail__artist"
                onClick={() => handleArtistOpen(artist)}
              >
                {artist.name}
              </button>
            ) : (
              <p>{libraryAlbum.albumArtist || "Unknown Artist"}</p>
            )}
            <p className="native-library-detail__meta">
              {[yearOf(libraryAlbum.releaseDate), availability.total + " tracks", formatLongDuration(durationMs)]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="native-library-detail__actions">
              <button
                type="button"
                className="native-library-page-play"
                onClick={() => playTracks(albumTracks)}
                disabled={!albumTracks.some((track) => firstAvailableFile(track))}
              >
                <Play aria-hidden="true" fill="currentColor" /> Play
              </button>
              <FavoriteButton
                active={favoriteIds.has(favoriteId("album", libraryAlbum))}
                pending={Boolean(pendingFavorite)}
                label={libraryAlbum.title || "album"}
                onClick={() => toggleFavorite("album", libraryAlbum)}
              />
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
                    id: "favorite",
                    label: favoriteIds.has(favoriteId("album", libraryAlbum))
                      ? "Remove from favorites"
                      : "Add to favorites",
                    icon: Heart,
                    selected: favoriteIds.has(favoriteId("album", libraryAlbum)),
                    separatorBefore: true,
                    onSelect: () => toggleFavorite("album", libraryAlbum),
                  },
                  ...(canDeleteAlbum && libraryAlbum.providerId
                    ? [
                        {
                          id: "delete",
                          label: "Remove from library",
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          onSelect: () => openLibraryRemoval("album", libraryAlbum),
                        },
                      ]
                    : []),
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
                    label: "Explore in Discover",
                    icon: ExternalLink,
                    separatorBefore: true,
                    onSelect: () => handleDiscoverAlbumOpen(libraryAlbum),
                    disabled: !artist?.mbid || !(libraryAlbum.releaseGroupMbid || libraryAlbum.mbid),
                  },
                ]}
              />
              {artist?.mbid && (libraryAlbum.releaseGroupMbid || libraryAlbum.mbid) && (
                <button
                  type="button"
                  className="native-library-detail__discover"
                  onClick={() => handleDiscoverAlbumOpen(libraryAlbum)}
                >
                  <ExternalLink aria-hidden="true" /> Explore in Discover
                </button>
              )}
            </div>
          </div>
        </div>
        <section className="native-library-detail__section">
          <div className="native-library-detail__section-heading">
            <h3>Tracks</h3>
            <span>{availability.total}</span>
          </div>
          {renderTrackList(albumTracks, libraryAlbum.title + " tracks")}
        </section>
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
    return (
      <section className="native-library-detail">
        <div
          className="native-library-detail__hero native-library-detail__hero--artist"
          data-library-menu-target
        >
          <div className="native-library-detail__cover">
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
              {artistAlbums.length} album{artistAlbums.length === 1 ? "" : "s"}
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
                    id: "favorite",
                    label: favoriteIds.has(favoriteId("artist", libraryArtist))
                      ? "Remove from favorites"
                      : "Add to favorites",
                    icon: Heart,
                    selected: favoriteIds.has(favoriteId("artist", libraryArtist)),
                    separatorBefore: true,
                    onSelect: () => toggleFavorite("artist", libraryArtist),
                  },
                  ...(canDeleteArtist && libraryArtist.mbid
                    ? [
                        {
                          id: "delete",
                          label: "Remove from library",
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          onSelect: () => openLibraryRemoval("artist", libraryArtist),
                        },
                      ]
                    : []),
                  {
                    id: "discover",
                    label: "Explore in Discover",
                    icon: ExternalLink,
                    separatorBefore: true,
                    onSelect: () => handleDiscoverArtistOpen(libraryArtist),
                    disabled: !libraryArtist.mbid,
                  },
                ]}
                additionalItemsAfter="favorite"
                renderAdditionalItems={({ closeMenu }) =>
                  canChangeMonitoring && libraryArtist.mbid ? (
                    <>
                      <div className="native-library-item-menu__separator" />
                      <LibraryItemSubmenu
                        label="Monitoring"
                        icon={Radio}
                        items={artistMonitorItems(libraryArtist)}
                        onClose={closeMenu}
                      />
                    </>
                  ) : null
                }
              />
              {libraryArtist.mbid && (
                <button
                  type="button"
                  className="native-library-detail__discover"
                  onClick={() => handleDiscoverArtistOpen(libraryArtist)}
                >
                  <ExternalLink aria-hidden="true" /> Explore in Discover
                </button>
              )}
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
      <DeleteAlbumModal
        show={libraryRemoval?.kind === "album"}
        title={libraryRemoval?.entity?.title || libraryRemoval?.entity?.albumName}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        removing={deletingLibraryEntity}
      />
      <DeleteTrackModal
        show={libraryRemoval?.kind === "track"}
        title={libraryRemoval?.entity?.title || libraryRemoval?.entity?.trackName}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        deleting={deletingLibraryEntity}
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
        <div className="native-library-state" role="status">
          <DotLoader size="xl" label={null} />
          <span>Loading library…</span>
        </div>
      )}
      {!loading && error && (
        <div className="native-library-state" role="alert">
          <strong>Library unavailable</strong>
          <span>{error}</span>
          <button
            type="button"
            className="native-library-state__action"
            onClick={refreshLibrary}
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
      <main className="library-page native-library-page">
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
  const totalPages =
    pageData?.kind === tab && tab !== "genres"
      ? Math.ceil(pageData.total / pageData.pageSize)
      : 0;
  const pageCount =
    section === "home"
      ? pageData?.total ?? library.albums.length + ownedLibraryTracks.length
      : activeCount;
  const showToolbar = section !== "home";
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
              <button
                type="button"
                className="btn btn-surface btn-sm"
                onClick={() =>
                  navigateToDiscover(
                    "/search?q=" +
                      encodeURIComponent("#" + selectedGenre) +
                      "&type=tag",
                  )
                }
              >
                <ExternalLink aria-hidden="true" />
                Explore in Discover
              </button>
            )}
            {showToolbar ? (
              <TooltipButton
                className={`native-library-icon-button${searchOpen ? " is-active" : ""}`}
                onClick={() => setSearchOpen((value) => !value)}
                label={searchOpen ? "Close search" : "Search"}
                aria-label={searchOpen ? "Close search" : "Search " + sectionLabel.toLocaleLowerCase()}
                aria-pressed={searchOpen}
              >
                <Search aria-hidden="true" />
              </TooltipButton>
            ) : (
              <TooltipButton
                className="native-library-icon-button"
                onClick={refreshLibrary}
                disabled={refreshing}
                label={refreshing ? "Refreshing library…" : "Refresh"}
                aria-label="Refresh library"
              >
                {refreshing ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
              </TooltipButton>
            )}
          </div>
        </div>
        {showToolbar && (
          <>
            <div className="native-library-toolbar">
              {searchOpen && (
                <label className="native-library-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setPageIndex(1);
                      setQuery(event.target.value);
                    }}
                    placeholder={"Search " + sectionLabel.toLocaleLowerCase()}
                    aria-label={"Search " + sectionLabel.toLocaleLowerCase()}
                    autoFocus
                  />
                  {query && (
                    <TooltipButton
                      onClick={() => {
                        setPageIndex(1);
                        setQuery("");
                      }}
                      label="Clear search"
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
                      onChange={(event) => {
                        setPageIndex(1);
                        setSortMode(event.target.value);
                      }}
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
                    onClick={() => {
                      setPageIndex(1);
                      setSortDirection((value) => (value === "asc" ? "desc" : "asc"));
                    }}
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
              <TooltipButton
                className="native-library-icon-button"
                onClick={refreshLibrary}
                disabled={refreshing}
                label={refreshing ? "Refreshing library…" : "Refresh"}
                aria-label="Refresh library"
              >
                {refreshing ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
              </TooltipButton>
              <span className="native-library-toolbar-spacer" aria-hidden="true" />
              {(tab === "artists" || tab === "albums") && (
                <div className="native-library-view-toggle" aria-label="Library view">
                  <TooltipButton
                    className={`native-library-icon-button${viewMode === "grid" ? " is-active" : ""}`}
                    onClick={() => setViewMode("grid")}
                    label="Grid view"
                    aria-label="Grid view"
                    aria-pressed={viewMode === "grid"}
                  >
                    <Grid3X3 aria-hidden="true" />
                  </TooltipButton>
                  <TooltipButton
                    className={`native-library-icon-button${viewMode === "list" ? " is-active" : ""}`}
                    onClick={() => setViewMode("list")}
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
        <div className="native-library-content">{content}</div>
      )}
      {!loading && !error && totalPages > 1 && (
        <nav className="native-library-pagination" aria-label={sectionLabel + " pages"}>
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => setPageIndex((value) => Math.max(1, value - 1))}
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
            onClick={() => setPageIndex((value) => Math.min(totalPages, value + 1))}
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
