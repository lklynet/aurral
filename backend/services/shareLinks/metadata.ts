import { parseShareManifest, parseShareTrack } from "../../../lib/shareManifest.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { resolveShareTarget } from "./library.ts";
import {
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
} from "../libraryQueryService.ts";

export function resolveShareManifest(
  target: Parameters<typeof resolveShareTarget>[0],
  input: unknown,
) {
  const resolved = resolveShareTarget(target);
  if (target.kind === "playlist") {
    const playlist = flowPlaylistConfig.getStaticPlaylist(target.targetRef);
    if (!playlist) return null;
    const tracks = playlist.tracks.map((track) => {
      const file = resolved?.tracks.find((entry) =>
        track.trackMbid
          ? track.trackMbid === entry.trackMbid
          : track.trackName.toLowerCase() === entry.title.toLowerCase() &&
            track.artistName.toLowerCase() === entry.artistName.toLowerCase() &&
            (!track.albumName || track.albumName.toLowerCase() === entry.albumTitle.toLowerCase()),
      );
      return {
        title: track.trackName,
        artistName: track.artistName,
        albumTitle: track.albumName,
        artistMbid: track.artistMbid,
        albumMbid: track.albumMbid,
        trackMbid: track.trackMbid,
        releaseMbid: track.releaseMbid,
        durationMs: track.durationMs,
        trackNumber: track.trackNumber,
        discNumber: track.discNumber,
        ...(file
          ? {
              ...file,
              path: `tracks/${file.albumId}/${file.trackId}`,
              size: file.file.size,
              format: file.file.format,
            }
          : {}),
      };
    });
    return parseShareManifest({ kind: "playlist", title: playlist.name, tracks });
  }
  const supplied = parseShareManifest(input);
  if (!supplied) return null;
  const files = (resolved?.tracks || [])
    .map((track) =>
      parseShareTrack({
        ...track,
        path: `tracks/${track.albumId}/${track.trackId}`,
        format: track.file.format,
        size: track.file.size,
      }),
    )
    .filter((track) => track !== null);
  const library =
    target.kind === "album"
      ? getLibraryForAlbumReferences({ references: [target.targetRef] })
      : target.kind === "artist"
        ? getLibraryForArtistReferences({ references: [target.targetRef] })
        : null;
  const libraryTracks =
    library?.albums.flatMap((album) => {
      const artist = library.artists.find((entry) => entry.id === album.artistId);
      return album.trackIds
        .map((id) => {
          const track = library.tracks.find((entry) => entry.id === id);
          const position = track?.albums.find((entry) => entry.albumId === album.id);
          return track
            ? parseShareTrack({
                title: track.title,
                artistName: track.artistName || artist?.name,
                albumTitle: album.title,
                albumArtistName: artist?.name,
                artistMbid: artist?.mbid,
                albumMbid: album.releaseGroupMbid,
                trackMbid: track.mbid,
                trackNumber: position?.trackNumber,
                discNumber: position?.discNumber,
              })
            : null;
        })
        .filter((track) => track !== null);
    }) || [];
  const metadata = supplied.tracks.length
    ? supplied.tracks
    : libraryTracks.length
      ? libraryTracks
      : files;
  const tracks = metadata.map(
    (track) =>
      files.find((file) =>
        track.trackMbid
          ? file.trackMbid === track.trackMbid
          : track.title === file.title &&
            track.artistName === file.artistName &&
            track.albumTitle === file.albumTitle,
      ) || { ...track, path: null, size: null, format: null },
  );
  return parseShareManifest({ ...supplied, ...resolved, tracks });
}
