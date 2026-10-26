import { usePlaylistBulkActions } from "./usePlaylistBulkActions.ts";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  addStaticPlaylistTracks,
  createStaticPlaylist,
  reSearchFlowTrack,
  reSearchStaticPlaylistTrack,
  searchTrackUpgrade,
  uploadPlaylistTrackArtwork,
  setPlaylistTrackArtworkUrl,
  deletePlaylistTrackArtwork,
  getPlaylistTrackArtworkUrl,
} from "../../utils/api/endpoints/playlists.ts";
import { getReleaseGroupCoversBatch } from "../../utils/api/endpoints/artists.ts";
import {
  downloadTrackToLibrary,
  fetchLibraryFavorites,
  updateLibraryFavorites,
  type CustomArtworkResult,
} from "../../utils/api/endpoints/library.ts";
import {
  resolveLibraryAlbumPath,
  resolveLibraryArtistPath,
} from "../../navigation/resolveLinks.ts";
import { useToast } from "../../contexts/ToastContext";
import { showFavoriteRemoved } from "../../utils/favoriteUndo.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  PlaylistTracksPanel,
  type PlaylistTrackTarget,
} from "./components/playlistTrackComponents.tsx";
import { trackCountLabel } from "./playlistTrackChanges.ts";
import ManualMissingSearchModal from "../activity/ManualMissingSearchModal.tsx";
import LibraryInfoModal from "../LibraryInfoModal.tsx";
import ArtworkEditorModal from "../../components/ArtworkEditorModal.tsx";
import { useAuth } from "../../contexts/AuthContext.tsx";
import { useAudioQueue } from "../../contexts/audioQueueContext.ts";
import { getTrackSearchAction } from "./trackAvailability.ts";
import { normalizeNameKey, normalizePlaylistTrackEntry, reserveUniqueName } from "./flowPageUtils";
import type { Flow, StaticPlaylist } from "./playlistStats.ts";
import type { PlaylistTrackRow } from "./playlistPageUtils.ts";
import type { FetchLibraryFavoritesResponse } from "../../../../backend/routes/library/handlers/libraryIndex.ts";
import { getApiErrorMessage } from "../onboardingUtils.tsx";
import { useShareAction } from "../../hooks/useShareAction.ts";

type FavoriteSongs = {
  song?: Pick<FetchLibraryFavoritesResponse["song"][number], "id">[];
};

type ArtworkEditorState = {
  id: string;
  title: string;
  currentArtwork: string;
  hasCustomArtwork: boolean;
  fallbackArtwork: string;
};

interface PlaylistTracksProps {
  entry: Flow | StaticPlaylist;
  kind: "flow" | "shared";
  tracks: PlaylistTrackRow[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  staticPlaylists: StaticPlaylist[];
  fetchStatus: () => Promise<unknown>;
  activityHint?: string | null;
  emptyMessage: string;
  showTrackAvailability?: boolean;
  recordHistory?: boolean;
}

export function PlaylistTracks({
  entry,
  kind,
  tracks,
  loading,
  error,
  refresh,
  staticPlaylists,
  fetchStatus,
  activityHint = null,
  emptyMessage,
  showTrackAvailability = false,
  recordHistory = true,
}: PlaylistTracksProps) {
  const isFlow = kind === "flow";
  const share = useShareAction();
  const bulkActions = usePlaylistBulkActions();
  const { hasPermission } = useAuth();
  const { updateQueueArtwork } = useAudioQueue();
  const navigate = useNavigate();
  const toast = useToast();
  const { showSuccess, showError } = toast;
  const [reSearchingTrackIds, setReSearchingTrackIds] = useState<Record<string, boolean>>({});
  const [manualReplacement, setManualReplacement] = useState<PlaylistTrackRow | null>(null);
  const [trackInfo, setTrackInfo] = useState<{
    kind: "track";
    source: "playlist";
    entity: PlaylistTrackRow;
    trackNumber: number | null;
  } | null>(null);
  const [artworkEditor, setArtworkEditor] = useState<ArtworkEditorState | null>(null);
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [playlistMenuError, setPlaylistMenuError] = useState("");
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");
  const [favoriteTrackSavingKey, setFavoriteTrackSavingKey] = useState("");
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [trackArtworkByAlbumMbid, setTrackArtworkByAlbumMbid] = useState<Record<string, string>>(
    {},
  );
  const canEditArtwork = hasPermission("addAlbum") || hasPermission("changeMonitoring");

  const favoriteQuery = useQuery({
    queryKey: queryKeys.libraryFavorites,
    queryFn: ({ signal }) => fetchLibraryFavorites({ signal }),
    staleTime: 30_000,
  });
  const favoriteTrackIds = useMemo(
    () =>
      new Set(
        (Array.isArray(favoriteQuery.data?.song) ? favoriteQuery.data.song : [])
          .map((favorite) => String(favorite?.id || "").trim())
          .filter(Boolean),
      ),
    [favoriteQuery.data],
  );

  useEffect(() => {
    const items = tracks
      .map((track) => ({
        mbid: track?.albumMbid,
        artistName: track?.artistName,
        albumTitle: track?.albumName,
      }))
      .filter((item) => item.mbid);
    if (!items.length) {
      setTrackArtworkByAlbumMbid({});
      return undefined;
    }
    let cancelled = false;
    getReleaseGroupCoversBatch(items)
      .then((covers) => {
        if (cancelled) return;
        setTrackArtworkByAlbumMbid(
          Object.fromEntries(
            Object.entries(covers || {})
              .map(([mbid, cover]) => [mbid, cover?.image || ""])
              .filter(([, image]) => image),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setTrackArtworkByAlbumMbid({});
      });
    return () => {
      cancelled = true;
    };
  }, [tracks]);

  const getNextPlaylistName = (baseName: string) =>
    reserveUniqueName(
      new Set(staticPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean)),
      baseName,
    );

  const refreshAll = async () => {
    await fetchStatus();
    await refresh();
  };

  const openTrackArtworkEditor = (track: PlaylistTrackRow) => {
    setArtworkEditor({
      id: track.id,
      title: track.trackName || "Track",
      currentArtwork:
        track.artworkUrl || trackArtworkByAlbumMbid[String(track.albumMbid || "")] || "",
      hasCustomArtwork: Boolean(track.customArtworkUrl),
      fallbackArtwork: trackArtworkByAlbumMbid[String(track.albumMbid || "")] || "",
    });
  };

  const handleArtworkSaved = async (result: CustomArtworkResult) => {
    if (artworkEditor) {
      updateQueueArtwork(
        { id: artworkEditor.id },
        result?.updatedAt
          ? getPlaylistTrackArtworkUrl(entry.id, artworkEditor.id, result.updatedAt)
          : artworkEditor.fallbackArtwork || null,
        result?.updatedAt ? "track" : "album",
      );
    }
    await refreshAll();
    showSuccess("Artwork updated");
  };

  const saveTrackToPlaylist = async (track: PlaylistTrackRow, target: PlaylistTrackTarget) => {
    const payload = normalizePlaylistTrackEntry(track);
    if (!payload) {
      showError("Track details are incomplete");
      return;
    }
    if (playlistMenuSavingKey) return;
    setPlaylistMenuError("");
    setPlaylistMenuSavingKey(String(track?.id ?? ""));
    const targetName =
      target?.mode === "new"
        ? String(target?.name || "").trim() || getNextPlaylistName(`${payload.artistName} Picks`)
        : staticPlaylists.find((playlist) => playlist.id === target?.playlistId)?.name ||
          "the playlist";
    try {
      if (target?.mode === "new") {
        await createStaticPlaylist({ name: targetName, tracks: [payload] });
      } else {
        await addStaticPlaylistTracks(target.playlistId, { tracks: [payload] });
      }
      showSuccess(`Added ${payload.trackName} to ${targetName}`);
      void refreshAll();
    } catch (err) {
      const message = `Could not add ${payload.trackName} to ${targetName}. Nothing was added. ${getApiErrorMessage(err, "Try again.")}`;
      setPlaylistMenuError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
    }
  };

  const copyTracks = async (selected: PlaylistTrackRow[], target: PlaylistTrackTarget) => {
    const payloads = selected
      .map((track) => normalizePlaylistTrackEntry(track))
      .filter((payload) => payload !== null);
    if (payloads.length === 0) {
      showError("No valid tracks to add");
      return;
    }
    if (bulkActionLoading) return;
    setBulkActionLoading(true);
    const targetName =
      target?.mode === "new"
        ? String(target?.name || "").trim() || getNextPlaylistName("Playlist")
        : staticPlaylists.find((playlist) => playlist.id === target?.playlistId)?.name ||
          "the playlist";
    try {
      if (target?.mode === "new") {
        await createStaticPlaylist({ name: targetName, tracks: payloads });
      } else {
        await addStaticPlaylistTracks(target.playlistId, { tracks: payloads });
      }
      showSuccess(`Added ${trackCountLabel(payloads.length)} to ${targetName}`);
      void refreshAll();
    } catch (err) {
      showError(
        `Could not add ${trackCountLabel(payloads.length)} to ${targetName}. Nothing was added. ${getApiErrorMessage(err, "Try again.")}`,
      );
    } finally {
      setBulkActionLoading(false);
    }
  };

  const moveTracks = (selected: PlaylistTrackRow[], target: PlaylistTrackTarget) =>
    bulkActions.moveTracks(
      entry,
      selected,
      target?.mode === "new"
        ? { ...target, name: String(target.name || "").trim() || getNextPlaylistName("Playlist") }
        : target,
    );

  const handleDeleteTrack = (track: PlaylistTrackRow) => bulkActions.removeTracks(entry, [track]);

  const handleReSearchTrack = async (track: PlaylistTrackRow, forceReplacementSearch = false) => {
    const jobId = track?.id;
    if (!jobId || reSearchingTrackIds[jobId]) return;
    const searchAction = forceReplacementSearch
      ? "replacement"
      : getTrackSearchAction(track, !isFlow && showTrackAvailability);
    if (!searchAction) return;
    setReSearchingTrackIds((prev) => ({ ...prev, [jobId]: true }));
    if (searchAction === "research") {
      queryClient.setQueryData<PlaylistTrackRow[]>(queryKeys.playlistJobs(entry.id), (prev) =>
        (prev || []).map((job) =>
          job?.id === jobId ? { ...job, status: "pending", error: null, streamUrl: null } : job,
        ),
      );
    }
    try {
      if (searchAction === "upgrade") {
        const result = await searchTrackUpgrade(entry.id, jobId);
        showSuccess(
          result?.alreadyQueued
            ? `Upgrade search already queued for ${track.trackName}`
            : `Searching for an upgrade to ${track.trackName}`,
        );
      } else {
        await (isFlow ? reSearchFlowTrack : reSearchStaticPlaylistTrack)(entry.id, jobId);
        showSuccess(`Re-searching ${track.trackName}`);
      }
      await refreshAll();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to re-search track"));
      await refresh();
    } finally {
      setReSearchingTrackIds(({ [jobId]: _, ...prev }) => prev);
    }
  };

  const getFlowArtistLink = (track: PlaylistTrackRow) =>
    track?.artistMbid
      ? { to: `/artist/${track.artistMbid}`, state: { artistName: track.artistName } }
      : null;

  const getFlowAlbumLink = (track: PlaylistTrackRow) =>
    track?.albumMbid && track.artistMbid
      ? {
          to: `/artist/${track.artistMbid}/release/${track.albumMbid}`,
          state: {
            artistName: track.artistName,
            focusReleaseGroupMbid: track.albumMbid,
            focusReleaseGroup: { id: track.albumMbid, title: track.albumName || "" },
          },
        }
      : null;

  const getArtistLink = (track: PlaylistTrackRow) => {
    if (!track?.artistMbid) return null;
    if (isFlow) return getFlowArtistLink(track);
    return { to: resolveLibraryArtistPath({ mbid: track.artistMbid, name: track.artistName }) };
  };

  const getAlbumLink = (track: PlaylistTrackRow) => {
    if (!track?.albumMbid) return null;
    if (isFlow && track.artistMbid) return getFlowAlbumLink(track);
    return {
      to: resolveLibraryAlbumPath({
        mbid: track.albumMbid,
        name: track.albumName,
        artistName: track.artistName,
      }),
    };
  };

  const openLink = (link: { to: string | null; state?: unknown } | null) => {
    if (link?.to) navigate(link.to, { state: link.state });
  };
  const handleNavigateArtist = (track: PlaylistTrackRow) => openLink(getArtistLink(track));
  const handleNavigateAlbum = (track: PlaylistTrackRow) => openLink(getAlbumLink(track));

  const handleAddTrackToLibrary = async (track: PlaylistTrackRow) => {
    const payload = {
      artistName: String(track?.artistName || "").trim(),
      trackName: String(track?.trackName || "").trim(),
      albumName: String(track?.albumName || "").trim() || null,
      artistMbid: String(track?.artistMbid || "").trim() || null,
      albumMbid: String(track?.albumMbid || "").trim() || null,
      releaseMbid: track?.releaseMbid || null,
      trackMbid: String(track?.trackMbid || "").trim() || null,
      releaseYear: track?.releaseYear || null,
      durationMs: track?.durationMs || null,
      trackNumber: track?.trackNumber,
      discNumber: track?.discNumber,
      albumTrackCount: track?.albumTrackCount,
      albumTrackTitles: track?.albumTrackTitles,
    };
    if (!payload.artistName || !payload.trackName) {
      showError("Track details are incomplete");
      return;
    }
    if (libraryTrackSavingKey) return;
    setLibraryTrackSavingKey(String(track?.id || `${payload.artistName}:${payload.trackName}`));
    try {
      const result = await downloadTrackToLibrary(payload);
      showSuccess(
        result?.alreadyOwned
          ? `${payload.trackName} is already in your library`
          : result?.queued
            ? `Queued ${payload.trackName} for your library`
            : `Added ${payload.trackName} to your library`,
      );
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to add track to library"));
    } finally {
      setLibraryTrackSavingKey("");
    }
  };

  const getTrackFavoriteId = (track: PlaylistTrackRow) =>
    entry?.id && track?.id
      ? `${isFlow ? "flow-song" : "shared-song"}:${encodeURIComponent(`${entry.id}:${track.id}`)}`
      : "";

  const handleToggleFavorite = async (track: PlaylistTrackRow) => {
    const id = getTrackFavoriteId(track);
    if (!id || favoriteTrackSavingKey) return;
    const nextStarred = !favoriteTrackIds.has(id);
    const favoriteQueryKey = queryKeys.libraryFavorites;
    setFavoriteTrackSavingKey(id);
    const name = track.trackName || "track";
    const setStarred = (starred: boolean) =>
      queryClient.setQueryData<FavoriteSongs>(favoriteQueryKey, (current = {}) => {
        const songs = Array.isArray(current.song) ? current.song : [];
        const withoutTrack = songs.filter((song) => String(song?.id || "") !== id);
        return { ...current, song: starred ? [...withoutTrack, { id }] : withoutTrack };
      });
    let previous: FavoriteSongs | undefined;
    let optimistic: FavoriteSongs | undefined;
    try {
      await queryClient.cancelQueries({ queryKey: favoriteQueryKey });
      previous = queryClient.getQueryData(favoriteQueryKey);
      optimistic = setStarred(nextStarred);
      const result = await updateLibraryFavorites([id], nextStarred);
      if (nextStarred) {
        showSuccess(`Added ${name} to favorites`);
      } else {
        showFavoriteRemoved(toast, {
          name,
          removed: result?.removed,
          restore: () => setStarred(true),
          revert: () => setStarred(false),
        });
      }
    } catch (err) {
      if (optimistic && queryClient.getQueryData(favoriteQueryKey) === optimistic) {
        queryClient.setQueryData(favoriteQueryKey, previous);
      }
      showError(
        `Could not ${nextStarred ? "add" : "remove"} ${name} ${nextStarred ? "to" : "from"} favorites. Nothing changed. ${getApiErrorMessage(err, "Try again.")}`,
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: favoriteQueryKey }).catch(() => {});
      setFavoriteTrackSavingKey("");
    }
  };

  return (
    <>
      <PlaylistTracksPanel
        label={`${entry.name || "Playlist"} tracks`}
        showTrackStatus={isFlow}
        tracks={tracks}
        loading={loading}
        error={error}
        playbackSource={{
          type: isFlow ? "flow" : "playlist",
          id: entry.id,
          label: entry.name || "Playlist",
          recordHistory,
        }}
        activityHint={activityHint}
        emptyMessage={emptyMessage}
        allowBulkEdit={!isFlow}
        bulkActionLoading={bulkActionLoading}
        onBulkDelete={isFlow ? undefined : (selected) => bulkActions.removeTracks(entry, selected)}
        onBulkAddToPlaylist={
          isFlow ? undefined : (selected, target) => copyTracks(selected, target)
        }
        onBulkMoveToPlaylist={
          isFlow ? undefined : (selected, target) => moveTracks(selected, target)
        }
        playlists={staticPlaylists}
        playlistSavingKey={playlistMenuSavingKey}
        playlistMenuError={playlistMenuError}
        excludedPlaylistIds={isFlow ? [] : [entry.id]}
        getDefaultPlaylistName={(track) =>
          getNextPlaylistName(`${track?.artistName || "Artist"} Picks`)
        }
        onLoadPlaylists={() => setPlaylistMenuError("")}
        reSearchingTrackIds={reSearchingTrackIds}
        onReSearchTrack={handleReSearchTrack}
        onManualReSearchTrack={(track) => track?.id && setManualReplacement(track)}
        onDeleteTrack={isFlow ? undefined : handleDeleteTrack}
        onAddTrackToPlaylist={saveTrackToPlaylist}
        onMoveTrackToPlaylist={isFlow ? undefined : (track, target) => moveTracks([track], target)}
        onAddTrackToLibrary={handleAddTrackToLibrary}
        onShareTrack={(track) =>
          share(
            {
              kind: "track",
              title: track.trackName,
              artistName: track.artistName,
              albumTitle: track.albumName,
              artistMbid: track.artistMbid,
              albumMbid: track.albumMbid,
              trackMbid: track.trackMbid,
            },
            track.trackName,
          )
        }
        onViewTrackInfo={(track) =>
          setTrackInfo({
            kind: "track",
            source: "playlist",
            entity: track,
            trackNumber: track.trackNumber,
          })
        }
        onEditTrackArtwork={canEditArtwork ? openTrackArtworkEditor : undefined}
        libraryTrackSavingKey={libraryTrackSavingKey}
        getTrackFavoriteId={getTrackFavoriteId}
        favoriteTrackIds={favoriteTrackIds}
        favoriteTrackSavingKey={favoriteTrackSavingKey}
        onToggleFavorite={handleToggleFavorite}
        onNavigateArtist={handleNavigateArtist}
        onNavigateAlbum={handleNavigateAlbum}
        getArtistLink={getArtistLink}
        getAlbumLink={getAlbumLink}
        artworkByAlbumMbid={trackArtworkByAlbumMbid}
        showTrackAvailability={showTrackAvailability}
      />
      <LibraryInfoModal item={trackInfo} onClose={() => setTrackInfo(null)} />
      <ArtworkEditorModal
        open={Boolean(artworkEditor)}
        title={artworkEditor?.title || "Track"}
        currentArtwork={artworkEditor?.currentArtwork}
        hasCustomArtwork={artworkEditor?.hasCustomArtwork}
        onClose={() => setArtworkEditor(null)}
        onUpload={(file) => uploadPlaylistTrackArtwork(entry.id, artworkEditor!.id, file)}
        onSaveUrl={(url) => setPlaylistTrackArtworkUrl(entry.id, artworkEditor!.id, url)}
        onRemove={() => deletePlaylistTrackArtwork(entry.id, artworkEditor!.id)}
        onSaved={handleArtworkSaved}
      />
      <ManualMissingSearchModal
        job={manualReplacement}
        mode="replacement"
        playlistId={manualReplacement ? entry.id : null}
        onClose={() => setManualReplacement(null)}
        onQueued={(job) => {
          showSuccess(`Replacing ${job.trackName || "selected track"}`);
          void refreshAll();
        }}
      />
    </>
  );
}
