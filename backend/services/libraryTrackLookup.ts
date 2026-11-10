import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import { getCustomArtworkMap } from "./customArtworkService.ts";
import {
  getLibraryForTrackMatches,
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
} from "./libraryQueryService.ts";
import {
  normalizePlaylistTrack,
  tracksShareMembership,
  type PlaylistTrackInput,
} from "./playlists/playlistTracks.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";

export type StarredAt = Map<string, string>;
export type Rating = { userRating?: number; averageRating: number };
export type Viewer = { starredAt?: StarredAt | null; ratings?: Map<string, Rating> | null };
export type LibraryInput = Viewer & {
  artists: LibraryArtist[];
  albums: LibraryAlbum[];
  tracks: LibraryTrack[];
};
export type IndexedLibrary = ReturnType<typeof indexFocusedLibrary>;

export const firstFile = (
  track: LibraryTrack | null | undefined,
  albumId: number | null = null,
  managedBy: string | null = null,
) => selectCanonicalFile(track?.files, albumId, managedBy);

export const year = (value: string | null | undefined) => {
  const match = /^(\d{4})/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
};

export const findAlbumForTrack = (
  library: IndexedLibrary,
  track: LibraryTrack | null | undefined,
) => {
  const albumId = track?.albums?.[0]?.albumId;
  return (albumId === undefined ? undefined : library.albumsById.get(albumId)) || null;
};

export const findArtistForAlbum = (
  library: IndexedLibrary,
  album: LibraryAlbum | null | undefined,
) => (album ? library.artistsById.get(album.artistId) : undefined) || null;

export const indexFocusedLibrary = (library: LibraryInput, viewer: Viewer = library) => ({
  ...library,
  starredAt: viewer.starredAt,
  ratings: viewer.ratings,
  customAlbumArtwork: getCustomArtworkMap(
    "album",
    library.albums.map((album) => album.id),
  ),
  customTrackArtwork: getCustomArtworkMap(
    "track",
    library.tracks.map((track) => track.id),
  ),
  artistsById: new Map(library.artists.map((artist) => [artist.id, artist])),
  albumsById: new Map(library.albums.map((album) => [album.id, album])),
  tracksById: new Map(library.tracks.map((track) => [track.id, track])),
  artistsByIdentity: new Map(library.artists.map((artist) => [artist.identityKey, artist])),
  albumsByIdentity: new Map(library.albums.map((album) => [album.identityKey, album])),
  tracksByIdentity: new Map(library.tracks.map((track) => [track.identityKey, track])),
});

const isSameTrack = (
  left: PlaylistTrackInput | null | undefined,
  right: PlaylistTrackInput | null | undefined,
) => tracksShareMembership(left, right);

export const trackFromLibrary = (
  library: IndexedLibrary,
  track: LibraryTrack | null | undefined,
) => {
  const album = findAlbumForTrack(library, track);
  const owner = findArtistForAlbum(library, album);
  const ownerCredit = Boolean(owner?.name) && !isVariousArtistsCredit(owner!.name, owner!.mbid);
  return normalizePlaylistTrack({
    artistName: ownerCredit ? owner!.name : track?.artistName || owner?.name,
    trackName: track?.title,
    albumName: album?.title,
    artistMbid: owner?.mbid,
    albumMbid: album?.releaseGroupMbid || album?.mbid,
    trackMbid: track?.mbid,
    releaseYear: year(album?.releaseDate),
    durationMs: firstFile(track, album?.id, album?.managedBy)?.durationMs,
    trackNumber: track?.albums?.[0]?.trackNumber,
  });
};

const matchesLibraryTrack = (
  track: PlaylistTrackInput,
  library: IndexedLibrary,
  entry: LibraryTrack,
) => {
  const libraryTrack = trackFromLibrary(library, entry);
  if (!libraryTrack) return false;
  return (
    isSameTrack(track, libraryTrack) ||
    (Boolean(entry.artistName) &&
      isSameTrack(track, { ...libraryTrack, artistName: entry.artistName }))
  );
};

// Resolve playlist track descriptors to available library tracks. All descriptors of a batch are
// looked up in one library query (by recording MBID and by title), then matched in memory with
// the same rule the playlist code uses, so a 1000-entry playlist costs a couple of statements.
export function resolveLibraryTracks(descriptors: (PlaylistTrackInput | null | undefined)[]) {
  const items = (Array.isArray(descriptors) ? descriptors : []).map((entry) =>
    normalizePlaylistTrack(entry),
  );
  const present = items.filter((track): track is NonNullable<typeof track> => Boolean(track));
  if (!present.length) return items.map(() => null);
  const library = indexFocusedLibrary(
    getLibraryForTrackMatches({
      source: "all",
      availableOnly: true,
      mbids: present.map((track) => track.trackMbid),
      titles: present.map((track) => track.trackName),
    }),
  );
  const byTitle = new Map<string, LibraryTrack[]>();
  const byMbid = new Map<string, LibraryTrack>();
  for (const track of library.tracks) {
    const title = String(track.title || "")
      .trim()
      .toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title)!.push(track);
    if (track.mbid && !byMbid.has(track.mbid)) byMbid.set(track.mbid, track);
  }
  const resolveFile = (entry: LibraryTrack) => {
    const album = findAlbumForTrack(library, entry);
    return { album, file: firstFile(entry, album?.id, album?.managedBy) };
  };
  const playable = (entry: LibraryTrack) => {
    const { file } = resolveFile(entry);
    return Boolean(file?.available && file.path);
  };
  return items.map((track) => {
    if (!track) return null;
    // A shared recording MBID identifies the track even when the titles differ (remaster, typo).
    const byId = track.trackMbid ? byMbid.get(track.trackMbid) : null;
    const candidates = byTitle.get(track.trackName.toLowerCase()) || [];
    const match =
      byId && playable(byId)
        ? byId
        : candidates.find((entry) => playable(entry) && matchesLibraryTrack(track, library, entry));
    if (!match) return null;
    const { album, file } = resolveFile(match);
    return { file, library, track: match, albumName: album?.title };
  });
}
