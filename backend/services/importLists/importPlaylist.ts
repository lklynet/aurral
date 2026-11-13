import { randomUUID } from "crypto";
import { spotifyClient } from "../spotify/spotifyClient.ts";
import { spotifyConnectionStore } from "../spotify/spotifyConnectionStore.ts";
import { scrobbleConnectionStore } from "../scrobbleConnectionStore.ts";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.ts";
import { listenbrainzPlaylistClient } from "./listenbrainzPlaylists.ts";
import { lastfmStationClient } from "./lastfmStations.ts";
import {
  extractYoutubePlaylistId,
  validateYoutubePlaylistId,
  youtubeMusicPlaylistClient,
} from "./youtubeMusicPlaylists.ts";
import { getDeezerPlaylist } from "./deezerPlaylists.ts";
import { importAurralPlaylist } from "../discovery/aurralPlaylists.ts";
import { normalizeImportSource } from "../playlists/flowPlaylistConfig.ts";
import { normalizePlaylistTrack, type PlaylistTrack } from "../playlists/playlistTracks.ts";
import { loadRemoteShare } from "../shareLinks/remote.ts";
import type { ShareManifest } from "../../../lib/shareManifest.ts";
import {
  IMPORT_PROVIDER_LABELS,
  isImportProvider,
  isNativeImportProvider,
  type NativeImportProvider,
} from "../../../lib/importProviders.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import { logger } from "../logger.ts";
import { pluginImportList } from "../plugins/pluginImportList.ts";

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

export type ImportedPlaylist = {
  id: string;
  name?: string | null;
  artworkUrl?: string | null;
  tracks: PlaylistTrack[];
  stats: ImportStats;
  excluded?: ImportExcluded;
  externalUsername?: string | null;
};

type ImportReference = {
  userId: number | undefined;
  externalId: string;
  externalUsername?: string | null;
  forceRefresh?: boolean;
};

// A source Aurral imports playlists from, natively or through a plugin.
// Sync skips a source that needs an account the owner has disconnected.
// A rotating source fills slots that empty and refill, so while a slot is
// empty its synced playlist keeps the tracks it has.
export type ImportList = {
  label: string;
  sync: boolean;
  rotating?: boolean;
  isConnected?: (userId: number) => boolean;
  fetch: (reference: ImportReference) => Promise<ImportedPlaylist>;
};

export const sharedPlaylistTracks = (manifest: ShareManifest) =>
  manifest.tracks
    .map((track) => normalizePlaylistTrack({ ...track, albumName: track.albumTitle }))
    .filter((track) => track !== null);

const listenbrainzConnected = (userId: number) =>
  Boolean(scrobbleConnectionStore.getConnection(userId, "listenbrainz"));

const youtubePlaylistId = (reference: string) =>
  URL.canParse(reference)
    ? extractYoutubePlaylistId(reference)
    : validateYoutubePlaylistId(reference);

const nativeImportLists = {
  "spotify-playlist": {
    isConnected: (userId) => Boolean(spotifyConnectionStore.getConnection(userId)),
    fetch: async ({ userId, externalId, forceRefresh = false }) => {
      const items = await spotifyClient.listPlaylistTracks(userId, externalId, { forceRefresh });
      const artworkUrl = await spotifyClient
        .getPlaylistArtworkUrl(userId, externalId)
        .catch(() => null);
      return { ...parseSpotifyPlaylistItems(items), id: externalId, artworkUrl };
    },
  },
  "listenbrainz-playlist": {
    isConnected: listenbrainzConnected,
    fetch: async ({ userId, externalId }) => ({
      ...(await listenbrainzPlaylistClient.getPlaylistTracks(userId, externalId)),
      id: externalId,
    }),
  },
  "listenbrainz-createdfor": {
    isConnected: listenbrainzConnected,
    fetch: async ({ userId, externalId }) => ({
      ...(await listenbrainzPlaylistClient.getGeneratedPlaylistTracks(userId, externalId)),
      id: externalId,
    }),
  },
  "lastfm-station": {
    fetch: async ({ userId, externalId, externalUsername }) => {
      const { user, ...station } = await lastfmStationClient.getStationTracks(
        userId,
        externalId,
        externalUsername,
      );
      return { ...station, id: externalId, externalUsername: user };
    },
  },
  "youtube-music-playlist": {
    fetch: ({ externalId, forceRefresh = false }) =>
      youtubeMusicPlaylistClient.getPlaylist(youtubePlaylistId(externalId), { forceRefresh }),
  },
  "deezer-playlist": {
    fetch: async ({ externalId }) => ({ ...(await getDeezerPlaylist(externalId)), id: externalId }),
  },
  "aurral-discovery": {
    rotating: true,
    fetch: ({ userId, externalId }) => importAurralPlaylist("discovery", userId, externalId),
  },
  "aurral-mix": {
    rotating: true,
    fetch: ({ userId, externalId }) => importAurralPlaylist("mix", userId, externalId),
  },
  "aurral-share": {
    fetch: async ({ externalId }) => {
      const { manifest } = await loadRemoteShare(externalId);
      if (manifest.kind !== "playlist") throw new Error("This share is not a playlist.");
      const tracks = sharedPlaylistTracks(manifest);
      return {
        id: externalId,
        name: manifest.title,
        tracks,
        stats: {
          sourceItems: manifest.tracks.length,
          incomplete: manifest.tracks.length - tracks.length,
          duplicate: 0,
        },
      };
    },
  },
} satisfies Record<NativeImportProvider, Omit<ImportList, "label" | "sync">>;

export function importListFor(provider: string): ImportList | null {
  if (isNativeImportProvider(provider))
    return { label: IMPORT_PROVIDER_LABELS[provider], sync: true, ...nativeImportLists[provider] };
  return pluginImportList(provider);
}

export function requireImportList(provider: string) {
  const list = importListFor(provider);
  if (list) return list;
  const plugin = isImportProvider(provider);
  const error: CodedError = new Error(
    plugin
      ? "The import plugin is turned off"
      : `Unsupported playlist import provider: ${provider || "unknown"}`,
  );
  error.statusCode = plugin ? 404 : 400;
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
    ...(sourceStats && { skipped: sourceStats }),
  });
  return { ...result, playlistId: safePlaylistId, tracksQueued: tracks.length };
}
