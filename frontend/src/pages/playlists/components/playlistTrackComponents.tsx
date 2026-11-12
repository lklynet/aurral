import { useEffect, useRef, useMemo, useState, useCallback, type MouseEvent } from "react";
import type { IconComponent } from "../../../components/icons";
import {
  Clock,
  Download,
  Info,
  ImagePlus,
  ListMusic,
  Play,
  Pause,
  Search,
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  Share,
  X,
} from "../../../components/icons";
import { DownloadingIcon } from "../../../components/DotLoader";
import { SkeletonStatus, SkeletonTrackList } from "../../../components/Skeletons";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import TooltipButton from "../../../components/TooltipButton";
import { matchesPlaylistTrackQuery, sortPlaylistTracks } from "../../../utils/playlistTrackSort";
import { Link } from "react-router";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizePlaylistQueueTrack } from "../../../utils/audioQueue";
import {
  TrackPlaylistMenu,
  TrackPlaylistSubmenu,
  type TrackPlaylistMenuHandle,
} from "../../../components/TrackPlaylistMenu";
import { LibraryItemMenu } from "../../../components/LibraryItemMenu";
import { TrackList } from "../../../components/TrackList";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import {
  canPlayTrack,
  getTrackAvailability,
  getTrackSearchAction,
  queueTrackOverrides,
  shouldShowAddToLibrary,
} from "../../../utils/trackAvailability.ts";
import type { LibraryMenuItem } from "../../../components/LibraryItemMenu";
import type { PlaybackSource } from "../../../hooks/useAlbumTrackListToolbar";
import type { PlaylistTrackRow } from "../playlistPageUtils.ts";
import type { StaticPlaylist } from "../../../utils/playlistStats.ts";

export type PlaylistPanelTrack = Pick<
  PlaylistTrackRow,
  "id" | "artistName" | "trackName" | "status" | "streamUrl"
> &
  Partial<PlaylistTrackRow> & { resolvesLinks?: boolean };

export type PlaylistTrackTarget =
  | { mode: "new"; name: string }
  | { mode: "existing"; playlistId: string };

type PlaylistPlaybackSource = PlaybackSource & { recordHistory?: boolean };

interface PlaylistTrackMenuProps<T extends PlaylistPanelTrack> {
  track: T | null;
  playlists: StaticPlaylist[];
  loading: boolean;
  saving: boolean;
  error: string;
  defaultNewPlaylistName: string;
  excludedPlaylistIds: string[];
  onLoadPlaylists?: () => void;
  onAddTrackToPlaylist: ((target: PlaylistTrackTarget) => void | Promise<void>) | null;
  onMoveTrackToPlaylist: ((target: PlaylistTrackTarget) => void | Promise<void>) | null;
}

type PlaylistTrackLink = { to: string | null; state?: unknown };

function formatTrackDuration(durationMs: number | null | undefined) {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface BulkPlaylistActionProps<T extends PlaylistPanelTrack> {
  icon: IconComponent;
  label: string;
  track: T | undefined;
  playlists: StaticPlaylist[];
  loading: boolean;
  saving: boolean;
  disabled: boolean;
  error: string;
  defaultNewPlaylistName: string;
  excludedPlaylistIds: string[];
  onSelect: (target: PlaylistTrackTarget) => void;
}

function BulkPlaylistAction<T extends PlaylistPanelTrack>({
  icon: Icon,
  label,
  track,
  playlists,
  loading,
  saving,
  disabled,
  error,
  defaultNewPlaylistName,
  excludedPlaylistIds,
  onSelect,
}: BulkPlaylistActionProps<T>) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<TrackPlaylistMenuHandle>(null);
  const handleOpen = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    menuRef.current?.open(buttonRef.current);
  }, []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleOpen}
        disabled={disabled}
      >
        <Icon className="artist-icon-sm" />
        <span>{label}</span>
      </button>
      <span className="flow-page__bulk-menu-anchor">
        <TrackPlaylistMenu
          ref={menuRef}
          track={track}
          playlists={playlists}
          loading={loading}
          saving={saving}
          error={error}
          defaultNewPlaylistName={defaultNewPlaylistName}
          excludedPlaylistIds={excludedPlaylistIds}
          triggerVariant="hidden"
          onSelect={onSelect}
        />
      </span>
    </>
  );
}

interface PlaylistTrackKebabMenuProps<T extends PlaylistPanelTrack> {
  track: T;
  canPlay?: boolean;
  isPlaying?: boolean;
  onPlay: ((track: T) => void) | null;
  onViewInfo: ((track: T) => void) | undefined;
  onEditArtwork: ((track: T) => void) | undefined;
  onAddToLibrary: ((track: T) => void) | undefined;
  isAddingToLibrary?: boolean;
  canReSearch: boolean;
  canManualReSearch: boolean;
  searchAction: "research" | "replacement" | "upgrade" | null;
  isReSearching: boolean;
  canDelete: boolean;
  isDeleting: boolean;
  onReSearch: ((track: T, forceReplacementSearch?: boolean) => void) | undefined;
  onManualReSearch: ((track: T) => void) | undefined;
  onDelete: ((track: T) => void) | undefined;
  playlistMenuProps?: PlaylistTrackMenuProps<T> | null;
  queueItems?: LibraryMenuItem[];
  onShare?: (track: T) => void;
}

function PlaylistTrackKebabMenu<T extends PlaylistPanelTrack>({
  track,
  canPlay = false,
  isPlaying = false,
  onPlay,
  onViewInfo,
  onEditArtwork,
  onAddToLibrary,
  isAddingToLibrary = false,
  canReSearch,
  canManualReSearch,
  searchAction,
  isReSearching,
  canDelete,
  isDeleting,
  onReSearch,
  onManualReSearch,
  onDelete,
  playlistMenuProps = null,
  queueItems = [],
  onShare,
}: PlaylistTrackKebabMenuProps<T>) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const trackLabel = track?.trackName || "track";
  const canAddToLibrary = shouldShowAddToLibrary(track, onAddToLibrary);
  const { isTrackDownloading } = useActiveDownloads();
  const downloading = canAddToLibrary && isTrackDownloading(track);
  const actionItems = [
    onShare
      ? { id: "share", label: "Share track", icon: Share, onSelect: () => onShare(track) }
      : null,
    onPlay
      ? {
          id: "play",
          label: isPlaying ? "Pause" : "Play",
          icon: isPlaying ? Pause : Play,
          disabled: !canPlay,
          onSelect: () => onPlay(track),
        }
      : null,
    ...queueItems,
    onViewInfo
      ? {
          id: "info",
          label: "View info",
          icon: Info,
          onSelect: () => onViewInfo(track),
        }
      : null,
    onEditArtwork
      ? {
          id: "artwork",
          label: "Change artwork",
          icon: ImagePlus,
          onSelect: () => onEditArtwork(track),
        }
      : null,
    canAddToLibrary
      ? {
          id: "add-library",
          label: downloading ? "Downloading…" : "Add to library",
          icon: downloading ? DownloadingIcon : Plus,
          disabled: isAddingToLibrary || downloading,
          onSelect: () => onAddToLibrary!(track),
        }
      : null,
    canReSearch
      ? {
          id: "re-search",
          label:
            searchAction === "upgrade"
              ? "Search for upgrade"
              : track.status === "saved"
                ? "Download"
                : "Re-search",
          icon: track.status === "saved" ? Download : Search,
          separatorBefore: true,
          disabled: isReSearching,
          onSelect: () => onReSearch?.(track),
        }
      : null,
    canManualReSearch
      ? {
          id: "replacement-search",
          label: "Re-search",
          icon: Search,
          separatorBefore: true,
          submenuItems: [
            {
              id: "automatic",
              label: "Automatic",
              icon: RefreshCw,
              disabled: isReSearching,
              onSelect: () => onReSearch?.(track, true),
            },
            {
              id: "manual",
              label: "Manual",
              icon: Search,
              disabled: isReSearching,
              onSelect: () => onManualReSearch?.(track),
            },
          ],
        }
      : null,
    canDelete
      ? {
          id: "remove",
          label: "Remove from playlist",
          icon: Trash2,
          danger: true,
          disabled: isDeleting,
          onSelect: () => onDelete?.(track),
        }
      : null,
  ].filter((item): item is LibraryMenuItem => Boolean(item));
  const additionalItemsAfter = canAddToLibrary
    ? "add-library"
    : canReSearch
      ? "re-search"
      : canManualReSearch
        ? "replacement-search"
        : "remove";
  return (
    <LibraryItemMenu
      label={trackLabel}
      items={actionItems}
      additionalItemsAfter={additionalItemsAfter}
      onMenuOpen={() => {
        setOpenSubmenu(null);
        playlistMenuProps?.onLoadPlaylists?.();
      }}
      renderAdditionalItems={({ closeMenu }) => (
        <>
          {playlistMenuProps?.onAddTrackToPlaylist ? (
            <>
              <div className="native-library-item-menu__separator" />
              <TrackPlaylistSubmenu
                label="Add to playlist"
                icon={Plus}
                track={playlistMenuProps.track}
                playlists={playlistMenuProps.playlists}
                loading={playlistMenuProps.loading}
                saving={playlistMenuProps.saving}
                error={playlistMenuProps.error}
                defaultNewPlaylistName={playlistMenuProps.defaultNewPlaylistName}
                excludedPlaylistIds={playlistMenuProps.excludedPlaylistIds}
                onSelect={playlistMenuProps.onAddTrackToPlaylist}
                onClose={closeMenu}
                toggleOnClick
                isOpen={openSubmenu === "add"}
                onToggle={() => setOpenSubmenu((current) => (current === "add" ? null : "add"))}
              />
            </>
          ) : null}
          {playlistMenuProps?.onMoveTrackToPlaylist ? (
            <TrackPlaylistSubmenu
              label="Move to playlist"
              icon={ListMusic}
              track={playlistMenuProps.track}
              playlists={playlistMenuProps.playlists}
              loading={playlistMenuProps.loading}
              saving={playlistMenuProps.saving}
              error={playlistMenuProps.error}
              defaultNewPlaylistName={playlistMenuProps.defaultNewPlaylistName}
              excludedPlaylistIds={playlistMenuProps.excludedPlaylistIds}
              onSelect={playlistMenuProps.onMoveTrackToPlaylist}
              onClose={closeMenu}
              toggleOnClick
              isOpen={openSubmenu === "move"}
              onToggle={() => setOpenSubmenu((current) => (current === "move" ? null : "move"))}
            />
          ) : null}
        </>
      )}
    />
  );
}

const FLOW_EXCEPTIONS = [
  { status: "downloading", label: "downloading", tone: "subtle" },
  { status: "pending", label: "queued", tone: "subtle" },
  { status: "blocked", label: "need review", tone: "review" },
  { status: "failed", label: "missing", tone: "warning" },
] as const;

function FlowTrackStatus({ track, searching }: { track: PlaylistPanelTrack; searching: boolean }) {
  const { status, label } = getTrackAvailability(track);
  const Icon =
    searching || status === "downloading" ? Download : status === "pending" ? Clock : null;
  const tone =
    status === "blocked" ? "review" : status === "failed" && !searching ? "warning" : "subtle";
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {searching ? "Searching" : label}
    </>
  );
  if (track.status === "saved") {
    return <span className={`flow-track-status is-${tone}`}>{content}</span>;
  }
  return (
    <Link
      to="/activity/queue"
      className={`flow-track-status is-${tone}`}
      aria-label={`${searching ? "Searching" : label}, view activity`}
    >
      {content}
    </Link>
  );
}

export function usePlaylistTrackPlayback<T extends PlaylistPanelTrack>({
  tracks,
  playbackSource,
}: {
  tracks: T[];
  playbackSource: PlaylistPlaybackSource | null;
}) {
  const recordHistory = playbackSource?.recordHistory !== false;
  const getQueueTracks = useCallback(
    () =>
      tracks
        .filter(canPlayTrack)
        .map((track) =>
          normalizePlaylistQueueTrack(track, queueTrackOverrides(track, recordHistory)),
        ),
    [recordHistory, tracks],
  );
  return useAlbumTrackListToolbar({ getQueueTracks, playbackSource });
}

export interface PlaylistTracksPanelProps<T extends PlaylistPanelTrack> {
  label?: string;
  tracks: T[];
  loading: boolean;
  error?: string;
  emptyMessage?: string;
  deletingTrackId?: string | null;
  reSearchingTrackIds?: Record<string, boolean>;
  playlists?: StaticPlaylist[];
  playlistsLoading?: boolean;
  playlistSavingKey?: string;
  playlistMenuError?: string;
  excludedPlaylistIds?: string[];
  getDefaultPlaylistName?: (track: T | undefined) => string;
  onLoadPlaylists?: () => void;
  onDeleteTrack?: (track: T) => unknown;
  onAddTrackToPlaylist?: (track: T, target: PlaylistTrackTarget) => void | Promise<void>;
  onMoveTrackToPlaylist?: (track: T, target: PlaylistTrackTarget) => void | Promise<void>;
  onAddTrackToLibrary?: (track: T) => unknown;
  onViewTrackInfo?: (track: T) => void;
  onShareTrack?: (track: T) => void;
  onEditTrackArtwork?: (track: T) => void;
  libraryTrackSavingKey?: string;
  getTrackFavoriteId?: (track: T) => string;
  favoriteTrackIds?: Set<string>;
  favoriteTrackSavingKey?: string;
  onToggleFavorite?: (track: T) => unknown;
  onNavigateArtist?: (track: T) => void;
  onNavigateAlbum?: (track: T) => void;
  getArtistLink?: (track: T) => PlaylistTrackLink | null;
  getAlbumLink?: (track: T) => PlaylistTrackLink | null;
  onReSearchTrack?: (track: T, forceReplacementSearch?: boolean) => unknown;
  onManualReSearchTrack?: (track: T) => void;
  playbackSource?: PlaylistPlaybackSource | null;
  showPlaybackControls?: boolean;
  showTrackStatus?: boolean;
  showReasons?: boolean;
  showTrackAvailability?: boolean;
  allowBulkEdit?: boolean;
  onBulkDelete?: (tracks: T[]) => unknown;
  onBulkAddToPlaylist?: (tracks: T[], target: PlaylistTrackTarget) => unknown;
  bulkAddLabel?: string;
  onBulkAddToLibrary?: (tracks: T[]) => unknown;
  onBulkMoveToPlaylist?: (tracks: T[], target: PlaylistTrackTarget) => unknown;
  bulkActionLoading?: boolean;
}

export function PlaylistTracksPanel<T extends PlaylistPanelTrack>({
  label = "Tracks",
  tracks,
  loading,
  error,
  emptyMessage = "No tracks yet.",
  deletingTrackId = null,
  reSearchingTrackIds = {},
  playlists = [],
  playlistsLoading = false,
  playlistSavingKey = "",
  playlistMenuError = "",
  excludedPlaylistIds = [],
  getDefaultPlaylistName,
  onLoadPlaylists,
  onDeleteTrack,
  onAddTrackToPlaylist,
  onMoveTrackToPlaylist,
  onAddTrackToLibrary,
  onViewTrackInfo,
  onShareTrack,
  onEditTrackArtwork,
  libraryTrackSavingKey = "",
  getTrackFavoriteId,
  favoriteTrackIds = new Set(),
  favoriteTrackSavingKey = "",
  onToggleFavorite,
  onNavigateArtist,
  onNavigateAlbum,
  getArtistLink,
  getAlbumLink,
  onReSearchTrack,
  onManualReSearchTrack,
  playbackSource = null,
  showPlaybackControls = true,
  showTrackStatus = false,
  showReasons = false,
  showTrackAvailability = false,
  allowBulkEdit = false,
  onBulkDelete,
  onBulkAddToPlaylist,
  bulkAddLabel = "Copy",
  onBulkAddToLibrary,
  onBulkMoveToPlaylist,
  bulkActionLoading = false,
}: PlaylistTracksPanelProps<T>) {
  const [sortKey, setSortKey] = useState("index");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trackOrderKey = useMemo(() => tracks.map((track) => track.id).join("\n"), [tracks]);

  useEffect(() => {
    setSortKey("index");
    setSortDirection("asc");
    setEditMode(false);
    setSelectedIds(new Set());
  }, [trackOrderKey]);

  const {
    playTrack,
    togglePlayPause,
    matchesSource,
    isPlaying,
    isLoading,
    isStarting,
    currentTrack,
  } = useAudioQueue();
  const isRunning = isPlaying || isStarting;
  const getQueueItems = useQueueTrackActions();

  const sortedTracks = useMemo(
    () => sortPlaylistTracks(tracks, sortKey, sortDirection),
    [tracks, sortKey, sortDirection],
  );
  const trackNumbers = useMemo(
    () => new Map(tracks.map((track, index) => [track.id, index + 1])),
    [tracks],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTracks = useMemo(
    () =>
      normalizedQuery
        ? sortedTracks.filter((track) => matchesPlaylistTrackQuery(track, normalizedQuery))
        : sortedTracks,
    [sortedTracks, normalizedQuery],
  );
  const showYear = useMemo(() => tracks.some((track) => track.releaseYear), [tracks]);
  const reasonsVary = useMemo(
    () => showReasons && new Set(tracks.map((track) => track.reason).filter(Boolean)).size > 1,
    [showReasons, tracks],
  );
  const exceptions = useMemo(() => {
    if (!showTrackStatus) return [];
    const counts = new Map<string, number>();
    for (const track of tracks) {
      if (track.status === "saved") continue;
      const { status } = getTrackAvailability(track);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return FLOW_EXCEPTIONS.flatMap((entry) => {
      const count = counts.get(entry.status) ?? 0;
      return count > 0 ? [{ ...entry, count }] : [];
    });
  }, [showTrackStatus, tracks]);
  const isSearchVisible = searchOpen || Boolean(query);
  const activeReplacementTrackIds = useMemo(
    () =>
      new Set(
        tracks
          .filter(
            (track) =>
              ["pending", "downloading", "blocked"].includes(track.status) && track.upgradeForJobId,
          )
          .map((track) => String(track.upgradeForJobId)),
      ),
    [tracks],
  );
  const selectedTracks = useMemo(
    () => sortedTracks.filter((track) => selectedIds.has(track.id)),
    [sortedTracks, selectedIds],
  );
  const selectedCount = selectedIds.size;
  const recordHistory = playbackSource?.recordHistory !== false;
  const playableTracks = useMemo(() => visibleTracks.filter(canPlayTrack), [visibleTracks]);
  const allVisibleSelected =
    visibleTracks.length > 0 && visibleTracks.every((track) => selectedIds.has(track.id));
  const isSourceActive = matchesSource(playbackSource);
  const currentTrackId = isSourceActive && currentTrack?.id ? currentTrack.id : null;

  const handleSort = (nextSortKey: string) => {
    if (sortKey === nextSortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextSortKey);
    setSortDirection("asc");
  };

  const handleExitEditMode = () => {
    setEditMode(false);
    setSelectedIds(new Set());
  };

  const toQueueTrack = (track: T) =>
    normalizePlaylistQueueTrack(track, queueTrackOverrides(track, recordHistory));

  const handlePlayTrack = (track: T) => {
    if (!track?.streamUrl) return;
    if (currentTrackId === track.id) {
      togglePlayPause();
      return;
    }
    playTrack(toQueueTrack(track), {
      source: playbackSource,
      queue: playableTracks.map(toQueueTrack),
    });
  };

  const bulkMenuProps = {
    track: selectedTracks[0],
    playlists,
    loading: playlistsLoading,
    saving: bulkActionLoading,
    disabled: !selectedCount || bulkActionLoading,
    error: playlistMenuError,
    defaultNewPlaylistName: getDefaultPlaylistName?.(selectedTracks[0]) || "Playlist",
    excludedPlaylistIds,
  };

  const rows = visibleTracks.map((track) => {
    const canPlay = showPlaybackControls && canPlayTrack(track);
    const searchAction = getTrackSearchAction(track, showTrackAvailability);
    const canReSearch =
      typeof onReSearchTrack === "function" && Boolean(track.id) && searchAction !== null;
    const canManualReSearch =
      typeof onReSearchTrack === "function" &&
      track.status === "done" &&
      track.qualityOwned === true &&
      !activeReplacementTrackIds.has(String(track.id));
    const availability = showTrackAvailability ? getTrackAvailability(track) : null;
    const isReSearching = reSearchingTrackIds[track.id] === true;
    const isCurrent = track.id === currentTrackId;
    const reason = reasonsVary ? track.reason : null;
    const flowStatus =
      showTrackStatus && (isReSearching || !(track.status === "done" && track.streamUrl)) ? (
        <FlowTrackStatus track={track} searching={isReSearching} />
      ) : null;
    const trackFavoriteId = getTrackFavoriteId?.(track) || "";
    const hasPlaylistMenu =
      track.artistName && track.trackName && (onAddTrackToPlaylist || onMoveTrackToPlaylist);
    const canOpenArtist = Boolean(onNavigateArtist && (track.artistMbid || track.resolvesLinks));
    const canOpenAlbum = Boolean(
      onNavigateAlbum && (track.albumMbid || (track.resolvesLinks && track.albumName)),
    );
    const artistLink = getArtistLink?.(track) || null;
    const albumLink = getAlbumLink?.(track) || null;
    const playlistMenuProps = hasPlaylistMenu
      ? {
          track,
          playlists,
          loading: playlistsLoading,
          saving: playlistSavingKey === String(track.id || ""),
          error: playlistMenuError,
          defaultNewPlaylistName: getDefaultPlaylistName?.(track) || "Playlist",
          excludedPlaylistIds,
          onLoadPlaylists,
          onAddTrackToPlaylist: onAddTrackToPlaylist
            ? (target: PlaylistTrackTarget) => onAddTrackToPlaylist(track, target)
            : null,
          onMoveTrackToPlaylist: onMoveTrackToPlaylist
            ? (target: PlaylistTrackTarget) => onMoveTrackToPlaylist(track, target)
            : null,
        }
      : null;
    return {
      key: track.id,
      number: trackNumbers.get(track.id),
      title: track.trackName,
      year: track.releaseYear,
      subtitle: flowStatus ? (
        <>
          {track.artistName}
          <span className="native-library-track__subtitle-status"> · {flowStatus}</span>
          {reason ? (
            <span className="native-library-track__subtitle-reason"> · {reason}</span>
          ) : null}
        </>
      ) : reason ? (
        `${track.artistName} · ${reason}`
      ) : (
        track.artistName
      ),
      reason,
      artist: {
        label: track.artistName,
        ...artistLink,
        onOpen: canOpenArtist ? () => onNavigateArtist!(track) : null,
      },
      album: {
        label: track.albumName || "",
        ...albumLink,
        onOpen: canOpenAlbum ? () => onNavigateAlbum!(track) : null,
      },
      cover: {
        src: track.artworkUrl || "",
        label: track.albumName || track.trackName,
        ...albumLink,
        onOpen: canOpenAlbum ? () => onNavigateAlbum!(track) : null,
      },
      time: flowStatus ?? formatTrackDuration(track.durationMs),
      active: isCurrent,
      playing: isCurrent && isRunning,
      loading: isCurrent && isLoading,
      missing: showPlaybackControls && (!canPlay || (!showTrackStatus && track.status === "saved")),
      status:
        !showTrackStatus &&
        showPlaybackControls &&
        !canPlay &&
        (isReSearching || track.status !== "saved")
          ? ({
              label: isReSearching ? "Searching" : getTrackAvailability(track).label,
              kind:
                isReSearching || track.status === "downloading"
                  ? "active"
                  : track.status === "pending"
                    ? "queued"
                    : "missing",
            } as const)
          : null,
      onPlay:
        showPlaybackControls && (canPlay || !showTrackStatus) ? () => handlePlayTrack(track) : null,
      playDisabled: !canPlay,
      badge: availability ? (
        <TooltipButton
          className="flow-page__track-availability-indicator"
          label={availability.label}
        >
          <span
            className={`flow-page__track-status-dot flow-page__track-status-dot--${availability.status}`}
            aria-hidden="true"
          />
        </TooltipButton>
      ) : null,
      trailing:
        showTrackStatus && track.status === "saved" && canReSearch && !isReSearching ? (
          <TooltipButton
            className="native-library-track__download native-library-track__hover-action"
            onClick={() => onReSearchTrack?.(track)}
            label="Download"
            aria-label={`Download ${track.trackName}`}
          >
            <Download aria-hidden="true" />
          </TooltipButton>
        ) : null,
      favorite:
        trackFavoriteId && onToggleFavorite
          ? {
              active: favoriteTrackIds.has(trackFavoriteId),
              pending: favoriteTrackSavingKey === trackFavoriteId,
              onToggle: () => onToggleFavorite(track),
            }
          : null,
      selected: selectedIds.has(track.id),
      onToggleSelected: () =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(track.id)) next.delete(track.id);
          else next.add(track.id);
          return next;
        }),
      menuElement: (
        <PlaylistTrackKebabMenu
          track={track}
          canPlay={canPlay}
          isPlaying={isCurrent && isRunning}
          onPlay={showPlaybackControls ? handlePlayTrack : null}
          onViewInfo={onViewTrackInfo}
          onShare={onShareTrack}
          onEditArtwork={onEditTrackArtwork}
          onAddToLibrary={onAddTrackToLibrary}
          isAddingToLibrary={libraryTrackSavingKey === String(track.id)}
          canReSearch={canReSearch}
          canManualReSearch={canManualReSearch}
          searchAction={searchAction}
          isReSearching={isReSearching}
          canDelete={typeof onDeleteTrack === "function" && Boolean(track.id)}
          isDeleting={deletingTrackId === track.id}
          onReSearch={onReSearchTrack}
          onManualReSearch={onManualReSearchTrack}
          onDelete={onDeleteTrack}
          playlistMenuProps={playlistMenuProps}
          queueItems={canPlay ? getQueueItems(toQueueTrack(track), { source: playbackSource }) : []}
        />
      ),
    };
  });

  return (
    <div className="collection-tracks">
      {tracks.length > 0 ? (
        <div className="collection-tracks__toolbar">
          {exceptions.length > 0 && !normalizedQuery ? (
            <span className="collection-tracks__exceptions" role="status">
              {exceptions.map(({ status, label, tone, count }) => (
                <span key={status} className={`flow-track-status is-${tone}`}>
                  {status === "downloading" ? <Download aria-hidden="true" /> : null}
                  {status === "pending" ? <Clock aria-hidden="true" /> : null}
                  {count} {label}
                </span>
              ))}
            </span>
          ) : null}
          {normalizedQuery ? (
            <span className="collection-tracks__count" role="status">
              {visibleTracks.length} of {tracks.length}
            </span>
          ) : null}
          {isSearchVisible ? (
            <label className="native-library-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tracks"
                aria-label={`Search ${label}`}
                autoFocus
              />
              {query ? (
                <TooltipButton onClick={() => setQuery("")} label="Clear search" className="btn">
                  <X aria-hidden="true" />
                </TooltipButton>
              ) : null}
            </label>
          ) : null}
          <TooltipButton
            className={`native-library-icon-button${isSearchVisible ? " is-active" : ""}`}
            onClick={() => {
              setSearchOpen(!isSearchVisible);
              if (isSearchVisible) setQuery("");
            }}
            label={isSearchVisible ? "Close search" : "Search"}
            aria-label={isSearchVisible ? "Close search" : "Search tracks"}
            aria-pressed={isSearchVisible}
          >
            <Search aria-hidden="true" />
          </TooltipButton>
          {!allowBulkEdit ? null : editMode ? (
            <>
              <span className="flow-page__bulk-count" role="status">
                {selectedCount} selected
              </span>
              {onBulkDelete ? (
                <TooltipButton
                  onClick={() => onBulkDelete(selectedTracks)}
                  className="btn btn-ghost-danger btn-icon btn-sm"
                  disabled={bulkActionLoading || !selectedCount}
                  label="Remove selected"
                  aria-label="Remove selected"
                >
                  <Trash2 className="artist-icon-sm" />
                </TooltipButton>
              ) : null}
              {onBulkAddToPlaylist ? (
                <BulkPlaylistAction
                  {...bulkMenuProps}
                  icon={Plus}
                  label={bulkAddLabel}
                  onSelect={(target) => {
                    onBulkAddToPlaylist(selectedTracks, target);
                    handleExitEditMode();
                  }}
                />
              ) : null}
              {onBulkAddToLibrary ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={bulkActionLoading || !selectedCount}
                  onClick={async () => {
                    await onBulkAddToLibrary(selectedTracks);
                    handleExitEditMode();
                  }}
                >
                  <Download className="artist-icon-sm" />
                  <span>Add to library</span>
                </button>
              ) : null}
              {onBulkMoveToPlaylist ? (
                <BulkPlaylistAction
                  {...bulkMenuProps}
                  icon={ListMusic}
                  label="Move"
                  onSelect={(target) => {
                    onBulkMoveToPlaylist(selectedTracks, target);
                    handleExitEditMode();
                  }}
                />
              ) : null}
              <button
                type="button"
                onClick={handleExitEditMode}
                className="btn btn-secondary btn-sm"
                disabled={bulkActionLoading}
              >
                Done
              </button>
            </>
          ) : (
            <TooltipButton
              onClick={() => setEditMode(true)}
              className="native-library-icon-button"
              label="Select tracks"
              aria-label="Select tracks"
            >
              <Pencil aria-hidden="true" />
            </TooltipButton>
          )}
        </div>
      ) : null}
      {loading ? (
        <SkeletonStatus label="Loading tracks">
          <SkeletonTrackList count={8} />
        </SkeletonStatus>
      ) : error ? (
        <div className="native-library-state" role="alert">
          <strong>Tracks unavailable</strong>
          <span>{error}</span>
        </div>
      ) : tracks.length === 0 ? (
        <div className="native-library-state">
          <span>{emptyMessage}</span>
        </div>
      ) : visibleTracks.length === 0 ? (
        <div className="native-library-state" role="status">
          <span>No tracks match “{query.trim()}”</span>
        </div>
      ) : (
        <TrackList
          label={label}
          rows={rows}
          showYear={showYear}
          showReason={reasonsVary}
          wideTime={rows.some((row) => typeof row.time !== "string")}
          sort={{ key: sortKey, direction: sortDirection, onSort: handleSort }}
          selection={
            editMode
              ? {
                  allSelected: allVisibleSelected,
                  onToggleAll: () =>
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      for (const track of visibleTracks) {
                        if (allVisibleSelected) next.delete(track.id);
                        else next.add(track.id);
                      }
                      return next;
                    }),
                }
              : null
          }
        />
      )}
    </div>
  );
}
