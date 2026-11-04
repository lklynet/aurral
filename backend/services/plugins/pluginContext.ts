import path from "node:path";
import type { RequestUser } from "../../middleware/requestUser.ts";
import {
  getLibraryForAlbumIds,
  getLibraryForArtistReferences,
  getLibraryForTrackIds,
  type LibraryAlbum,
  type LibraryTrack,
} from "../libraryQueryService.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { collectPlaylistFileTracks } from "../playlists/playlistFileTracks.ts";
import { readWrittenPlaylistFiles } from "../playlists/playlistFiles.ts";
import { playlistManager } from "../playlists/playlistManager.ts";
import type { PluginActionTarget } from "./pluginManifest.ts";

export class PluginTargetMissing extends Error {}

export type PluginActionTargetInput = {
  playlistId?: string;
  albumId?: string | number;
  artistId?: string | number;
  trackIds?: (string | number)[];
};

type Library = ReturnType<typeof getLibraryForTrackIds>;

const year = (date: string | null) => {
  const parsed = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

function trackContext(track: LibraryTrack, library: Library) {
  const file = track.files.find((entry) => entry.available) ?? track.files[0] ?? null;
  const placement = track.albums[0];
  const album = library.albums.find((entry) => entry.id === (file?.albumId ?? placement?.albumId));
  return {
    id: track.id,
    path: file?.path ?? null,
    title: track.title,
    artist: track.artistName ?? null,
    album: album?.title ?? null,
    durationMs: file?.durationMs ?? null,
    mbid: track.mbid,
    trackNumber: placement?.trackNumber ?? null,
    discNumber: placement?.discNumber ?? null,
  };
}

function albumContext(album: LibraryAlbum, library: Library) {
  const artist = library.artists.find((entry) => entry.id === album.artistId);
  const tracks = library.tracks
    .filter((track) => album.trackIds.includes(track.id))
    .map((track) => trackContext(track, library))
    .sort(
      (a, b) =>
        (a.discNumber ?? 0) - (b.discNumber ?? 0) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
    );
  return {
    id: album.id,
    title: album.title,
    artist: album.albumArtist ?? artist?.name ?? null,
    mbid: album.mbid,
    releaseGroupMbid: album.releaseGroupMbid,
    year: year(album.releaseDate),
    tracks,
  };
}

export async function playlistContext(user: RequestUser, playlistId: string) {
  const flow = flowPlaylistConfig.getFlowForUser(user, playlistId);
  const playlist = flow ?? flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId);
  if (!playlist) throw new PluginTargetMissing("Playlist not found");
  return playlistSnapshot(playlist.id, playlist.name, flow ? "flow" : "playlist");
}

export async function playlistSnapshot(id: string, name: string, kind: "flow" | "playlist") {
  const file = readWrittenPlaylistFiles()[id];
  return {
    id,
    name,
    kind,
    file: file ? path.join(playlistManager.libraryRoot, file) : null,
    tracks: await collectPlaylistFileTracks(id),
  };
}

export function albumTarget(albumId: unknown) {
  const library = getLibraryForAlbumIds({ ids: [albumId] });
  const album = library.albums[0];
  if (!album) throw new PluginTargetMissing("Album not found");
  return albumContext(album, library);
}

export function artistTarget(artistId: unknown) {
  const library = getLibraryForArtistReferences({ references: [artistId] });
  const artist = library.artists[0];
  if (!artist) throw new PluginTargetMissing("Artist not found");
  return {
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    albums: library.albums
      .filter((album) => album.artistId === artist.id)
      .map((album) => ({
        id: album.id,
        title: album.title,
        mbid: album.mbid,
        year: year(album.releaseDate),
      })),
  };
}

export function tracksTarget(trackIds: unknown[]) {
  const library = getLibraryForTrackIds({ ids: trackIds });
  if (!library.tracks.length) throw new PluginTargetMissing("Track not found");
  return library.tracks.map((track) => trackContext(track, library));
}

export async function actionTarget(
  user: RequestUser,
  target: PluginActionTarget,
  input: PluginActionTargetInput,
) {
  if (target === "playlist") {
    if (!input.playlistId) throw new PluginTargetMissing("Choose a playlist");
    return { playlist: await playlistContext(user, input.playlistId) };
  }
  if (target === "album") return { album: albumTarget(input.albumId) };
  if (target === "artist") return { artist: artistTarget(input.artistId) };
  return { tracks: tracksTarget(input.trackIds ?? []) };
}
