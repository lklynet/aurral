import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { spotifyClient } from "../spotify/spotifyClient.js";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.js";
import { updateSharedPlaylist } from "../weeklyFlow/weeklyFlowOperations.js";

const HOUR_MS = 60 * 60 * 1000;

export function isImportSourceDue(importSource, now = Date.now()) {
  if (!importSource?.syncEnabled) return false;
  const intervalHours = Number(importSource.syncIntervalHours);
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours * HOUR_MS : 24 * HOUR_MS;
  const lastSyncAt = Number(importSource.lastSyncAt || 0);
  return !lastSyncAt || now - lastSyncAt >= intervalMs;
}

export async function syncSharedPlaylistImport({
  playlistId,
  user,
  force = false,
} = {}) {
  const playlist = flowPlaylistConfig.getSharedPlaylist(playlistId);
  if (!playlist?.importSource) {
    return { skipped: true, reason: "no-import-source" };
  }
  if (!force && !isImportSourceDue(playlist.importSource)) {
    return { skipped: true, reason: "not-due" };
  }
  if (!flowPlaylistConfig.canUserAccessSharedPlaylist(user, playlist)) {
    const error = new Error("Playlist not found");
    error.statusCode = 404;
    throw error;
  }
  const ownerUserId = playlist.ownerUserId ?? user?.id;
  try {
    const externalPlaylistId = String(playlist.importSource?.externalId || "").trim();
    const items = await spotifyClient.listPlaylistTracks(
      ownerUserId,
      externalPlaylistId,
      { forceRefresh: true },
    );
    const tracks = parseSpotifyPlaylistItems(items).tracks;
    const syncImportSource = {
      lastSyncAt: Date.now(),
      lastSyncError: null,
      lastSyncTrackCount: tracks.length,
    };
    const result = await updateSharedPlaylist({
      playlistId: playlist.id,
      tracks,
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: syncImportSource,
      mergeImportSource: true,
    });
    return {
      skipped: false,
      trackCount: tracks.length,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
    };
  } catch (error) {
    const latestPlaylist = flowPlaylistConfig.getSharedPlaylist(playlist.id);
    flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
      importSource: {
        ...(latestPlaylist?.importSource || playlist.importSource),
        lastSyncError: String(error?.message || "Spotify sync failed"),
      },
    });
    throw error;
  }
}

export async function runDueImportSourceSyncs() {
  const playlists = flowPlaylistConfig.getSharedPlaylists();
  const results = [];
  for (const playlist of playlists) {
    if (!playlist?.importSource?.syncEnabled) continue;
    if (!isImportSourceDue(playlist.importSource)) continue;
    const ownerUserId = playlist.ownerUserId;
    if (ownerUserId == null) continue;
    try {
      const result = await syncSharedPlaylistImport({
        playlistId: playlist.id,
        user: { id: ownerUserId },
      });
      results.push({ playlistId: playlist.id, ...result });
    } catch (error) {
      results.push({
        playlistId: playlist.id,
        error: String(error?.message || "Spotify sync failed"),
      });
    }
  }
  return results;
}
