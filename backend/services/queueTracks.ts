import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import { getLibraryForArtistReferences, getLibraryForTrackIds } from "./libraryQueryService.ts";
import { buildPublicLibrary } from "./publicLibrary.ts";

export function toQueueTracks(trackIds: number[]) {
  const library = buildPublicLibrary(getLibraryForTrackIds({ ids: trackIds, availableOnly: true }));
  const artists = new Map(library.artists.map((artist) => [artist.id, artist]));
  const albums = new Map(library.albums.map((album) => [album.id, album]));
  const tracks = new Map(library.tracks.map((track) => [track.id, track]));
  return trackIds.flatMap((trackId) => {
    const track = tracks.get(trackId);
    const playable = (track?.albums ?? []).flatMap(({ albumId }) => {
      const album = albums.get(albumId);
      const file = album && selectCanonicalFile(track?.files, album.id, Boolean(album.managed));
      return album && file?.available ? [{ album, file }] : [];
    });
    const [first] = playable;
    if (!track || !first) return [];
    const { album, file } = first;
    const artist = artists.get(album.artistId);
    const artworkUrl = "artworkUrl" in track ? track.artworkUrl : null;
    const creditedToArtist =
      !track.artistName || track.artistName.toLowerCase() === artist?.name.toLowerCase();
    return [
      {
        id: String(track.id),
        title: track.title || "Unknown Track",
        artist: track.artistName || artist?.name || "Unknown Artist",
        album: album.title || "Unknown Album",
        streamPath: `/library/stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
        streamFormat: file.format || null,
        quality: file.quality?.quality?.name || file.quality?.audioFormat || null,
        durationMs: file.durationMs ?? null,
        artistMbid: artist?.mbid ?? null,
        albumMbid: album.releaseGroupMbid || album.mbid || null,
        trackMbid: track.mbid ?? null,
        libraryTrackId: track.id,
        libraryAlbumId: album.id,
        libraryArtistId: creditedToArtist ? (artist?.id ?? null) : null,
        artworkUrl: artworkUrl || album.coverUrl,
        artworkSource: artworkUrl ? "track" : "album",
      },
    ];
  });
}

export function artistQueueTracks(reference: string) {
  const { albums, tracks } = getLibraryForArtistReferences({
    references: [reference],
    source: "all",
    availableOnly: true,
  });
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const trackIds = albums
    .toSorted(
      (left, right) =>
        (left.releaseDate ?? "").localeCompare(right.releaseDate ?? "") ||
        left.title.localeCompare(right.title),
    )
    .flatMap((album) =>
      album.trackIds
        .map((id) => ({
          id,
          position: tracksById.get(id)?.albums.find((entry) => entry.albumId === album.id),
        }))
        .toSorted(
          (left, right) =>
            (left.position?.discNumber ?? 0) - (right.position?.discNumber ?? 0) ||
            (left.position?.trackNumber ?? 0) - (right.position?.trackNumber ?? 0),
        )
        .map(({ id }) => id),
    );
  return toQueueTracks([...new Set(trackIds)]);
}
