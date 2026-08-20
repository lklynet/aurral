import { randomUUID } from "crypto";
import { spotifyClient } from "../spotify/spotifyClient.js";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.js";
import { listenbrainzPlaylistClient } from "./listenbrainzPlaylists.js";
import { lastfmStationClient } from "./lastfmStations.js";
import { normalizeImportSource } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../weeklyFlow/weeklyFlowOperationQueue.js";

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
    return { tracks: parsed.tracks, stats: parsed.stats };
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
  const error = new Error(`Unsupported playlist import provider: ${provider || "unknown"}`);
  error.statusCode = 400;
  throw error;
}

export async function enqueueImportedPlaylist({
  ownerUserId,
  name,
  sourceName,
  provider,
  externalId,
  externalUsername,
  externalName,
  tracks,
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
  return weeklyFlowOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label: "shared-playlist:create",
    playlistId: safePlaylistId,
    name,
    sourceName,
    tracks,
    ownerUserId,
    importSource,
  });
}
