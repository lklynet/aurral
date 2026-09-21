import { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { fetchImportedPlaylistTracks } from "./importPlaylist.js";
import { updateSharedPlaylist } from "../weeklyFlow/weeklyFlowOperations.js";
import { logger } from "../logger.js";
import { dbOps } from "../../db/helpers/index.js";
import { isFlowOwnerProcess, requestFlowOwner } from "../weeklyFlow/weeklyFlowOwnerClient.js";

const HOUR_MS = 60 * 60 * 1000;

export function isImportSourceDue(importSource, now = Date.now()) {
  if (!importSource?.syncEnabled) return false;
  const intervalHours = Number(importSource.syncIntervalHours);
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours * HOUR_MS : 24 * HOUR_MS;
  const lastSyncAt = Number(importSource.lastSyncAt || 0);
  return !lastSyncAt || now - lastSyncAt >= intervalMs;
}

export async function syncSharedPlaylistImport(options = {}) {
  if (isFlowOwnerProcess()) return syncSharedPlaylistImportHere(options);
  const { playlistId, user, force = false } = options;
  try {
    const response = await requestFlowOwner("syncSharedPlaylistImport", [{
      playlistId,
      user: { id: user?.id, role: user?.role },
      force,
    }], { timeoutMs: 5 * 60 * 1000 });
    if (response?.ok === false) {
      const error = new Error(response.error?.message || "Playlist sync failed");
      if (response.error?.code) error.code = response.error.code;
      if (response.error?.statusCode) error.statusCode = response.error.statusCode;
      throw error;
    }
    if (response?.ok !== true) throw new Error("Invalid playlist sync worker response");
    return response.result;
  } finally {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
  }
}

async function syncSharedPlaylistImportHere({
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
  let stage = "fetching-source";
  try {
    const externalPlaylistId = String(playlist.importSource?.externalId || "").trim();
    const tracks = (
      await fetchImportedPlaylistTracks({
        provider: playlist.importSource.provider,
        userId: ownerUserId,
        externalId: externalPlaylistId,
        externalUsername: playlist.importSource?.externalUsername,
        forceRefresh: true,
      })
    ).tracks;
    const syncImportSource = {
      lastSyncAt: Date.now(),
      lastSyncError: null,
      lastSyncTrackCount: tracks.length,
    };
    stage = "updating-playlist";
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
    if (error?.code === "SQLITE_BUSY" || /database is locked/i.test(String(error?.message || ""))) {
      logger.error("playlist-import", "SQLite lock interrupted playlist sync", {
        playlistId: playlist.id,
        provider: playlist.importSource.provider,
        stage,
        code: error?.code || null,
        stackFrames: String(error?.stack || "").split("\n").slice(1, 7).map((line) => line.trim()),
      });
    }
    try {
      const latestPlaylist = flowPlaylistConfig.getSharedPlaylist(playlist.id);
      flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
        importSource: {
          ...(latestPlaylist?.importSource || playlist.importSource),
          lastSyncError: String(error?.message || "Playlist sync failed"),
        },
      });
    } catch (persistError) {
      logger.warn("playlist-import", "Could not save playlist sync failure", {
        playlistId: playlist.id,
        code: persistError?.code || null,
      });
    }
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
        error: String(error?.message || "Playlist sync failed"),
      });
    }
  }
  return results;
}
