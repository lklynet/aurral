import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Clock, Download, Pencil, RefreshCw, Share, Trash2 } from "../../components/icons";
import { useShareAction } from "../../hooks/useShareAction.ts";
import { DotLoader } from "../../components/DotLoader";
import {
  SkeletonCollectionHeader,
  SkeletonCollectionTracks,
  SkeletonStatus,
} from "../../components/Skeletons";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../../components/CollectionHeader";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import TooltipButton from "../../components/TooltipButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  deleteStaticPlaylist,
  setPlaylistRecordHistory,
  setPlaylistTrackAvailability,
  syncStaticPlaylistImport,
  updateStaticPlaylist,
} from "../../utils/api/endpoints/playlists.ts";
import { getApiErrorMessage } from "../onboardingUtils.tsx";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.tsx";
import { getStaticPlaylistTrackCount } from "./playlistStats";
import { PlaylistEditModal } from "./PlaylistEditModal.tsx";
import { PlaylistTracks } from "./PlaylistTracks.tsx";
import { usePlaylistTrackPlayback } from "./components/playlistTrackComponents.tsx";
import {
  SYNC_INTERVAL_OPTIONS,
  SYNCABLE_IMPORT_PROVIDERS,
  exportPlaylistTracklist,
  formatTrackTotal,
  getImportedProviderLabel,
  choiceMenuItem,
  optionMenuItem,
  usePlaylistArtwork,
  usePlaylistTracks,
} from "./playlistPageUtils";
import { countAvailableTracks } from "./trackAvailability.ts";
import { usePlaylistStatus } from "./usePlaylistStatus";
import { useHiddenPlaylistTracks } from "./usePlaylistBulkActions.ts";
import type { PlaylistStats, PlaylistStatus, StaticPlaylist } from "./playlistStats.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getApiErrorText } from "../onboardingUtils.tsx";

interface PlaylistDetailProps {
  playlist: StaticPlaylist;
  stats: PlaylistStats;
  staticPlaylists: StaticPlaylist[];
  fetchStatus: () => Promise<unknown>;
}

function updateCachedPlaylist(playlistId: string, changes: Partial<StaticPlaylist>) {
  queryClient.setQueryData<PlaylistStatus>(queryKeys.playlistStatus, (current) =>
    current
      ? {
          ...current,
          sharedPlaylists: current.sharedPlaylists.map((playlist) =>
            playlist.id === playlistId ? { ...playlist, ...changes } : playlist,
          ),
        }
      : current,
  );
}

export default function PlaylistDetailPage() {
  const { playlistId } = useParams();
  const location = useLocation();
  const { status, loading, error, fetchStatus, getPlaylistStats, staticPlaylists } =
    usePlaylistStatus();
  const playlist = staticPlaylists.find((entry) => entry.id === playlistId) || null;
  useDocumentTitle(playlist?.name || "Playlist");

  if (!playlist) {
    const waiting = (loading && !status) || location.state?.created;
    return (
      <div className="library-page native-library-page playlist-page">
        <div className="native-library-content">
          {waiting ? (
            <SkeletonStatus label="Loading playlist" className="native-library-detail">
              <SkeletonCollectionHeader />
              <SkeletonCollectionTracks />
            </SkeletonStatus>
          ) : error && !status ? (
            <div className="native-library-state" role="alert">
              <strong>Playlist unavailable</strong>
              <span>Aurral could not load this playlist.</span>
              <button type="button" className="native-library-state__action" onClick={fetchStatus}>
                Retry
              </button>
            </div>
          ) : (
            <div className="native-library-state">
              <strong>Playlist not found</strong>
              <span>It may have been deleted.</span>
              <Link to="/library/playlists" className="native-library-state__action">
                Back to playlists
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <PlaylistDetail
      key={playlist.id}
      playlist={playlist}
      stats={getPlaylistStats(playlist.id)}
      staticPlaylists={staticPlaylists}
      fetchStatus={fetchStatus}
    />
  );
}

function PlaylistDetail({ playlist, stats, staticPlaylists, fetchStatus }: PlaylistDetailProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { artworkUrlFor } = usePlaylistArtwork();
  const share = useShareAction();
  const showTrackAvailability = playlist.showTrackAvailability === true;
  const {
    tracks: savedTracks,
    loading,
    error,
    refresh,
  } = usePlaylistTracks(playlist.id, {
    pollAvailability: showTrackAvailability,
  });
  const hiddenTrackIds = useHiddenPlaylistTracks().get(playlist.id);
  const tracks = useMemo(
    () =>
      hiddenTrackIds ? savedTracks.filter((track) => !hiddenTrackIds.has(track.id)) : savedTracks,
    [hiddenTrackIds, savedTracks],
  );
  const playbackSource = {
    type: "playlist",
    id: playlist.id,
    label: playlist.name || "Playlist",
    recordHistory: playlist.recordHistory !== false,
  };
  const playback = usePlaylistTrackPlayback({ tracks, playbackSource });
  const [editOpen, setEditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const importSource = playlist.importSource || null;
  const isSyncable = SYNCABLE_IMPORT_PROVIDERS.has(importSource?.provider);
  const providerLabel = isSyncable ? getImportedProviderLabel(importSource!.provider) : "";
  const totalTracks = Math.max(
    0,
    getStaticPlaylistTrackCount(playlist, stats, savedTracks.length) -
      (savedTracks.length - tracks.length),
  );
  const trackLabel =
    showTrackAvailability && !loading && !error
      ? `${countAvailableTracks(tracks)}/${totalTracks} available`
      : formatTrackTotal(totalTracks);
  const owner = playlist.ownerUsername || user?.username || null;
  const syncInterval = importSource?.syncIntervalHours ?? 0;
  const metaParts = [owner, trackLabel];
  if (isSyncable) {
    metaParts.push(
      importSource?.syncEnabled === true
        ? `Synced from ${providerLabel}`
        : `Imported from ${providerLabel}`,
    );
  }

  const handleRename = async (name: string) => {
    setRenaming(true);
    setRenameError("");
    try {
      await updateStaticPlaylist(playlist.id, { name: String(name ?? "").trim() });
      showSuccess("Playlist renamed");
      await fetchStatus();
      setEditOpen(false);
    } catch (err) {
      const message =
        getApiErrorText(err, "message") || asApiError(err)?.message || "Failed to rename playlist";
      setRenameError(message);
      showError(message);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteStaticPlaylist(playlist.id);
      showSuccess(
        result?.queued ? `Removal of ${playlist.name} queued` : `Deleted ${playlist.name}`,
      );
      await fetchStatus();
      navigate("/library/playlists", { replace: true });
    } catch (err) {
      showError(
        getApiErrorText(err, "message") || asApiError(err)?.message || "Failed to delete playlist",
      );
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncStaticPlaylistImport(playlist.id);
      if (result?.skipped) {
        showSuccess("Playlist is already up to date");
      } else {
        const queued = Number(result?.tracksQueued || 0);
        showSuccess(
          queued > 0
            ? `Synced ${queued} new track${queued === 1 ? "" : "s"} from ${providerLabel}`
            : `${providerLabel} playlist synced`,
        );
      }
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to sync playlist"));
    } finally {
      setSyncing(false);
    }
  };

  const handleExport = async () => {
    try {
      exportPlaylistTracklist(playlist, tracks);
      showSuccess(`Exported ${playlist.name} tracklist`);
    } catch (err) {
      showError(asApiError(err)?.message || "Failed to export tracklist");
    }
  };

  const saveSetting = async (
    action: () => Promise<void>,
    successMessage: string,
    fallbackMessage: string,
  ) => {
    try {
      await action();
      showSuccess(successMessage);
    } catch (err) {
      showError(getApiErrorMessage(err, fallbackMessage));
    }
  };

  const updateSyncInterval = (hours: number) =>
    saveSetting(
      async () => {
        await updateStaticPlaylist(playlist.id, {
          importSource: { syncIntervalHours: hours, syncEnabled: hours > 0 },
        });
        await fetchStatus();
      },
      hours > 0 ? "Sync schedule updated" : "Auto-sync turned off",
      "Failed to update sync schedule",
    );

  const updateKeepRemoved = (keepRemovedTracks: boolean) =>
    saveSetting(
      async () => {
        await updateStaticPlaylist(playlist.id, { importSource: { keepRemovedTracks } });
        await fetchStatus();
      },
      keepRemovedTracks
        ? "Removed tracks will stay in the library"
        : "Removed tracks will be deleted when unshared",
      "Failed to update removed-track setting",
    );

  const updateRecordHistory = (enabled: boolean) =>
    saveSetting(
      async () => {
        const result = await setPlaylistRecordHistory(playlist.id, enabled);
        updateCachedPlaylist(playlist.id, { recordHistory: result.recordHistory });
        await fetchStatus();
      },
      enabled ? "Scrobbling turned on" : "Scrobbling turned off",
      "Failed to update scrobbling setting",
    );

  const updateTrackAvailability = (enabled: boolean) =>
    saveSetting(
      async () => {
        const result = await setPlaylistTrackAvailability(playlist.id, enabled);
        await queryClient.cancelQueries({ queryKey: queryKeys.playlistStatus });
        updateCachedPlaylist(playlist.id, { showTrackAvailability: result.showTrackAvailability });
        if (enabled) await refresh();
      },
      enabled ? "Showing track availability" : "Hiding track availability",
      "Failed to update track availability",
    );

  return (
    <CollectionPage tintSrc={artworkUrlFor(playlist.id)} className="playlist-page">
      <CollectionHeader
        cover={
          <button
            type="button"
            className="playlist-detail__cover"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${playlist.name} details`}
          >
            <PlaylistArtworkThumb artworkUrl={artworkUrlFor(playlist.id)} name={playlist.name} />
          </button>
        }
        corner={
          isSyncable ? (
            <TooltipButton
              className="native-library-icon-button"
              label={syncing ? "Syncing…" : "Sync now"}
              onClick={() => !syncing && handleSync()}
              aria-disabled={syncing}
            >
              {syncing ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
            </TooltipButton>
          ) : null
        }
        kicker="Playlist"
        title={playlist.name}
        meta={metaParts.filter(Boolean).join(" · ")}
        actions={
          <>
            <CollectionPlayButtons
              label={playlist.name}
              disabled={playback.disabled}
              isPlaying={playback.isListPlaying}
              isShuffleEnabled={playback.isShuffleEnabled}
              onPlay={playback.handlePlayAll}
              onShuffle={playback.handleShufflePlay}
            />
            <LibraryItemMenu
              label={playlist.name}
              contextMenu={false}
              items={[
                {
                  id: "share",
                  label: "Share playlist",
                  icon: Share,
                  onSelect: () =>
                    share(
                      { kind: "playlist", playlistId: playlist.id, title: playlist.name },
                      playlist.name,
                    ),
                },
                {
                  id: "edit",
                  label: "Edit details",
                  icon: Pencil,
                  onSelect: () => setEditOpen(true),
                },
                {
                  id: "export",
                  label: "Export tracklist",
                  icon: Download,
                  disabled: tracks.length === 0,
                  onSelect: handleExport,
                },
                ...(isSyncable
                  ? [
                      {
                        id: "auto-sync",
                        label: "Auto-sync",
                        icon: Clock,
                        separatorBefore: true,
                        submenuItems: SYNC_INTERVAL_OPTIONS.map((option) =>
                          choiceMenuItem({
                            id: `sync-${option.value}`,
                            label: option.label,
                            checked: syncInterval === option.value,
                            onSelect: () => updateSyncInterval(option.value),
                          }),
                        ),
                      },
                      optionMenuItem({
                        id: "keep-removed",
                        label: "Keep removed tracks in library",
                        checked: importSource?.keepRemovedTracks !== false,
                        onSelect: () =>
                          updateKeepRemoved(importSource?.keepRemovedTracks === false),
                      }),
                    ]
                  : []),
                optionMenuItem({
                  id: "scrobble",
                  label: "Scrobble tracks",
                  checked: playlist.recordHistory !== false,
                  separatorBefore: !isSyncable,
                  onSelect: () => updateRecordHistory(playlist.recordHistory === false),
                }),
                optionMenuItem({
                  id: "availability",
                  label: "Show track availability",
                  checked: showTrackAvailability,
                  onSelect: () => updateTrackAvailability(!showTrackAvailability),
                }),
                {
                  id: "delete",
                  label: "Delete playlist",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
            />
          </>
        }
      />
      <PlaylistTracks
        entry={playlist}
        kind="shared"
        tracks={tracks}
        loading={loading}
        error={error}
        refresh={refresh}
        staticPlaylists={staticPlaylists}
        fetchStatus={fetchStatus}
        emptyMessage="No tracks yet."
        showTrackAvailability={showTrackAvailability}
        recordHistory={playlist.recordHistory !== false}
      />

      <PlaylistEditModal
        entry={playlist}
        title="Edit playlist"
        open={editOpen}
        saving={renaming}
        error={renameError}
        onClose={() => {
          setRenameError("");
          setEditOpen(false);
        }}
        onRename={handleRename}
      />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${playlist.name}?`}
        body="Deletes this playlist and its associated downloaded files."
        confirmLabel="Delete playlist"
        busyLabel="Deleting…"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </CollectionPage>
  );
}
