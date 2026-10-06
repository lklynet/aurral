import { randomUUID } from "crypto";
import { spotifyClient } from "../spotify/spotifyClient.js";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.js";
import { listenbrainzPlaylistClient } from "./listenbrainzPlaylists.js";
import { lastfmStationClient } from "./lastfmStations.js";
import { youtubeMusicPlaylistClient } from "./youtubeMusicPlaylists.js";
import { getDeezerPlaylist } from "./deezerPlaylists.js";
import { normalizeImportSource } from "../playlists/flowPlaylistConfig.js";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.js";
import { logger } from "../logger.js";

export async function fetchImportedPlaylistTracks({
  provider,
  userId,
  externalId,
  externalUsername,
  forceRefresh = false,
} = {}) {
  if (provider === "spotify-playlist") {
    const items = await spotifyClient.listPlaylistTracks(userId, externalId, { forceRefresh });
    const parsed = parseSpotifyPlaylistItems(items);
    return parsed;
  }
  if (provider === "listenbrainz-playlist") {
    return listenbrainzPlaylistClient.getPlaylistTracks(userId, externalId);
  }
  if (provider === "listenbrainz-createdfor") {
    return listenbrainzPlaylistClient.getGeneratedPlaylistTracks(userId, externalId);
  }
  if (provider === "lastfm-station") {
    return lastfmStationClient.getStationTracks(userId, externalId, externalUsername);
  }
  if (provider === "youtube-music-playlist") {
    const { tracks, stats, excluded } = await youtubeMusicPlaylistClient.getPlaylist(
      externalId,
      { forceRefresh },
    );
    return { tracks, stats, excluded };
  }
  if (provider === "deezer-playlist") {
    const { tracks, stats, excluded } = await getDeezerPlaylist(externalId);
    return { tracks, stats, excluded };
  }
  const error = new Error(`Unsupported playlist import provider: ${provider || "unknown"}`);
  error.statusCode = 400;
  throw error;
}

export async function enqueueImportedPlaylist({
  ownerUserId,
  name,
  sourceName,
  description = null,
  provider,
  externalId,
  externalUsername,
  externalName,
  tracks,
  sourceStats = null,
  syncEnabled,
  syncIntervalHours,
  keepRemovedTracks,
} = {}) {
  const safePlaylistId = randomUUID();
  const importSource = normalizeImportSource({
    provider,
    externalId,
    externalUsername,
    externalName: externalName || name,
    syncEnabled,
    syncIntervalHours: syncEnabled ? syncIntervalHours : 0,
    keepRemovedTracks,
    lastSyncAt: Date.now(),
    lastSyncTrackCount: tracks.length,
  });
  const result = await playlistOperationQueue.enqueuePayload({
    kind: "static-playlist-create",
    label: "static-playlist:create",
    playlistId: safePlaylistId,
    name,
    sourceName,
    description,
    tracks,
    ownerUserId,
    importSource,
  });
  logger.info("playlist-import", "Playlist import queued", {
    provider,
    playlistName: name,
    playlistId: safePlaylistId,
    operationId: result.operationId,
    trackCount: tracks.length,
    ...(sourceStats ? { skipped: sourceStats } : {}),
  });
  return { ...result, playlistId: safePlaylistId, tracksQueued: tracks.length };
}
