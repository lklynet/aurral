import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
} from "../playlists/flowPlaylistConfig.js";
import { fetchImportedPlaylistTracks } from "./importPlaylist.js";
import { updateStaticPlaylist } from "../playlists/playlistOperations.js";
import { buildPlaylistTrackIdentity } from "../playlists/flowPlaylistConfig.js";
import { logger, safeLogDiagnostic } from "../logger.js";
import { dbOps } from "../../db/helpers/index.js";
import {
  isDownloadOwnerProcess,
  requestDownloadOwner,
} from "../downloadJobs/downloadOwnerClient.js";
import { spotifyConnectionStore } from "../spotify/spotifyConnectionStore.js";
import { scrobbleConnectionStore } from "../scrobbleConnectionStore.js";

const HOUR_MS = 60 * 60 * 1000;
const listenbrainzConnection = {
  name: "ListenBrainz",
  isConnected: (userId) => Boolean(scrobbleConnectionStore.getConnection(userId, "listenbrainz")),
};
const PROVIDER_CONNECTIONS = {
  "spotify-playlist": {
    name: "Spotify",
    isConnected: (userId) => Boolean(spotifyConnectionStore.getConnection(userId)),
  },
  "listenbrainz-playlist": listenbrainzConnection,
  "listenbrainz-createdfor": listenbrainzConnection,
};

export function isImportSourceDue(importSource, now = Date.now()) {
  if (!importSource?.syncEnabled) return false;
  const intervalHours = Number(importSource.syncIntervalHours);
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours * HOUR_MS : 24 * HOUR_MS;
  const lastSyncAt = Number(importSource.lastSyncAt || 0);
  return !lastSyncAt || now - lastSyncAt >= intervalMs;
}

export async function syncStaticPlaylistImport(options = {}) {
  if (isDownloadOwnerProcess()) return syncStaticPlaylistImportHere(options);
  const { playlistId, user, force = false } = options;
  try {
    const response = await requestDownloadOwner(
      "syncStaticPlaylistImport",
      [
        {
          playlistId,
          user: { id: user?.id, role: user?.role },
          force,
        },
      ],
      { timeoutMs: 5 * 60 * 1000 },
    );
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

async function syncStaticPlaylistImportHere({ playlistId, user, force = false } = {}) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist?.importSource) {
    return { skipped: true, reason: "no-import-source" };
  }
  if (!force && !isImportSourceDue(playlist.importSource)) {
    return { skipped: true, reason: "not-due" };
  }
  if (!flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist)) {
    const error = new Error("Playlist not found");
    error.statusCode = 404;
    throw error;
  }
  const ownerUserId = playlist.ownerUserId ?? user?.id;
  try {
    const externalPlaylistId = String(playlist.importSource?.externalId || "").trim();
    const {
      tracks,
      stats = {},
      excluded = [],
    } = await fetchImportedPlaylistTracks({
      provider: playlist.importSource.provider,
      userId: ownerUserId,
      externalId: externalPlaylistId,
      externalUsername: playlist.importSource?.externalUsername,
      forceRefresh: true,
    });
    const syncImportSource = {
      lastSyncAt: Date.now(),
      lastSyncError: null,
      lastSyncTrackCount: tracks.length,
    };
    const result = await updateStaticPlaylist({
      playlistId: playlist.id,
      tracks,
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: syncImportSource,
      mergeImportSource: true,
    });
    const previousIdentities = new Set((playlist.tracks || []).map(buildPlaylistTrackIdentity));
    const currentIdentities = new Set(
      (result?.playlist?.tracks || []).map(buildPlaylistTrackIdentity),
    );
    const acceptedNotStored = tracks.filter(
      (track) => !currentIdentities.has(buildPlaylistTrackIdentity(track)),
    );
    const tracksAdded = [...currentIdentities].filter((id) => !previousIdentities.has(id)).length;
    const tracksRemoved = [...previousIdentities].filter((id) => !currentIdentities.has(id)).length;
    const sourceSkipped = {
      unavailable: Number(stats.unavailable || 0),
      podcast: Number(stats.podcast || 0),
      incomplete: Number(stats.incomplete || 0),
      duplicate: Number(stats.duplicate || 0),
    };
    const sourceEntryCount = Number.isFinite(Number(stats.sourceItems))
      ? Number(stats.sourceItems)
      : tracks.length + Object.values(sourceSkipped).reduce((sum, count) => sum + count, 0);
    if (excluded.length > 0) {
      logger.debug("playlist-import", "Source entries excluded from playlist sync", {
        provider: playlist.importSource.provider,
        playlistId: playlist.id,
        excludedCount: excluded.length,
        entries: excluded.slice(0, 100),
      });
    }
    if (acceptedNotStored.length > 0) {
      logger.debug("playlist-import", "Accepted source tracks absent from saved playlist", {
        provider: playlist.importSource.provider,
        playlistId: playlist.id,
        trackCount: acceptedNotStored.length,
        tracks: acceptedNotStored.slice(0, 100).map((track) => ({
          artistName: track.artistName,
          trackName: track.trackName,
        })),
      });
    }
    logger.info("playlist-import", "Playlist import sync completed", {
      provider: playlist.importSource.provider,
      playlistName: playlist.name,
      playlistId: playlist.id,
      ...(playlist.importSource.provider === "youtube-music-playlist"
        ? {}
        : { externalPlaylistId }),
      sourceEntryCount,
      acceptedTrackCount: tracks.length,
      spotifyItemOnlyCount: Number(stats.itemOnly || 0),
      acceptedNotStoredCount: acceptedNotStored.length,
      previousTrackCount: playlist.tracks?.length || 0,
      playlistTrackCount: result?.playlist?.tracks?.length || 0,
      tracksAdded,
      tracksRemoved,
      tracksQueued: Number(result?.tracksQueued || 0),
      sourceSkipped,
    });
    return {
      skipped: false,
      trackCount: tracks.length,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
    };
  } catch (error) {
    logger.error("playlist-import", "Playlist import sync failed", {
      provider: playlist.importSource.provider,
      playlistName: playlist.name,
      playlistId: playlist.id,
      reason: safeLogDiagnostic(error),
    });
    const lastSyncError = String(error?.message || "").trim() || "Playlist sync failed";
    const latestPlaylist = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    if (latestPlaylist?.importSource?.lastSyncError !== lastSyncError) {
      flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
        importSource: {
          ...(latestPlaylist?.importSource || playlist.importSource),
          lastSyncError,
        },
      });
    }
    throw error;
  }
}

export async function runDueImportSourceSyncs() {
  const playlists = flowPlaylistConfig.getStaticPlaylists();
  const results = [];
  const disconnected = new Map();
  for (const playlist of playlists) {
    if (!playlist?.importSource?.syncEnabled) continue;
    if (!isImportSourceDue(playlist.importSource)) continue;
    const ownerUserId = playlist.ownerUserId;
    if (ownerUserId == null) continue;
    const connection = PROVIDER_CONNECTIONS[playlist.importSource.provider];
    if (connection && !connection.isConnected(ownerUserId)) {
      const connectionKey = `${connection.name}:${ownerUserId}`;
      const pending = disconnected.get(connectionKey);
      disconnected.set(connectionKey, {
        provider: connection.name,
        ownerUserId,
        playlistCount: (pending?.playlistCount || 0) + 1,
      });
      results.push({ playlistId: playlist.id, skipped: true, reason: "not-connected" });
      continue;
    }
    try {
      const result = await syncStaticPlaylistImport({
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
  for (const details of disconnected.values()) {
    logger.warn(
      "playlist-import",
      "Synced playlists paused until the provider reconnects",
      details,
    );
  }
  return results;
}
