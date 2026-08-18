import { getCanonicalLibrary } from "./libraryQueryService.js";

const firstAvailableFile = (track) =>
  (track.files || []).find((file) => file.available) || track.files?.[0] || null;

const firstReadableFile = (track) => (track?.files || []).find((file) => file.available) || null;

const recordMatches = (record, reference) => {
  const value = String(reference ?? "").trim();
  if (!value) return false;
  return [record.id, record.mbid, record.identityKey].some(
    (candidate) => String(candidate ?? "").trim() === value,
  );
};

const buildArtist = (artist, albums) => {
  const artistAlbums = albums.filter((album) => album.artistId === artist.id);
  const trackCount = artistAlbums.reduce((count, album) => count + album.trackIds.length, 0);
  const sizeOnDisk = artistAlbums.reduce((total, album) => total + album.statistics.sizeOnDisk, 0);
  const providerId = artist.metadata?.id ?? null;
  return {
    id: artist.id,
    canonicalId: artist.id,
    providerId,
    mbid: artist.mbid,
    foreignArtistId: artist.mbid || artist.identityKey,
    artistName: artist.name,
    name: artist.name,
    sortName: artist.sortName,
    addedAt: null,
    monitored: Boolean(artist.metadata?.monitored),
    monitorOption:
      artist.metadata?.monitorOption ||
      artist.metadata?.addOptions?.monitor ||
      artist.metadata?.monitor ||
      "none",
    addOptions: artist.metadata?.addOptions || null,
    statistics: {
      albumCount: artistAlbums.length,
      trackCount,
      sizeOnDisk,
    },
    sources: artist.sources,
    available: artist.available,
  };
};

const buildAlbum = (album, artists, tracks) => {
  const artist = artists.find((candidate) => candidate.id === album.artistId);
  const albumTracks = album.trackIds
    .map((trackId) => tracks.find((track) => track.id === trackId))
    .filter(Boolean);
  const sizeOnDisk = albumTracks.reduce((total, track) => {
    const file = firstAvailableFile(track);
    return total + Number(file?.size || 0);
  }, 0);
  const trackFileCount = albumTracks.filter((track) => track.available).length;
  const providerId = album.metadata?.id ?? null;
  return {
    id: album.id,
    canonicalId: album.id,
    providerId,
    providerArtistId: album.metadata?.artistId ?? null,
    artistId: album.artistId,
    artistMbid: artist?.mbid || null,
    artistName: artist?.name || album.albumArtist,
    mbid: album.mbid || album.releaseGroupMbid,
    releaseGroupMbid: album.releaseGroupMbid || null,
    foreignAlbumId: album.mbid || album.releaseGroupMbid || album.identityKey,
    albumName: album.title,
    title: album.title,
    releaseDate: album.releaseDate,
    addedAt: null,
    monitored: Boolean(album.metadata?.monitored),
    statistics: {
      trackCount: albumTracks.length,
      trackFileCount,
      sizeOnDisk,
      percentOfTracks:
        albumTracks.length > 0 && albumTracks.every((track) => track.available) ? 100 : 0,
    },
    trackIds: album.trackIds,
    sources: album.sources,
    available: album.available,
  };
};

const buildTrack = (track, album) => {
  const file = firstAvailableFile(track);
  const relation = track.albums.find((entry) => entry.albumId === album.id);
  return {
    id: track.id,
    albumId: album.id,
    artistId: album.artistId,
    mbid: track.mbid,
    trackName: track.title,
    title: track.title,
    trackNumber: relation?.trackNumber || 0,
    path: file?.path || null,
    hasFile: Boolean(file?.available),
    size: Number(file?.size || 0),
    quality: file?.quality || null,
    streamFormat: file?.format || null,
    addedAt: null,
    source: file?.source || null,
    available: track.available,
    sources: track.sources,
  };
};

export function buildCanonicalLibraryReadModel(library) {
  const artists = library.artists.map((artist) => ({ ...artist }));
  const albums = library.albums.map((album) => ({
    ...album,
    trackIds: [...album.trackIds],
  }));
  const tracks = library.tracks.map((track) => ({
    ...track,
    albums: [...track.albums],
    files: [...track.files],
  }));
  const readAlbums = albums.map((album) => buildAlbum(album, artists, tracks));
  const readArtists = artists.map((artist) => buildArtist(artist, readAlbums));
  const readTracks = readAlbums.flatMap((album) =>
    album.trackIds
      .map((trackId) => tracks.find((track) => track.id === trackId))
      .filter(Boolean)
      .map((track) => buildTrack(track, album)),
  );
  return { artists: readArtists, albums: readAlbums, tracks: readTracks };
}

export function getCanonicalLibraryReadModel({ source = "lidarr", availableOnly = true } = {}) {
  return buildCanonicalLibraryReadModel(getCanonicalLibrary({ source, availableOnly }));
}

export function resolveCanonicalTrackPath(reference) {
  const value = String(reference ?? "").trim();
  if (!value) return null;
  const library = getCanonicalLibrary({ availableOnly: false });
  const track = library.tracks.find((candidate) =>
    [candidate.id, candidate.identityKey, candidate.mbid].some(
      (valueCandidate) => String(valueCandidate ?? "").trim() === value,
    ),
  );
  return firstReadableFile(track)?.path || null;
}

export function findCanonicalArtist(artists, reference) {
  return artists.find((artist) => recordMatches(artist, reference)) || null;
}

export function findCanonicalAlbumsForArtist(albums, reference) {
  const normalizedReference = String(reference ?? "").trim();
  if (!normalizedReference) return [];

  return albums.filter(
    (album) =>
      [album.artistId, album.artistMbid].some(
        (candidate) => String(candidate ?? "").trim() === normalizedReference,
      ),
  );
}

export function findCanonicalTracksForAlbum(tracks, reference) {
  return tracks.filter((track) => String(track.albumId) === String(reference));
}
