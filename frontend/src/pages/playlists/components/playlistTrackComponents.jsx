import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  Download,
  ExternalLink,
  Heart,
  Info,
  ListMusic,
  Play,
  Pause,
  Search,
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  UserRound,
} from "lucide-react";
import { DotLoader, DownloadingIcon } from "../../../components/DotLoader";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import TooltipButton from "../../../components/TooltipButton";
import { getPlaylistTrackDisplayNumber, sortPlaylistTracks } from "../../../utils/playlistTrackSort";
import { Link } from "react-router";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizePlaylistQueueTrack } from "../../../utils/audioQueue";
import { TrackPlaylistMenu, TrackPlaylistSubmenu } from "../../ArtistDetails/components/TrackPlaylistMenu";
import { LibraryItemMenu } from "../../../components/LibraryItemMenu";
import { TrackList } from "../../../components/TrackList";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import {
  getTrackAvailability,
  getTrackSearchAction,
  shouldShowAddToLibrary,
} from "../trackAvailability.js";
import Tooltip from "../../../components/Tooltip";

function getTrackStatusMeta(status) {
  switch (String(status || "").toLowerCase()) {
    case "done":
      return { label: "Downloaded", className: "flow-page__track-status-dot--done" };
    case "downloading":
      return {
        label: "Downloading",
        className: "flow-page__track-status-dot--downloading",
      };
    case "failed":
      return { label: "Failed", className: "flow-page__track-status-dot--failed" };
    case "blocked":
      return { label: "Review", className: "flow-page__track-status-dot--blocked" };
    case "pending":
    default:
      return { label: "Queued", className: "flow-page__track-status-dot--pending" };
  }
}

function formatTrackDuration(durationMs) {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function BulkPlaylistAction({
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
}) {
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const handleOpen = useCallback((e) => {
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

function PlaylistTrackKebabMenu({
  track,
  canPlay = false,
  isPlaying = false,
  onPlay,
  onViewInfo,
  onAddToLibrary,
  isAddingToLibrary = false,
  isFavorite = false,
  isFavoritePending = false,
  onToggleFavorite,
  onNavigateAlbum,
  onNavigateArtist,
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
}) {
  const [openSubmenu, setOpenSubmenu] = useState(null);
  const trackLabel = track?.trackName || "track";
  const canNavigateAlbum = Boolean(
    onNavigateAlbum && (track?.albumMbid || (track?.resolvesLinks && track?.albumName)),
  );
  const canNavigateArtist = Boolean(onNavigateArtist && (track?.artistMbid || track?.resolvesLinks));
  const canAddToLibrary = shouldShowAddToLibrary(track, onAddToLibrary);
  const { isTrackDownloading } = useActiveDownloads();
  const downloading = canAddToLibrary && isTrackDownloading(track);
  const actionItems = [
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
    canAddToLibrary
      ? {
          id: "add-library",
          label: downloading ? "Downloading…" : "Add to library",
          icon: downloading ? DownloadingIcon : Plus,
          disabled: isAddingToLibrary || downloading,
          onSelect: () => onAddToLibrary(track),
        }
      : null,
    onToggleFavorite
      ? {
          id: "favorite",
          label: isFavorite ? "Remove from favorites" : "Add to favorites",
          icon: Heart,
          selected: isFavorite,
          separatorBefore: true,
          disabled: isFavoritePending,
          onSelect: () => onToggleFavorite?.(track),
        }
      : null,
    canNavigateAlbum
      ? {
          id: "album",
          label: "Go to album",
          icon: ExternalLink,
          separatorBefore: true,
          onSelect: () => onNavigateAlbum(track),
        }
      : null,
    canNavigateArtist
      ? {
          id: "artist",
          label: "Go to artist",
          icon: UserRound,
          onSelect: () => onNavigateArtist(track),
        }
      : null,
    canReSearch
      ? {
          id: "re-search",
          label: searchAction === "upgrade" ? "Search for upgrade" : "Re-search",
          icon: Search,
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
  ].filter(Boolean);
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
                onToggle={() =>
                  setOpenSubmenu((current) => (current === "add" ? null : "add"))
                }
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
              onToggle={() =>
                setOpenSubmenu((current) => (current === "move" ? null : "move"))
              }
            />
          ) : null}
        </>
      )}
    />
  );
}


function TrackStatusDot({ status }) {
  const meta = getTrackStatusMeta(status);
  const normalized = String(status || "").toLowerCase();
  const isLinkable = normalized !== "done";
  if (isLinkable) {
    const targetPath = "/activity/queue";
    return (
      <Link
        to={targetPath}
        className={`flow-page__track-status-dot flow-page__track-status-dot--link ${meta.className}`}
        title={`${meta.label} — view activity`}
        aria-label={`${meta.label}, view activity`}
      />
    );
  }
  return (
    <Tooltip content={meta.label}>
      <span
        className={`flow-page__track-status-dot ${meta.className}`}
        aria-label={meta.label}
        role="img"
      />
    </Tooltip>
  );
}





export function usePlaylistTrackPlayback({ tracks, playbackSource }) {
  const recordHistory = playbackSource?.recordHistory !== false;
  const getQueueTracks = useCallback(
    () =>
      tracks
        .filter((track) => track.status === "done" && track.streamUrl)
        .map((track) => normalizePlaylistQueueTrack(track, { recordHistory })),
    [recordHistory, tracks],
  );
  return useAlbumTrackListToolbar({ getQueueTracks, playbackSource });
}

export function PlaylistTracksPanel({
  label = "Tracks",
  tracks,
  loading,
  error,
  activityHint = null,
  emptyMessage = "No tracks generated for this flow yet.",
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
  showTrackAvailability = false,
  artworkByAlbumMbid = {},
  allowBulkEdit = false,
  onBulkDelete,
  onBulkAddToPlaylist,
  bulkAddLabel = "Copy",
  onBulkAddToLibrary,
  onBulkMoveToPlaylist,
  bulkActionLoading = false,
}) {
  const [sortKey, setSortKey] = useState("index");
  const [sortDirection, setSortDirection] = useState("asc");
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const trackOrderKey = useMemo(() => tracks.map((track) => track.id).join("\n"), [tracks]);

  useEffect(() => {
    setSortKey("index");
    setSortDirection("asc");
    setEditMode(false);
    setSelectedIds(new Set());
  }, [trackOrderKey]);

  const { playTrack, togglePlayPause, matchesSource, isPlaying, isLoading, isStarting, currentTrack } =
    useAudioQueue();
  const isRunning = isPlaying || isStarting;
  const getQueueItems = useQueueTrackActions();

  const sortedTracks = useMemo(
    () => sortPlaylistTracks(tracks, sortKey, sortDirection),
    [tracks, sortKey, sortDirection],
  );
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
  const playableTracks = useMemo(
    () => sortedTracks.filter((track) => track.status === "done" && track.streamUrl),
    [sortedTracks],
  );
  const isSourceActive = matchesSource(playbackSource);
  const currentTrackId = isSourceActive && currentTrack?.id ? currentTrack.id : null;

  const handleSort = (nextSortKey) => {
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

  const trackCover = (track) =>
    track.artworkUrl || track.coverUrl || artworkByAlbumMbid[String(track.albumMbid || "")] || "";
  const toQueueTrack = (track) =>
    normalizePlaylistQueueTrack({ ...track, artworkUrl: trackCover(track) }, { recordHistory });

  const handlePlayTrack = (track) => {
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

  const rows = sortedTracks.map((track, index) => {
    const canPlay = showPlaybackControls && track.status === "done" && Boolean(track.streamUrl);
    const searchAction = getTrackSearchAction(track, showTrackAvailability);
    const canReSearch = typeof onReSearchTrack === "function" && Boolean(track.id) && searchAction !== null;
    const canManualReSearch =
      typeof onReSearchTrack === "function" &&
      track.status === "done" &&
      track.qualityOwned === true &&
      !activeReplacementTrackIds.has(String(track.id));
    const availability = showTrackAvailability ? getTrackAvailability(track) : null;
    const isCurrent = track.id === currentTrackId;
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
          onAddTrackToPlaylist: onAddTrackToPlaylist ? (target) => onAddTrackToPlaylist(track, target) : null,
          onMoveTrackToPlaylist: onMoveTrackToPlaylist ? (target) => onMoveTrackToPlaylist(track, target) : null,
        }
      : null;
    return {
      key: track.id,
      number: getPlaylistTrackDisplayNumber(track, {
        tracks,
        sortedTracks,
        sortedIndex: index,
        sortKey,
        sortDirection,
      }),
      title: track.trackName,
      subtitle: track.artistName,
      artist: {
        label: track.artistName,
        ...artistLink,
        onOpen: canOpenArtist ? () => onNavigateArtist(track) : null,
      },
      album: {
        label: track.albumName || "",
        ...albumLink,
        onOpen: canOpenAlbum ? () => onNavigateAlbum(track) : null,
      },
      cover: {
        src: trackCover(track),
        label: track.albumName || track.trackName,
        ...albumLink,
        onOpen: canOpenAlbum ? () => onNavigateAlbum(track) : null,
      },
      time: formatTrackDuration(track.durationMs),
      active: isCurrent,
      playing: isCurrent && isRunning,
      loading: isCurrent && isLoading,
      missing: showPlaybackControls && !canPlay,
      onPlay: showPlaybackControls ? () => handlePlayTrack(track) : null,
      playDisabled: !canPlay,
      badge: availability ? (
        <TooltipButton className="flow-page__track-availability-indicator" label={availability.label}>
          <span
            className={`flow-page__track-status-dot flow-page__track-status-dot--${availability.status}`}
            aria-hidden="true"
          />
        </TooltipButton>
      ) : showTrackStatus ? (
        <TrackStatusDot status={track.status} />
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
          onAddToLibrary={onAddTrackToLibrary}
          isAddingToLibrary={libraryTrackSavingKey === String(track.id)}
          isFavorite={favoriteTrackIds.has(trackFavoriteId)}
          isFavoritePending={favoriteTrackSavingKey === trackFavoriteId}
          onToggleFavorite={trackFavoriteId ? onToggleFavorite : null}
          onNavigateAlbum={onNavigateAlbum}
          onNavigateArtist={onNavigateArtist}
          canReSearch={canReSearch}
          canManualReSearch={canManualReSearch}
          searchAction={searchAction}
          isReSearching={reSearchingTrackIds[track.id] === true}
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
      {allowBulkEdit && tracks.length > 0 ? (
        <div className="collection-tracks__toolbar">
          {editMode ? (
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
        <div className="native-library-state" role="status">
          <DotLoader size="lg" label={null} />
          <span>Loading tracks…</span>
        </div>
      ) : error ? (
        <div className="native-library-state" role="alert">
          <strong>Tracks unavailable</strong>
          <span>{error}</span>
        </div>
      ) : tracks.length === 0 ? (
        <div className="native-library-state" role={activityHint ? "status" : undefined}>
          {activityHint ? <DotLoader size="sm" label={null} /> : null}
          <span>{activityHint || emptyMessage}</span>
        </div>
      ) : (
        <TrackList
          label={label}
          rows={rows}
          sort={{ key: sortKey, direction: sortDirection, onSort: handleSort }}
          selection={
            editMode
              ? {
                  allSelected: selectedCount > 0 && selectedCount === sortedTracks.length,
                  onToggleAll: () =>
                    setSelectedIds(
                      selectedCount === sortedTracks.length
                        ? new Set()
                        : new Set(sortedTracks.map((track) => track.id)),
                    ),
                }
              : null
          }
        />
      )}
    </div>
  );
}
