import { useCallback, useMemo, useRef, useState } from "react";
import { parseResponse } from "hono/client";
import {
  Download,
  EyeOff,
  ImagePlus,
  Info,
  ListEnd,
  ListStart,
  Pause,
  Play,
  RefreshCw,
  Share,
  Shuffle,
  Trash2,
} from "../../components/icons";
import { useAurralTrackMonitoring } from "../../components/AurralTrackMonitoring";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import type { TrackListRow } from "../../components/TrackList";
import ArtworkEditorModal from "../../components/ArtworkEditorModal.tsx";
import { useAuth } from "../../contexts/AuthContext";
import { useAudioQueue } from "../../contexts/audioQueueContext";
import { useToast } from "../../contexts/ToastContext";
import { useLibraryShareAction } from "../../hooks/useShareAction";
import { useStaticPlaylists } from "../../hooks/useStaticPlaylists";
import { useLibraryDestination } from "../../hooks/useLibraryDestination";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import { useQueueTrackActions } from "../../hooks/useQueueTrackActions";
import {
  useHiddenPlaylistTracks,
  usePlaylistBulkActions,
} from "../playlists/usePlaylistBulkActions.ts";
import { libraryAlbumsClient } from "../../utils/api/clients/libraryAlbums.ts";
import { libraryArtistsClient } from "../../utils/api/clients/libraryArtists.ts";
import { libraryArtworkClient } from "../../utils/api/clients/libraryArtwork.ts";
import { libraryTracksClient } from "../../utils/api/clients/libraryTracks.ts";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import {
  clearLibraryPageCache,
  getLibraryCustomArtworkUrl,
  getLibraryPage,
  downloadTrackToLibrary,
  reSearchLibraryTrack,
  updateLibraryFavorites,
  type AurralMonitoringResult,
  type CustomArtworkResult,
} from "../../utils/api/endpoints/library.ts";
import { buildAuthenticatedApiUrl } from "../../utils/api/core.ts";
import {
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
  EMPTY_LIBRARY,
  favoriteId,
  firstAvailableFile,
  getCachedAlbumTracks,
  mergeAlbumTrackPageIntoLibrary,
  yearOf,
} from "../../utils/libraryPageData.ts";
import type { LibraryMenuItem } from "../../components/LibraryItemMenu";
import { canRemoveLibraryAlbum, resolveAlbumManager } from "../../utils/libraryDestination.ts";
import { isAwaitingRelease } from "../../utils/aurralAlbumStatus.ts";
import { getAlbumMonitoredState } from "../../utils/aurralMonitoring.ts";
import { libraryPreviewData, libraryPreviewFavorites } from "../libraryPreviewData";
import {
  LIBRARY_PAGE_SIZE,
  type libraryViewQueryOptions,
  type LibraryViewLibrary,
} from "../libraryViewQuery.ts";
import {
  TrackPlaylistRemoveSubmenu,
  TrackPlaylistSubmenu,
  type PlaylistSelection as PlaylistTarget,
} from "../ArtistDetails/components/TrackPlaylistMenu";
import { DeleteAlbumModal } from "../ArtistDetails/components/DeleteAlbumModal";
import { DeleteArtistModal } from "../ArtistDetails/components/DeleteArtistModal";
import { DeleteTrackModal } from "../ArtistDetails/components/DeleteTrackModal";
import LibraryInfoModal from "../LibraryInfoModal";
import {
  buildStaticPlaylistTrackPayload,
  getApiErrorMessage,
  getApiErrorText,
  reserveUniquePlaylistName,
} from "../ArtistDetails/utils";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { showFavoriteRemoved } from "../../utils/favoriteUndo.ts";
import { libraryAlbumPath as albumLink } from "../../../../lib/albumPath.ts";
import {
  type LibraryPageTrack,
  type LibraryRemoval,
  type LibraryTarget,
  type TrackDownloadState,
  formatDuration,
  invalidateLibraryViews,
  isAlbumArtistCredit,
  TRACK_DOWNLOAD_ACTIVE_STATUSES,
  trackDownloadActionLabel,
  trackDownloadIdentity,
  trackDurationMs,
} from "./libraryShared.tsx";

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

type LibraryLookup = {
  albumsById: Map<string, LibraryAlbum>;
  artistsById: Map<string, LibraryArtist>;
};

type LibraryCollection = { tracks: LibraryPageTrack[]; lookup: LibraryLookup | null };

type LibraryPageResult = Awaited<ReturnType<typeof getLibraryPage>>;

type PlaylistRemoveTarget = { playlistId?: string; jobId?: string };

type SaveTracksOptions = {
  key: string;
  label: string;
  defaultName: string;
  lookup?: LibraryLookup | null;
};

const trackArtistMbid = (track: LibraryTrack, artist: LibraryArtist | null | undefined) =>
  isAlbumArtistCredit(track, artist) ? artist?.mbid || null : null;

const hasAurralTrackFile = (track: LibraryTrack) =>
  (track?.files || []).some((file) => file.source === "aurral");

const hasDeletableTrackFile = (track: LibraryTrack) =>
  (track?.files || []).some((file) => file.available && file.source !== "readonly");

const firstAvailableAurralFile = (track: LibraryTrack) =>
  (track?.files || []).find((file) => file.source === "aurral" && file.available) || null;

type LibraryData = LibraryViewLibrary;

type LibraryViewQueryKey = ReturnType<typeof libraryViewQueryOptions>["queryKey"];

const pageSize = LIBRARY_PAGE_SIZE;

type PlaylistTrackPayload = ReturnType<typeof buildStaticPlaylistTrackPayload>;

export const LIBRARY_SOURCE = { type: "native-library", id: "library", label: "Library" };

export function useLibraryActions({
  libraryQueryKey,
  library,
  favoriteIds,
  isPreviewLibrary,
  forcePreview = false,
  onRemoved,
}: {
  libraryQueryKey: LibraryViewQueryKey;
  library: LibraryData;
  favoriteIds: Set<string>;
  isPreviewLibrary: boolean;
  forcePreview?: boolean;
  onRemoved?: (removal: LibraryRemoval) => void;
}) {
  const previewQuery = forcePreview ? "?preview=1" : "";
  const { hasPermission, user } = useAuth();
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

  const [pendingFavorite, setPendingFavorite] = useState<string | null>(null);
  const favoriteMutationInFlightRef = useRef(false);

  const [playlistSavingKey, setPlaylistSavingKey] = useState("");
  const [trackDownloadStates, setTrackDownloadStates] = useState<
    Record<string, TrackDownloadState>
  >({});
  const [trackResearchStates, setTrackResearchStates] = useState<Record<string, boolean>>({});
  const [libraryRemoval, setLibraryRemoval] = useState<LibraryRemoval | null>(null);
  const [libraryInfo, setLibraryInfo] = useState<LibraryInfoState | null>(null);
  const [artworkEditor, setArtworkEditor] = useState<ArtworkEditorState | null>(null);

  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deletingLibraryEntity, setDeletingLibraryEntity] = useState(false);

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

  const savePlaylistTracks = useCallback(
    async (
      payloads: PlaylistTrackPayload[],
      target: PlaylistTarget,
      { key, label, defaultName }: Omit<SaveTracksOptions, "lookup">,
    ) => {
      setPlaylistSavingKey(key);
      setPlaylistsError("");
      try {
        if (target?.mode === "new") {
          const name = String(target?.name || "").trim() || defaultName;
          await parseResponse(
            staticPlaylistsClient["shared-playlists"].$post({ json: { name, tracks: payloads } }),
          );
          showSuccess(`${label} saved to ${name}`);
        } else {
          const playlist = staticPlaylists.find((candidate) => candidate.id === target?.playlistId);
          await parseResponse(
            staticPlaylistsClient["shared-playlists"][":playlistId"].tracks.$post({
              param: { playlistId: encodeURIComponent(target?.playlistId) },
              json: { tracks: payloads },
            }),
          );
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
      loadStaticPlaylists,
      setPlaylistsError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const saveLibraryTracksToPlaylist = useCallback(
    async (
      tracks: LibraryPageTrack[],
      target: PlaylistTarget,
      { lookup = null, ...options }: SaveTracksOptions,
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
      await savePlaylistTracks(payloads, target, options);
    },
    [getAlbumForTrack, getArtistForAlbum, savePlaylistTracks, showError],
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
      await invalidateLibraryViews();
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
      void invalidateLibraryViews();
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
      onRemoved?.(removal);
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
    onRemoved,
    removeLocalLibraryEntity,
    showError,
    showSuccess,
  ]);

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

  const activityQueryKey = useMemo(() => queryKeys.libraryActivityRequests(user?.id), [user?.id]);

  const refreshLibraryActivity = useCallback(
    () => queryClient.invalidateQueries({ queryKey: activityQueryKey }),
    [activityQueryKey],
  );

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
        artwork: track.artworkUrl || album?.coverUrl || "",
        artworkSource: track.artworkUrl ? "track" : "album",
      };
    },
    [getAlbumForTrack, getArtistForAlbum],
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
        source: LIBRARY_SOURCE,
      });
    },
    [playQueue, playableTracks],
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
        if (insert(playable, { source: LIBRARY_SOURCE }) === "queued") {
          showSuccess(position === "next" ? "Playing next" : "Added to queue");
        }
      }),
    [addToQueue, playableTracks, queueNext, showSuccess, withCollection],
  );

  const toggleFavorite = useCallback(
    async (
      kind: "artist" | "album" | "song",
      entity: LibraryArtist | LibraryAlbum | LibraryPageTrack,
    ) => {
      const id = favoriteId(kind, entity);
      if (!id || id.endsWith(":") || favoriteMutationInFlightRef.current) return;
      const nextStarred = !favoriteIds.has(id);
      const applyFavorite = (ids: string[], starred: boolean) =>
        setFavoriteIds((current) => {
          const next = new Set(current);
          for (const favorite of ids) {
            if (starred) next.add(favorite);
            else next.delete(favorite);
          }
          return next;
        });
      if (isPreviewLibrary) {
        applyFavorite([id], nextStarred);
        return;
      }
      const previous = favoriteIds;
      favoriteMutationInFlightRef.current = true;
      setPendingFavorite(id);
      applyFavorite([id], nextStarred);
      const name = entity && ("name" in entity ? entity.name : entity.title);
      try {
        const result = await updateLibraryFavorites([id], nextStarred);
        const changedIds = Array.isArray(result?.changedIds) ? result.changedIds : [];
        applyFavorite(changedIds, nextStarred);
        if (!nextStarred) {
          showFavoriteRemoved(toast, {
            name,
            removed: result?.removed,
            restore: () => applyFavorite(changedIds, true),
            revert: () => applyFavorite(changedIds, false),
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
      if (String(currentTrack?.id) === String(playable.id) && matchesSource(LIBRARY_SOURCE)) {
        togglePlayPause();
        return;
      }
      playTracks(context || [track], track);
    },
    [buildPlayableTrack, currentTrack?.id, matchesSource, playTracks, togglePlayPause],
  );

  function libraryArtistPath(artist: Pick<LibraryArtist, "id">): string;
  function libraryArtistPath(artist: Pick<LibraryArtist, "id"> | null | undefined): string | null;
  function libraryArtistPath(artist: Pick<LibraryArtist, "id"> | null | undefined) {
    return artist?.id ? "/library/artist/" + encodeURIComponent(artist.id) + previewQuery : null;
  }
  function libraryAlbumPath(album: LibraryAlbum): string;
  function libraryAlbumPath(album: LibraryAlbum | null | undefined): string | null;
  function libraryAlbumPath(album: LibraryAlbum | null | undefined) {
    return album?.id != null ? albumLink(album) + previewQuery : null;
  }

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
          albumMbid: entity.releaseGroupMbid,
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
        albumMbid: album?.releaseGroupMbid,
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

  const albumMenuItems = (
    album: LibraryAlbum,
    artist: LibraryArtist | null | undefined,
    {
      lidarrConnected = libraryDestination.primary === "lidarr",
      extra = [] as LibraryMenuItem[],
    } = {},
  ): LibraryMenuItem[] => [
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
              openArtworkEditor("album", album, album.coverUrl || "", album.defaultCoverUrl || ""),
          },
        ]
      : []),
    ...extra,
    ...(canDeleteAlbum && canRemoveLibraryAlbum(album, { lidarrConnected })
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
  ];

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

  const buildLibraryTrackRow = (
    track: LibraryPageTrack,
    index: number,
    tracks: LibraryPageTrack[],
  ): TrackListRow => {
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
    const awaitingRelease =
      !file &&
      isAwaitingRelease({
        managedBy: album?.managedBy,
        monitored: getAlbumMonitoredState(album ?? null),
        releaseDate: album?.releaseDate,
      });
    const downloadKey = trackDownloadIdentity(track);
    const downloadState = trackDownloadStates[downloadKey];
    const backgroundDownload =
      !file &&
      (isTrackDownloading({ ...track, artistName: artist?.name || track.artistName }) ||
        isAlbumDownloading(album?.releaseGroupMbid || album?.mbid));
    const downloadPending =
      TRACK_DOWNLOAD_ACTIVE_STATUSES.has(downloadState?.status ?? "") || backgroundDownload;
    const downloadLabel = trackDownloadActionLabel(
      downloadState?.status || (backgroundDownload ? "downloading" : null),
    );
    const active = String(currentTrack?.id) === String(track.id) && matchesSource(LIBRARY_SOURCE);
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
      ? getQueueItems(buildPlayableTrack(track), { source: LIBRARY_SOURCE })
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
                  track.artworkUrl || album?.coverUrl || "",
                  album?.coverUrl || "",
                ),
            },
          ]
        : []),
      ...(!file && !awaitingRelease
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
                isPreviewLibrary || trackResearchStates[`${track.id}:${researchAlbum.id}`] === true,
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
      number: index + 1,
      title: track.title || "Unknown Track",
      badge: !trackMonitoring.isMonitored(track) ? (
        <span className="native-library-track__unmonitored" role="img" aria-label="Not monitored">
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
        src: track.artworkUrl || album?.coverUrl || "",
        label: albumName,
        to: libraryAlbumPath(album),
      },
      time: formatDuration(trackDurationMs(track)) || (awaitingRelease ? "—" : "Unavailable"),
      timeMissing: !file,
      active,
      playing: active && isRunning,
      loading: active && isLoading,
      missing: !file,
      onPlay: file ? () => playTrack(track, tracks) : null,
      trailing:
        !file && !awaitingRelease ? (
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
  };

  const renderModals = () => (
    <>
      {trackMonitoring.dialog}
      <DeleteArtistModal
        show={libraryRemoval?.kind === "artist"}
        artistName={libraryRemoval?.kind === "artist" ? libraryRemoval.entity.name : undefined}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onCancel={() => setLibraryRemoval(null)}
        onConfirm={handleLibraryRemovalConfirm}
        deleting={deletingLibraryEntity}
      />
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

  return {
    setLibrary,
    artistsById,
    albumsById,
    getAlbumTracks,
    loadAlbumTracks,
    getAlbumForTrack,
    getArtistForAlbum,
    lookupWithPages,
    albumAvailability,
    staticPlaylists,
    playlistsLoading,
    playlistsError,
    loadStaticPlaylists,
    playlistSavingKey,
    savePlaylistTracks,
    canDeleteArtist,
    canAddTracks,
    canChangeMonitoring,
    canEditArtistMbid,
    libraryDestination,
    isAlbumDownloading,
    openLibraryRemoval,
    openLibraryInfo,
    trackDownloadStates,
    setTrackDownloadStates,
    activityQueryKey,
    refreshLibraryActivity,
    currentTrack,
    isRunning,
    togglePlayPause,
    matchesSource,
    playTracks,
    loadAlbumCollection,
    playCollection,
    pendingFavorite,
    toggleFavorite,
    libraryArtistPath,
    libraryAlbumPath,
    shareMenuItem,
    albumMenuItems,
    collectionQueueItems,
    collectionPlayItems,
    collectionPlaylistMenu,
    albumMenuProps,
    discoverArtistState,
    buildLibraryTrackRow,
    renderModals,
  };
}
