import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  ExternalLink,
  Heart,
  Loader2,
  ListMusic,
  Play,
  Pause,
  Shuffle,
  Search,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Pencil,
  UserRound,
} from "lucide-react";
import { getFlowTrackDisplayNumber, sortFlowTracks } from "../../../utils/flowTrackSort";
import { Link } from "react-router-dom";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizeFlowTrack } from "../../../utils/audioQueue";
import { TrackPlaylistMenu, TrackPlaylistSubmenu } from "../../ArtistDetails/components/TrackPlaylistMenu";
import { LibraryItemMenu } from "../../../components/LibraryItemMenu";
import { PlaylistArtworkThumb } from "./PlaylistArtworkThumb.jsx";

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

function getTrackQualityMeta(track) {
  if (track?.status !== "done") return { label: "—", state: "" };
  let label = track.qualityLabel || "Unknown";
  if (track.qualityFormat === "flac" && track.qualityBitDepth && track.qualitySampleRate) {
    label = `FLAC ${track.qualityBitDepth}/${track.qualitySampleRate / 1000}`;
  } else if (track.qualityFormat && track.qualityBitrateKbps) {
    label = `${track.qualityFormat.toUpperCase()} ${track.qualityBitrateKbps}`;
  }
  const state = track.externalPath ? "Lidarr" : ({
    preferred: "Preferred",
    upgrade: "Upgrade",
    "below-floor": "Below floor",
    external: "External",
  }[track.qualityState] || "");
  return { label, state };
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

function FlowTrackPlaylistMenus({
  track,
  useTrackContextMenu,
  playlistTriggerVariant = "compact",
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistMenuError,
  excludedPlaylistIds,
  getDefaultPlaylistName,
  onLoadPlaylists,
  onAddTrackToPlaylist,
  onMoveTrackToPlaylist,
  children,
}) {
  const canUsePlaylistMenus =
    track?.artistName &&
    track?.trackName &&
    (onAddTrackToPlaylist || onMoveTrackToPlaylist);
  const saving = playlistSavingKey === String(track?.id || "");
  const defaultNewPlaylistName =
    getDefaultPlaylistName?.(track) || "Playlist";
  const sharedMenuProps = {
    track,
    playlists,
    loading: playlistsLoading,
    saving,
    error: playlistMenuError,
    defaultNewPlaylistName,
    excludedPlaylistIds,
    onLoadPlaylists,
  };

  if (!canUsePlaylistMenus) {
    return typeof children === "function" ? children() : children;
  }

  if (useTrackContextMenu) {
    return children({
      playlistMenuProps: {
        ...sharedMenuProps,
        onAddTrackToPlaylist: onAddTrackToPlaylist
          ? (target) => onAddTrackToPlaylist(track, target)
          : null,
        onMoveTrackToPlaylist: onMoveTrackToPlaylist
          ? (target) => onMoveTrackToPlaylist(track, target)
          : null,
      },
    });
  }

  return (
    <>
      {onAddTrackToPlaylist ? (
        <TrackPlaylistMenu
          {...sharedMenuProps}
          triggerVariant={playlistTriggerVariant}
          onSelect={(target) => onAddTrackToPlaylist(track, target)}
        />
      ) : null}
      {typeof children === "function" ? children() : children}
    </>
  );
}


function FlowTrackKebabMenu({
  track,
  canPlay = false,
  isPlaying = false,
  onPlay,
  onAddToLibrary,
  isAddingToLibrary = false,
  isFavorite = false,
  isFavoritePending = false,
  onToggleFavorite,
  onNavigateAlbum,
  onNavigateArtist,
  canReSearch,
  isReSearching,
  canDelete,
  isDeleting,
  onReSearch,
  onDelete,
  playlistMenuProps = null,
}) {
  const [openSubmenu, setOpenSubmenu] = useState(null);
  const trackLabel = track?.trackName || "track";
  const canNavigateAlbum = Boolean(track?.albumMbid && onNavigateAlbum);
  const canNavigateArtist = Boolean(track?.artistMbid && onNavigateArtist);
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
    onAddToLibrary
      ? {
          id: "add-library",
          label: "Add to library",
          icon: Plus,
          disabled: isAddingToLibrary,
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
          label: track.status === "done" ? "Search for upgrade" : "Re-search",
          icon: Search,
          disabled: isReSearching,
          onSelect: () => onReSearch?.(track),
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
  const additionalItemsAfter = onAddToLibrary
    ? "add-library"
    : canReSearch
      ? "re-search"
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
    <span
      className={`flow-page__track-status-dot ${meta.className}`}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    />
  );
}


function FlowTracksSortHeader({
  label,
  sortKey,
  activeSortKey,
  sortDirection,
  onSort,
  className = "",
}) {
  const active = activeSortKey === sortKey;
  const DirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
  const ariaSort = active
    ? sortDirection === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th className={className} scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className={`flow-page__tracks-sort-button${active ? " is-active" : ""}`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {active ? (
          <DirectionIcon className="artist-icon-xs" aria-hidden="true" />
        ) : null}
      </button>
    </th>
  );
}


export function FlowTracksPanel({
  tracks,
  loading,
  error,
  activityHint = null,
  emptyMessage = "No tracks generated for this flow yet.",
  deletingTrackId = null,
  reSearchingTrackIds = {},
  useTrackContextMenu = false,
  playlistTriggerVariant = "compact",
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
  libraryTrackSavingKey = "",
  getTrackFavoriteId,
  favoriteTrackIds = new Set(),
  favoriteTrackSavingKey = "",
  onToggleFavorite,
  onNavigateArtist,
  onNavigateAlbum,
  onReSearchTrack,
  playbackSource = null,
  showPlaybackControls = true,
  trackTitleLabel = "Song",
  showTrackArtwork = false,
  artworkByAlbumMbid = {},
  showDuration = false,
  hideAlbumColumn = false,
  hideStatusColumn = false,
  hideQualityColumn = false,
  allowBulkEdit = false,
  onBulkDelete,
  onBulkReSearch,
  onBulkAddToPlaylist,
  onBulkMoveToPlaylist,
  bulkActionLoading = false,
}) {
  const [sortKey, setSortKey] = useState("index");
  const [sortDirection, setSortDirection] = useState("asc");
  const trackOrderKey = useMemo(
    () => tracks.map((track) => track.id).join("\n"),
    [tracks],
  );

  useEffect(() => {
    setSortKey("index");
    setSortDirection("asc");
  }, [trackOrderKey]);

  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    setEditMode(false);
    setSelectedIds(new Set());
  }, [trackOrderKey]);

  const {
    playQueue,
    playTrack,
    togglePlayPause,
    isShuffleEnabled,
    matchesSource,
    isPlaying,
    currentTrack: activeTrack,
  } = useAudioQueue();

  const sortedTracks = useMemo(
    () => sortFlowTracks(tracks, sortKey, sortDirection),
    [tracks, sortKey, sortDirection],
  );

  const selectedCount = selectedIds.size;
  const allSelected = tracks.length > 0 && selectedCount === sortedTracks.length;

  const selectedTracks = useMemo(
    () => sortedTracks.filter((t) => selectedIds.has(t.id)),
    [sortedTracks, selectedIds],
  );

  const handleToggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedTracks.map((t) => t.id)));
    }
  };

  const handleToggleTrack = (trackId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const handleExitEditMode = () => {
    setEditMode(false);
    setSelectedIds(new Set());
  };

  const playableTracks = useMemo(
    () =>
      sortedTracks.filter(
        (track) => track.status === "done" && track.streamUrl,
      ),
    [sortedTracks],
  );

  const handleSort = (nextSortKey) => {
    if (sortKey === nextSortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextSortKey);
    setSortDirection("asc");
  };

  const isSourceActive = matchesSource(playbackSource);
  const recordHistory = playbackSource?.recordHistory !== false;
  const currentTrackId =
    isSourceActive && activeTrack?.id ? activeTrack.id : null;
  const isCurrentPlaying = isSourceActive && isPlaying;

  const isPlaylistPlaying = isSourceActive && isCurrentPlaying;

  const handlePrimaryPlay = () => {
    if (playableTracks.length === 0) return;
    if (isSourceActive && (isPlaying || currentTrackId)) {
      togglePlayPause();
      return;
    }
    const queueTracks = playableTracks.map((track) =>
      normalizeFlowTrack(track, { recordHistory }),
    );
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: false,
    });
  };

  const handleShufflePlay = () => {
    if (playableTracks.length === 0) return;
    const queueTracks = playableTracks.map((track) =>
      normalizeFlowTrack(track, { recordHistory }),
    );
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: true,
    });
  };

  const handlePlayTrack = (track) => {
    if (!track?.streamUrl) return;
    const normalized = normalizeFlowTrack(track, { recordHistory });
    if (currentTrackId === track.id && isSourceActive) {
      togglePlayPause();
      return;
    }
    playTrack(normalized, {
      source: playbackSource,
      queue: playableTracks.map((entry) =>
        normalizeFlowTrack(entry, { recordHistory }),
      ),
      shuffle: isShuffleEnabled,
    });
  };

  return (
    <div className="flow-page__tracks">
      {showPlaybackControls || allowBulkEdit ? (
        <div className="flow-page__tracks-toolbar">
          {showPlaybackControls ? (
            <div className="flow-page__tracks-toolbar-start">
              <button
                type="button"
                onClick={handlePrimaryPlay}
                className="btn btn-accent btn-round-lg"
                disabled={playableTracks.length === 0}
                aria-label={
                  isPlaylistPlaying ? "Pause playback" : "Play all tracks"
                }
                title={isPlaylistPlaying ? "Pause playback" : "Play all tracks"}
              >
                {isPlaylistPlaying ? (
                  <Pause className="artist-icon-md" />
                ) : (
                  <Play className="artist-icon-md" />
                )}
              </button>
              <button
                type="button"
                onClick={handleShufflePlay}
                className={`btn btn-secondary btn-round-lg flow-page__tracks-toolbar-shuffle${isShuffleEnabled ? " is-active" : ""}`}
                disabled={playableTracks.length === 0}
                aria-label="Shuffle and play"
                title="Shuffle and play"
              >
                <Shuffle className="artist-icon-md" />
              </button>
            </div>
          ) : null}
          <div className="flow-page__tracks-toolbar-actions">
            {editMode ? (
              <>
                {selectedCount > 0 ? (
                  <span className="flow-page__bulk-count">
                    {selectedCount} selected
                  </span>
                ) : null}
                {onBulkDelete ? (
                  <button
                    type="button"
                    onClick={() => onBulkDelete(selectedTracks)}
                    className="btn btn-ghost-danger btn-icon btn-sm"
                    disabled={bulkActionLoading || !selectedCount}
                    aria-label="Remove selected"
                    title="Remove selected"
                  >
                    <Trash2 className="artist-icon-sm" />
                  </button>
                ) : null}
                {onBulkReSearch ? (
                  <button
                    type="button"
                    onClick={() => onBulkReSearch(selectedTracks)}
                    className="btn btn-secondary btn-sm"
                    disabled={bulkActionLoading || !selectedCount}
                  >
                    <Search className="artist-icon-sm" />
                    <span>Re-search</span>
                  </button>
                ) : null}
                {onBulkAddToPlaylist ? (
                  <BulkPlaylistAction
                    icon={Plus}
                    label="Copy"
                    track={selectedTracks[0]}
                    playlists={playlists}
                    loading={playlistsLoading}
                    saving={bulkActionLoading}
                    disabled={!selectedCount || bulkActionLoading}
                    error={playlistMenuError}
                    defaultNewPlaylistName={
                      getDefaultPlaylistName?.(selectedTracks[0]) || "Playlist"
                    }
                    excludedPlaylistIds={excludedPlaylistIds}
                    onSelect={(target) => {
                      onBulkAddToPlaylist(selectedTracks, target);
                      handleExitEditMode();
                    }}
                  />
                ) : null}
                {onBulkMoveToPlaylist ? (
                  <BulkPlaylistAction
                    icon={ListMusic}
                    label="Move"
                    track={selectedTracks[0]}
                    playlists={playlists}
                    loading={playlistsLoading}
                    saving={bulkActionLoading}
                    disabled={!selectedCount || bulkActionLoading}
                    error={playlistMenuError}
                    defaultNewPlaylistName={
                      getDefaultPlaylistName?.(selectedTracks[0]) || "Playlist"
                    }
                    excludedPlaylistIds={excludedPlaylistIds}
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
              <>
                {allowBulkEdit ? (
                  <button
                    type="button"
                    onClick={() => setEditMode(true)}
                    className="btn btn-secondary btn-icon btn-sm"
                    aria-label="Edit tracks"
                    title="Edit tracks"
                  >
                    <Pencil className="artist-icon-sm" />
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      <div className="flow-page__tracks-body">
        {loading && (
          <div className="flow-page__tracks-loading">
            <Loader2 className="artist-icon-sm animate-spin" />
            Loading tracks...
          </div>
        )}
        {!loading && error && (
          <div className="flow-page__tracks-error">{error}</div>
        )}
        {!loading && !error && tracks.length === 0 && (
          <div className="flow-page__tracks-empty">
            {activityHint ? (
              <>
                <Loader2 className="artist-icon-sm animate-spin" />
                <span>{activityHint}</span>
              </>
            ) : (
              emptyMessage
            )}
          </div>
        )}
        {!loading && !error && tracks.length > 0 && (
          <table
            className={`flow-page__tracks-table${hideAlbumColumn ? " flow-page__tracks-table--no-album" : ""}`}
          >
            <thead className="flow-page__tracks-table-head">
              <tr>
                {editMode ? (
                  <th className="flow-page__tracks-table-index flow-page__tracks-table-checkbox-head" scope="col">
                    <input
                      type="checkbox"
                      className="flow-page__tracks-table-checkbox"
                      checked={allSelected}
                      onChange={handleToggleSelectAll}
                      aria-label="Select all tracks"
                    />
                  </th>
                ) : (
                  <FlowTracksSortHeader
                    label="#"
                    sortKey="index"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-index"
                  />
                )}
                {showTrackArtwork ? (
                  <th className="flow-page__tracks-table-artwork" aria-hidden="true" />
                ) : null}
                <FlowTracksSortHeader
                  label={trackTitleLabel}
                  sortKey="song"
                  activeSortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="flow-page__tracks-table-song"
                />
                <FlowTracksSortHeader
                  label="Artist"
                  sortKey="artist"
                  activeSortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="flow-page__tracks-table-artist"
                />
                {hideAlbumColumn ? null : (
                  <FlowTracksSortHeader
                    label="Album"
                    sortKey="album"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-album"
                  />
                )}
                {showDuration ? (
                  <th className="flow-page__tracks-table-duration" scope="col">
                    Time
                  </th>
                ) : null}
                {hideStatusColumn ? null : (
                  <FlowTracksSortHeader
                    label={<span className="sr-only">Status</span>}
                    sortKey="status"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-status-head"
                  />
                )}
                {hideQualityColumn ? null : (
                  <th className="flow-page__tracks-table-quality-head" scope="col">
                    Quality
                  </th>
                )}
                <th
                  className="flow-page__tracks-table-actions-head"
                  aria-hidden="true"
                />
              </tr>
            </thead>
            <tbody>
              {sortedTracks.map((track, index) => {
                const trackDisplayNumber = getFlowTrackDisplayNumber(track, {
                  tracks,
                  sortedTracks,
                  sortedIndex: index,
                  sortKey,
                  sortDirection,
                });
                const canPlay =
                  showPlaybackControls &&
                  track.status === "done" &&
                  !!track.streamUrl;
                const canDelete =
                  typeof onDeleteTrack === "function" && !!track.id;
                const canReSearch =
                  typeof onReSearchTrack === "function" &&
                  !!track.id &&
                  (track.status === "failed" ||
                    track.status === "done" &&
                      track.qualityOwned === true &&
                      track.qualityState !== "preferred");
                const isReSearching = reSearchingTrackIds[track.id] === true;
                const isDeleting = deletingTrackId === track.id;
                const isCurrent = track.id === currentTrackId && isCurrentPlaying;
                const trackFavoriteId = getTrackFavoriteId?.(track) || "";
                const quality = hideQualityColumn ? null : getTrackQualityMeta(track);
                const artworkUrl =
                  track.artworkUrl ||
                  track.coverUrl ||
                  artworkByAlbumMbid[String(track.albumMbid || "")] ||
                  "";
                return (
                  <tr
                    key={track.id}
                    className={`flow-page__tracks-table-row${isCurrent ? " is-current" : ""}`}
                    data-library-menu-target={useTrackContextMenu ? "true" : undefined}
                  >
                    <td className="flow-page__tracks-table-index">
                      {editMode ? (
                        <div className="flow-page__tracks-table-index-inner">
                          <input
                            type="checkbox"
                            className="flow-page__tracks-table-checkbox"
                            checked={selectedIds.has(track.id)}
                            onChange={() => handleToggleTrack(track.id)}
                            aria-label={`Select ${track.trackName}`}
                          />
                        </div>
                      ) : showPlaybackControls ? (
                        <div className="flow-page__tracks-table-index-inner">
                          <span className="flow-page__tracks-table-index-number">
                            {trackDisplayNumber}
                          </span>
                          <button
                            type="button"
                            onClick={() => handlePlayTrack(track)}
                            className="flow-page__tracks-table-index-play btn btn-secondary btn-icon btn-xs"
                            disabled={!canPlay}
                            aria-label={
                              isCurrent
                                ? `Pause ${track.trackName}`
                                : `Play ${track.trackName}`
                            }
                            title={
                              isCurrent
                                ? `Pause ${track.trackName}`
                                : `Play ${track.trackName}`
                            }
                          >
                            {isCurrent ? (
                              <Pause className="artist-icon-xs" />
                            ) : (
                              <Play className="artist-icon-xs" />
                            )}
                          </button>
                        </div>
                      ) : (
                        trackDisplayNumber
                      )}
                    </td>
                    {showTrackArtwork ? (
                      <td className="flow-page__tracks-table-artwork">
                        <PlaylistArtworkThumb
                          artworkUrl={artworkUrl}
                          name={track.albumName || track.trackName}
                          className="flow-page__tracks-table-artwork-thumb"
                        />
                      </td>
                    ) : null}
                    <td
                      className="flow-page__tracks-table-song"
                      title={track.trackName}
                    >
                      <span className="flow-page__tracks-table-cell-text">
                        {track.trackName}
                      </span>
                    </td>
                    <td
                      className="flow-page__tracks-table-artist"
                      title={track.artistName}
                    >
                      {track.artistMbid ? (
                        <button
                          type="button"
                          onClick={() => onNavigateArtist(track)}
                          className="flow-page__tracks-artist-link"
                        >
                          {track.artistName}
                        </button>
                      ) : (
                        <span className="flow-page__tracks-table-cell-text">
                          {track.artistName}
                        </span>
                      )}
                    </td>
                    {hideAlbumColumn ? null : (
                      <td
                        className="flow-page__tracks-table-album"
                        title={track.albumName || "Unknown Album"}
                      >
                        {track.albumMbid && typeof onNavigateAlbum === "function" ? (
                          <button
                            type="button"
                            onClick={() => onNavigateAlbum(track)}
                            className="flow-page__tracks-album-link"
                          >
                            {track.albumName || "Unknown Album"}
                          </button>
                        ) : (
                          <span className="flow-page__tracks-table-cell-text">
                            {track.albumName || "Unknown Album"}
                          </span>
                        )}
                      </td>
                    )}
                    {showDuration ? (
                      <td className="flow-page__tracks-table-duration">
                        {formatTrackDuration(track.durationMs)}
                      </td>
                    ) : null}
                    {hideStatusColumn ? null : (
                      <td className="flow-page__tracks-table-status-cell">
                        <TrackStatusDot status={track.status} />
                      </td>
                    )}
                    {hideQualityColumn ? null : (
                      <td className="flow-page__tracks-table-quality-cell">
                        <span className="flow-page__tracks-table-cell-text">{quality.label}</span>
                        {quality.state ? (
                          <span className={`flow-page__quality-state flow-page__quality-state--${track.qualityState}`}>
                            {quality.state}
                          </span>
                        ) : null}
                      </td>
                    )}
                    <td className="flow-page__tracks-table-actions-cell">
                      {editMode ? null : (
                      <div className="flow-page__tracks-actions">
                        <FlowTrackPlaylistMenus
                          track={track}
                          useTrackContextMenu={useTrackContextMenu}
                          playlistTriggerVariant={playlistTriggerVariant}
                          playlists={playlists}
                          playlistsLoading={playlistsLoading}
                          playlistSavingKey={playlistSavingKey}
                          playlistMenuError={playlistMenuError}
                          excludedPlaylistIds={excludedPlaylistIds}
                          getDefaultPlaylistName={getDefaultPlaylistName}
                          onLoadPlaylists={onLoadPlaylists}
                          onAddTrackToPlaylist={onAddTrackToPlaylist}
                          onMoveTrackToPlaylist={onMoveTrackToPlaylist}
                        >
                          {(playlistMenuHandlers) =>
                            useTrackContextMenu ? (
                              <FlowTrackKebabMenu
                                track={track}
                                canPlay={canPlay}
                                isPlaying={isCurrent}
                                onPlay={handlePlayTrack}
                                onAddToLibrary={onAddTrackToLibrary}
                                isAddingToLibrary={libraryTrackSavingKey === String(track.id)}
                                isFavorite={favoriteTrackIds.has(trackFavoriteId)}
                                isFavoritePending={favoriteTrackSavingKey === trackFavoriteId}
                                onToggleFavorite={onToggleFavorite}
                                onNavigateAlbum={onNavigateAlbum}
                                onNavigateArtist={onNavigateArtist}
                                canReSearch={canReSearch}
                                isReSearching={isReSearching}
                                canDelete={canDelete}
                                isDeleting={isDeleting}
                                onReSearch={onReSearchTrack}
                                onDelete={onDeleteTrack}
                                playlistMenuProps={
                                  playlistMenuHandlers?.playlistMenuProps
                                }
                              />
                            ) : (
                              <>
                                {canReSearch ? (
                                  <button
                                    type="button"
                                    onClick={() => onReSearchTrack(track)}
                                    className="btn btn-secondary btn-icon btn-xs"
                                    aria-label={`${track.status === "done" ? "Search for an upgrade to" : "Re-search"} ${track.trackName}`}
                                    title={`${track.status === "done" ? "Search for an upgrade to" : "Re-search"} ${track.trackName}`}
                                    disabled={isReSearching}
                                  >
                                    {isReSearching ? (
                                      <Loader2 className="artist-icon-xs animate-spin" />
                                    ) : (
                                      <Search className="artist-icon-xs" />
                                    )}
                                  </button>
                                ) : null}
                                {canDelete ? (
                                  <button
                                    type="button"
                                    onClick={() => onDeleteTrack?.(track)}
                                    className="btn btn-ghost-danger btn-icon btn-xs"
                                    aria-label={`Remove ${track.trackName} from playlist`}
                                    title={`Remove ${track.trackName} from playlist`}
                                    disabled={isDeleting}
                                  >
                                    {isDeleting ? (
                                      <Loader2 className="artist-icon-xs animate-spin" />
                                    ) : (
                                      <Trash2 className="artist-icon-xs" />
                                    )}
                                  </button>
                                ) : null}
                              </>
                            )
                          }
                        </FlowTrackPlaylistMenus>
                      </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
