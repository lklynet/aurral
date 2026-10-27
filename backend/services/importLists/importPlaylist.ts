import { randomUUID } from "crypto";
import { spotifyClient } from "../spotify/spotifyClient.ts";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.ts";
import { listenbrainzPlaylistClient } from "./listenbrainzPlaylists.ts";
import { lastfmStationClient } from "./lastfmStations.ts";
import { youtubeMusicPlaylistClient } from "./youtubeMusicPlaylists.ts";
import { getDeezerPlaylist } from "./deezerPlaylists.ts";
import { normalizeImportSource, type PlaylistTrack } from "../playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import { logger } from "../logger.ts";

type CodedError = Error & { statusCode?: number };

type ImportStats = {
  sourceItems?: number;
  itemOnly?: number;
  unavailable?: number;
  podcast?: number;
  incomplete: number;
  duplicate: number;
};

type ImportExcluded = ReturnType<typeof parseSpotifyPlaylistItems>["excluded"];

export type ImportedPlaylistTracks = {
  artworkUrl?: string | null;
  tracks: PlaylistTrack[];
  stats: ImportStats;
  excluded?: ImportExcluded;
  user?: string;
};

export async function fetchImportedPlaylistTracks({
  provider,
  userId,
  externalId,
  externalUsername,
  forceRefresh = false,
}: {
  provider: string;
  userId: number | undefined;
  externalId: string;
  externalUsername?: string | null;
  forceRefresh?: boolean;
}): Promise<ImportedPlaylistTracks> {
  if (provider === "spotify-playlist") {
    const items = await spotifyClient.listPlaylistTracks(userId, externalId, { forceRefresh });
    const parsed = parseSpotifyPlaylistItems(items);
    const artworkUrl = await spotifyClient
      .getPlaylistArtworkUrl(userId, externalId)
      .catch(() => null);
    return { ...parsed, artworkUrl };
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
    const { tracks, stats, excluded, artworkUrl } = await youtubeMusicPlaylistClient.getPlaylist(
      externalId,
      {
        forceRefresh,
      },
    );
    return { tracks, stats, excluded, artworkUrl };
  }
  if (provider === "deezer-playlist") {
    const { tracks, stats, excluded, artworkUrl } = await getDeezerPlaylist(externalId);
    return { tracks, stats, excluded, artworkUrl };
  }
  const error: CodedError = new Error(
    `Unsupported playlist import provider: ${provider || "unknown"}`,
  );
  error.statusCode = 400;
  throw error;
}

export async function enqueueImportedPlaylist({
  ownerUserId,
  name,
  sourceName,
  description = null,
  artworkUrl = null,
  provider,
  externalId,
  externalUsername,
  externalName,
  tracks,
  sourceStats = null,
  syncEnabled,
  syncIntervalHours,
  keepRemovedTracks,
}: {
  ownerUserId: number;
  name: string;
  sourceName: string;
  description?: string | null;
  artworkUrl?: string | null;
  provider: string;
  externalId: string;
  externalUsername?: string | null;
  externalName: string;
  tracks: PlaylistTrack[];
  sourceStats?: ImportStats | null;
  syncEnabled: boolean;
  syncIntervalHours: number;
  keepRemovedTracks: boolean;
}) {
  const safePlaylistId = randomUUID();
  const importSource = normalizeImportSource({
    provider,
    externalId,
    externalUsername,
    externalName: externalName || name,
    artworkUrl,
    syncEnabled,
    syncIntervalHours: syncEnabled ? syncIntervalHours : 0,
    keepRemovedTracks,
    lastSyncAt: Date.now(),
    lastSyncTrackCount: tracks.length,
  });
  const result = await playlistOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label: "shared-playlist:create",
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
