import { db } from "../../config/db-sqlite.ts";
import { toQueueTracks } from "../queueTracks.ts";
import { normalizePlaylistTrack } from "../playlists/playlistTracks.ts";
import { resolveLibraryTracks } from "../libraryTrackLookup.ts";
import { getDiscoveryPlaylist, type CatalogTrack } from "./discoveryPlaylists.ts";
import { getUserMix } from "./mixes.ts";
import type { LibraryMediaFilesRow } from "../../db/rows.ts";

export type AurralProvider = "discovery" | "mix";

type QueueTrack = ReturnType<typeof toQueueTracks>[number];

const notFound = (message: string) =>
  Object.assign(new Error(message), { statusCode: 404, code: "PLAYLIST_NOT_FOUND" });

const ownedFileStmt = db.prepare<[number, number], Pick<LibraryMediaFilesRow, "path">>(
  `SELECT path FROM library_media_files
   WHERE track_id = ? AND album_id = ? AND available = 1 AND source != 'flow' LIMIT 1`,
);

const fromQueueTrack = (track: QueueTrack) => ({
  artistName: track.artist,
  trackName: track.title,
  albumName: track.album,
  durationMs: track.durationMs,
  preview_url: null,
  artworkUrl: track.artworkUrl,
  deezerAlbumId: null,
  owned: track,
});

export function withOwnedTracks(tracks: CatalogTrack[]) {
  const matches = resolveLibraryTracks(tracks);
  const owned = new Map(
    toQueueTracks(matches.flatMap((match) => (match ? [match.track.id] : []))).map((track) => [
      track.libraryTrackId,
      track,
    ]),
  );
  return tracks.map((track, index) => {
    const match = matches[index];
    return { ...track, owned: (match && owned.get(match.track.id)) || null };
  });
}

export async function getAurralPlaylist(provider: AurralProvider, userId: number, id: string) {
  if (provider === "discovery") {
    const playlist = getDiscoveryPlaylist(userId, id);
    if (!playlist) throw notFound("This playlist isn't available anymore");
    return { ...playlist, provider, tracks: withOwnedTracks(playlist.tracks) };
  }
  const mix = await getUserMix(userId, id);
  if (!mix) throw notFound("This mix isn't available anymore");
  return { ...mix, provider, tracks: toQueueTracks(mix.trackIds).map(fromQueueTrack) };
}

export async function importAurralPlaylist(
  provider: AurralProvider,
  userId: number | undefined,
  id: string,
) {
  if (userId === undefined) throw notFound("This playlist has no owner");
  const playlist = await getAurralPlaylist(provider, userId, id);
  const tracks = playlist.tracks.flatMap((track) => {
    const normalized = normalizePlaylistTrack(track);
    if (!normalized) return [];
    const file =
      track.owned && ownedFileStmt.get(track.owned.libraryTrackId, track.owned.libraryAlbumId);
    return [file ? { ...normalized, path: file.path } : normalized];
  });
  return {
    id,
    name: playlist.name,
    description: playlist.description,
    tracks,
    stats: {
      sourceItems: playlist.tracks.length,
      incomplete: playlist.tracks.length - tracks.length,
      duplicate: 0,
    },
  };
}
