import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  Loader2,
  ListMusic,
  Play,
  Pause,
  Shuffle,
  Search,
  MoreHorizontal,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Pencil,
} from "lucide-react";
import { getFlowTrackDisplayNumber, sortFlowTracks } from "../../../utils/flowTrackSort";
import { Link } from "react-router-dom";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizeFlowTrack } from "../../../utils/audioQueue";
import { TrackPlaylistMenu, TrackPlaylistSubmenu } from "../../ArtistDetails/components/TrackPlaylistMenu";

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
  const state = {
    preferred: "Preferred",
    upgrade: "Upgrade",
    "below-floor": "Below floor",
    external: "External",
  }[track.qualityState] || "";
  return { label, state };
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
  canReSearch,
  isReSearching,
  canDelete,
  isDeleting,
  onReSearch,
  onDelete,
  playlistMenuProps = null,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const onLoadPlaylistsRef = useRef(playlistMenuProps?.onLoadPlaylists);
  onLoadPlaylistsRef.current = playlistMenuProps?.onLoadPlaylists;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
        setOpenSubmenu(null);
        setMenuPosition(null);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    onLoadPlaylistsRef.current?.();
  }, [isOpen]);

  const close = () => {
    setIsOpen(false);
    setOpenSubmenu(null);
    setMenuPosition(null);
  };
  const trackLabel = track?.trackName || "track";
  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 216;
      const viewportPadding = 12;
      setMenuPosition({
        top: rect.bottom + 8,
        left: Math.min(
          Math.max(viewportPadding, rect.right - menuWidth),
          window.innerWidth - menuWidth - viewportPadding,
        ),
      });
    }
    setIsOpen(true);
  };

  return (
    <div
      className={`flow-page__track-menu${isOpen ? " is-open" : ""}`}
      ref={menuRef}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (isOpen) {
            close();
            return;
          }
          openMenu();
        }}
        className="btn btn-secondary btn-icon btn-xs flow-page__track-menu-trigger"
        aria-label={`Options for ${trackLabel}`}
        title={`Options for ${trackLabel}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreHorizontal className="artist-icon-xs" />
      </button>
      {isOpen ? (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={close}
            aria-label="Close track menu"
          />
          <div
            className="artist-floating-menu flow-page__track-menu-dropdown"
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
            }}
            role="menu"
          >
            {canReSearch ? (
              <button
                type="button"
                role="menuitem"
                className="artist-menu-item"
                disabled={isReSearching}
                onClick={() => {
                  onReSearch?.(track);
                  close();
                }}
              >
                <span className="artist-menu-item__main">
                  {isReSearching ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <Search className="artist-icon-sm" />
                  )}
                  {track.status === "done" ? "Search for upgrade" : "Re-search"}
                </span>
              </button>
            ) : null}
            {playlistMenuProps?.onAddTrackToPlaylist ? (
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
                onClose={close}
                toggleOnClick
                isOpen={openSubmenu === "add"}
                onToggle={() =>
                  setOpenSubmenu((current) =>
                    current === "add" ? null : "add",
                  )
                }
              />
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
                onClose={close}
                toggleOnClick
                isOpen={openSubmenu === "move"}
                onToggle={() =>
                  setOpenSubmenu((current) =>
                    current === "move" ? null : "move",
                  )
                }
              />
            ) : null}
            {canDelete ? (
              <button
                type="button"
                role="menuitem"
                className="artist-menu-item artist-menu-item--danger"
                disabled={isDeleting}
                onClick={() => {
                  onDelete?.(track);
                  close();
                }}
              >
                <span className="artist-menu-item__main">
                  {isDeleting ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <Trash2 className="artist-icon-sm" />
                  )}
                  Remove from playlist
                </span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}


function TrackStatusDot({ status }) {
  const meta = getTrackStatusMeta(status);
  const normalized = String(status || "").toLowerCase();
  const isLinkable = normalized !== "done";
  if (isLinkable) {
    const targetPath = normalized === "blocked" ? "/activity/review" : "/activity/queue";
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
  onNavigateArtist,
  onReSearchTrack,
  playbackSource = null,
  showPlaybackControls = true,
  hideAlbumColumn = false,
  hideStatusColumn = false,
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
    const queueTracks = playableTracks.map((track) => normalizeFlowTrack(track));
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: false,
    });
  };

  const handleShufflePlay = () => {
    if (playableTracks.length === 0) return;
    const queueTracks = playableTracks.map((track) => normalizeFlowTrack(track));
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: true,
    });
  };

  const handlePlayTrack = (track) => {
    if (!track?.streamUrl) return;
    const normalized = normalizeFlowTrack(track);
    if (currentTrackId === track.id && isSourceActive) {
      togglePlayPause();
      return;
    }
    playTrack(normalized, {
      source: playbackSource,
      queue: playableTracks.map((entry) => normalizeFlowTrack(entry)),
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
                <FlowTracksSortHeader
                  label="Song"
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
                {hideStatusColumn ? null : (
                  <FlowTracksSortHeader
                    label="Status"
                    sortKey="status"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-status-head"
                  />
                )}
                <th className="flow-page__tracks-table-quality-head" scope="col">
                  Quality
                </th>
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
                const quality = getTrackQualityMeta(track);
                return (
                  <tr
                    key={track.id}
                    className={`flow-page__tracks-table-row${isCurrent ? " is-current" : ""}`}
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
                        <span className="flow-page__tracks-table-cell-text">
                          {track.albumName || "Unknown Album"}
                        </span>
                      </td>
                    )}
                    {hideStatusColumn ? null : (
                      <td className="flow-page__tracks-table-status-cell">
                        <TrackStatusDot status={track.status} />
                      </td>
                    )}
                    <td className="flow-page__tracks-table-quality-cell">
                      <span className="flow-page__tracks-table-cell-text">{quality.label}</span>
                      {quality.state ? (
                        <span className={`flow-page__quality-state flow-page__quality-state--${track.qualityState}`}>
                          {quality.state}
                        </span>
                      ) : null}
                    </td>
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
