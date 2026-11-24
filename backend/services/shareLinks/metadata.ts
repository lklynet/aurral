import {
  findSharedTrack,
  parseShareManifest,
  parseShareTrack,
} from "../../../lib/shareManifest.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { resolvePlaylistShareTracks, resolveShareTarget } from "./library.ts";
import {
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
} from "../libraryQueryService.ts";

export function resolveShareManifest(
  target: Parameters<typeof resolveShareTarget>[0],
  input: unknown,
  { includeFiles = true }: { includeFiles?: boolean } = {},
) {
  if (target.kind === "playlist") {
    const playlist = flowPlaylistConfig.getStaticPlaylist(target.targetRef);
    if (!playlist) return null;
    const needsLibrary =
      includeFiles ||
      playlist.tracks.some((track) => !track.artistMbid || !track.albumMbid || !track.trackMbid);
    const files = needsLibrary ? resolvePlaylistShareTracks(playlist) : [];
    const tracks = playlist.tracks.map((track, index) => {
      const file = files[index];
      const albumMatchesFile =
        !track.albumMbid || !file?.albumMbid || track.albumMbid === file.albumMbid;
      return {
        title: track.trackName,
        artistName: track.artistName,
        albumTitle: track.albumName,
        artistMbid: track.artistMbid || file?.artistMbid || null,
        albumMbid: track.albumMbid || file?.albumMbid || null,
        trackMbid: track.trackMbid || file?.trackMbid || null,
        releaseMbid: track.releaseMbid || (albumMatchesFile ? file?.releaseMbid || null : null),
        durationMs: track.durationMs ?? file?.durationMs ?? null,
        trackNumber: track.trackNumber,
        discNumber: track.discNumber,
        ...(includeFiles &&
          file && {
            path: `tracks/${file.albumId}/${file.trackId}`,
            size: file.file.size,
            format: file.file.format,
          }),
      };
    });
    return parseShareManifest({ kind: "playlist", title: playlist.name, tracks });
  }
  const supplied = parseShareManifest(input);
  if (!supplied) return null;
  const resolved = resolveShareTarget(target);
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
                releaseMbid: album.mbid,
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
  const tracks = metadata.map((track) => {
    const file = findSharedTrack(files, track);
    return {
      ...track,
      path: file?.path || null,
      size: file?.size || null,
      format: file?.format || null,
    };
  });
  const albumMbid =
    target.kind === "album" && library?.albums.length
      ? library.albums[0]?.releaseGroupMbid
      : target.kind === "track" && files.length
        ? files[0]?.albumMbid
        : supplied.albumMbid;
  return parseShareManifest({ ...supplied, ...resolved, albumMbid, tracks });
}
