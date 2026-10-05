import { usePlaylistBulkActions } from "./usePlaylistBulkActions.js";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  addStaticPlaylistTracks,
  createStaticPlaylist,
  deleteStaticPlaylistTrack,
  reSearchFlowTrack,
  reSearchStaticPlaylistTrack,
  searchTrackUpgrade,
} from "../../utils/api/endpoints/playlists.js";
import { getReleaseGroupCoversBatch } from "../../utils/api/endpoints/artists.js";
import {
  downloadTrackToLibrary,
  fetchLibraryFavorites,
  getLibraryPage,
  lookupAlbumsInLibraryBatch,
  lookupArtistInLibrary,
  updateLibraryFavorites,
} from "../../utils/api/endpoints/library.js";
import {
  libraryRecordId,
  findLibraryAlbumByName,
  findLibraryArtistByName,
} from "../../utils/libraryTrackNavigation.js";
import { useToast } from "../../contexts/ToastContext";
import { describeAddTrackResult } from "../../utils/libraryDestination.js";
import { queryClient, queryKeys } from "../../queryClient.js";
import { PlaylistTracksPanel } from "./components/playlistTrackComponents.jsx";
import ManualMissingSearchModal from "../activity/ManualMissingSearchModal.jsx";
import LibraryInfoModal from "../LibraryInfoModal.jsx";
import { getTrackSearchAction } from "./trackAvailability.js";
import {
  normalizeNameKey,
  normalizePlaylistTrackEntry,
  reserveUniqueName,
} from "./flowPageUtils";

const errorMessage = (err, fallback) =>
  err?.response?.data?.message || err?.response?.data?.error || err?.message || fallback;

const trackCountLabel = (count) => `${count} track${count === 1 ? "" : "s"}`;

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
}) {
  const isFlow = kind === "flow";
  const bulkActions = usePlaylistBulkActions();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [reSearchingTrackIds, setReSearchingTrackIds] = useState({});
  const [manualReplacement, setManualReplacement] = useState(null);
  const [trackInfo, setTrackInfo] = useState(null);
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [playlistMenuError, setPlaylistMenuError] = useState("");
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");
  const [favoriteTrackSavingKey, setFavoriteTrackSavingKey] = useState("");
  const [deletingTrackId, setDeletingTrackId] = useState(null);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [trackArtworkByAlbumMbid, setTrackArtworkByAlbumMbid] = useState({});

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

  const getNextPlaylistName = (baseName) =>
    reserveUniqueName(
      new Set(staticPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean)),
      baseName,
    );

  const refreshAll = async () => {
    await fetchStatus();
    await refresh();
  };

  const saveTrackToPlaylist = async (track, target, { moveFromPlaylistId = null } = {}) => {
    const payload = normalizePlaylistTrackEntry(track);
    if (!payload) {
      showError("Track details are incomplete");
      return;
    }
    setPlaylistMenuError("");
    setPlaylistMenuSavingKey(String(track?.id ?? ""));
    try {
      let targetName;
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() || getNextPlaylistName(`${payload.artistName} Picks`);
        const response = await createStaticPlaylist({ name, tracks: [payload] });
        targetName = response?.playlist?.name || name;
      } else {
        await addStaticPlaylistTracks(target.playlistId, { tracks: [payload] });
        targetName =
          staticPlaylists.find((playlist) => playlist.id === target?.playlistId)?.name ||
          "playlist";
      }
      if (moveFromPlaylistId && track?.id) {
        await deleteStaticPlaylistTrack(moveFromPlaylistId, track.id);
        showSuccess(`Track moved to ${targetName}`);
      } else {
        showSuccess(`Track added to ${targetName}`);
      }
      await refreshAll();
    } catch (err) {
      const message = errorMessage(err, "Failed to save track to playlist");
      setPlaylistMenuError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
    }
  };

  const copyTracks = async (selected, target) => {
    const payloads = selected.map((track) => normalizePlaylistTrackEntry(track)).filter(Boolean);
    if (payloads.length === 0) {
      showError("No valid tracks to add");
      return;
    }
    setBulkActionLoading(true);
    try {
      let targetName;
      if (target?.mode === "new") {
        const name = String(target?.name || "").trim() || getNextPlaylistName("Playlist");
        const response = await createStaticPlaylist({ name, tracks: payloads });
        targetName = response?.playlist?.name || name;
      } else {
        await addStaticPlaylistTracks(target.playlistId, { tracks: payloads });
        targetName =
          staticPlaylists.find((playlist) => playlist.id === target?.playlistId)?.name ||
          "playlist";
      }
      showSuccess(`Added ${trackCountLabel(payloads.length)} to ${targetName}`);
      await refreshAll();
    } catch (err) {
      showError(errorMessage(err, "Failed to add tracks"));
    } finally {
      setBulkActionLoading(false);
    }
  };

  const moveTracks = (selected, target) => bulkActions.moveTracks(entry, selected,
    target?.mode === "new"
      ? { ...target, name: String(target.name || "").trim() || getNextPlaylistName("Playlist") }
      : target);

  const handleDeleteTrack = async (track) => {
    const jobId = track?.id;
    if (!jobId || deletingTrackId === jobId) return;
    setDeletingTrackId(jobId);
    try {
      const result = await deleteStaticPlaylistTrack(entry.id, jobId);
      showSuccess(
        result?.queued
          ? `Removal queued for ${track.trackName || "track"}`
          : `Removed ${track.trackName || "track"}`,
      );
      await refreshAll();
    } catch (err) {
      showError(errorMessage(err, "Failed to remove track"));
    } finally {
      setDeletingTrackId(null);
    }
  };

  const handleReSearchTrack = async (track, forceReplacementSearch = false) => {
    const jobId = track?.id;
    if (!jobId || reSearchingTrackIds[jobId]) return;
    const searchAction = forceReplacementSearch
      ? "replacement"
      : getTrackSearchAction(track, !isFlow && showTrackAvailability);
    if (!searchAction) return;
    setReSearchingTrackIds((prev) => ({ ...prev, [jobId]: true }));
    if (searchAction === "research") {
      queryClient.setQueryData(queryKeys.playlistJobs(entry.id), (prev) =>
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
      showError(errorMessage(err, "Failed to re-search track"));
      await refresh();
    } finally {
      setReSearchingTrackIds(({ [jobId]: _, ...prev }) => prev);
    }
  };

  const handleNavigateArtist = async (track) => {
    if (!track?.artistMbid) return;
    if (isFlow) {
      navigate(`/artist/${track.artistMbid}`, { state: { artistName: track.artistName } });
      return;
    }
    let canonicalId = null;
    try {
      const lookup = await lookupArtistInLibrary(track.artistMbid);
      canonicalId = lookup?.artist?.canonicalId || null;
    } catch {}
    if (!canonicalId && track.artistName) {
      try {
        const page = await getLibraryPage({
          kind: "artists",
          page: 1,
          pageSize: 100,
          query: track.artistName,
          // Resolve for navigation even if nothing is available yet.
          availableOnly: false,
        });
        canonicalId = libraryRecordId(findLibraryArtistByName(page?.items, track.artistName));
      } catch {}
    }
    if (canonicalId) navigate(`/library/artist/${encodeURIComponent(canonicalId)}`);
  };

  const handleNavigateAlbum = async (track) => {
    if (!track?.albumMbid) return;
    if (isFlow && track.artistMbid) {
      navigate(`/artist/${track.artistMbid}/release/${track.albumMbid}`, {
        state: {
          artistName: track.artistName,
          focusReleaseGroupMbid: track.albumMbid,
          focusReleaseGroup: { id: track.albumMbid, title: track.albumName || "" },
        },
      });
      return;
    }
    let canonicalId = null;
    try {
      const lookup = await lookupAlbumsInLibraryBatch([track.albumMbid]);
      canonicalId = lookup?.[track.albumMbid]?.canonicalAlbumId || null;
    } catch {}
    if (!canonicalId && track.albumName) {
      try {
        const page = await getLibraryPage({
          kind: "albums",
          page: 1,
          pageSize: 100,
          query: track.albumName,
          // Resolve for navigation even if nothing is available yet.
          availableOnly: false,
        });
        canonicalId = libraryRecordId(
          findLibraryAlbumByName(page?.items, track.albumName, track.artistName),
        );
      } catch {}
    }
    if (canonicalId) navigate(`/library/album/${encodeURIComponent(canonicalId)}`);
  };

  const handleAddTrackToLibrary = async (track) => {
    const payload = {
      artistName: String(track?.artistName || "").trim(),
      trackName: String(track?.trackName || "").trim(),
      albumName: String(track?.albumName || "").trim() || null,
      artistMbid: String(track?.artistMbid || "").trim() || null,
      albumMbid: String(track?.albumMbid || "").trim() || null,
      trackMbid: String(track?.trackMbid || "").trim() || null,
      releaseYear: track?.releaseYear || null,
      durationMs: track?.durationMs || null,
      trackNumber: track?.trackNumber,
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
      showSuccess(describeAddTrackResult(result, payload.trackName));
    } catch (err) {
      showError(errorMessage(err, "Failed to add track to library"));
    } finally {
      setLibraryTrackSavingKey("");
    }
  };

  const getTrackFavoriteId = (track) =>
    entry?.id && track?.id
      ? `${isFlow ? "flow-song" : "shared-song"}:${encodeURIComponent(`${entry.id}:${track.id}`)}`
      : "";

  const handleToggleFavorite = async (track) => {
    const id = getTrackFavoriteId(track);
    if (!id || favoriteTrackSavingKey) return;
    const nextStarred = !favoriteTrackIds.has(id);
    const favoriteQueryKey = queryKeys.libraryFavorites;
    setFavoriteTrackSavingKey(id);
    let previous;
    let optimistic;
    try {
      await queryClient.cancelQueries({ queryKey: favoriteQueryKey });
      previous = queryClient.getQueryData(favoriteQueryKey);
      optimistic = queryClient.setQueryData(favoriteQueryKey, (current = {}) => {
        const songs = Array.isArray(current.song) ? current.song : [];
        const withoutTrack = songs.filter((song) => String(song?.id || "") !== id);
        return { ...current, song: nextStarred ? [...withoutTrack, { id }] : withoutTrack };
      });
      await updateLibraryFavorites([id], nextStarred);
      showSuccess(nextStarred ? "Added to favorites" : "Removed from favorites");
    } catch (err) {
      if (optimistic && queryClient.getQueryData(favoriteQueryKey) === optimistic) {
        queryClient.setQueryData(favoriteQueryKey, previous);
      }
      showError(errorMessage(err, "Failed to update favorites"));
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
        bulkActionLoading={bulkActionLoading || bulkActions.bulkLoading}
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
        deletingTrackId={isFlow ? undefined : deletingTrackId}
        onReSearchTrack={handleReSearchTrack}
        onManualReSearchTrack={(track) => track?.id && setManualReplacement(track)}
        onDeleteTrack={isFlow ? undefined : handleDeleteTrack}
        onAddTrackToPlaylist={saveTrackToPlaylist}
        onMoveTrackToPlaylist={
          isFlow
            ? undefined
            : (track, target) => saveTrackToPlaylist(track, target, { moveFromPlaylistId: entry.id })
        }
        onAddTrackToLibrary={handleAddTrackToLibrary}
        onViewTrackInfo={(track) =>
          setTrackInfo({
            kind: "track",
            source: "playlist",
            entity: track,
            trackNumber: track.trackNumber,
          })
        }
        libraryTrackSavingKey={libraryTrackSavingKey}
        getTrackFavoriteId={getTrackFavoriteId}
        favoriteTrackIds={favoriteTrackIds}
        favoriteTrackSavingKey={favoriteTrackSavingKey}
        onToggleFavorite={handleToggleFavorite}
        onNavigateArtist={handleNavigateArtist}
        onNavigateAlbum={handleNavigateAlbum}
        artworkByAlbumMbid={trackArtworkByAlbumMbid}
        showTrackAvailability={showTrackAvailability}
      />
      <LibraryInfoModal item={trackInfo} onClose={() => setTrackInfo(null)} />
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
