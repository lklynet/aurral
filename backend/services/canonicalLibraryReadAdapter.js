import { getCanonicalLibrary } from "./libraryQueryService.js";

const firstAvailableFile = (track) =>
  (track.files || []).find((file) => file.available) || track.files?.[0] || null;

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
  return {
    id: artist.id,
    mbid: artist.mbid,
    foreignArtistId: artist.mbid || artist.identityKey,
    artistName: artist.name,
    name: artist.name,
    sortName: artist.sortName,
    addedAt: null,
    monitored: false,
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
  return {
    id: album.id,
    artistId: album.artistId,
    artistMbid: artist?.mbid || null,
    artistName: artist?.name || album.albumArtist,
    mbid: album.mbid || album.releaseGroupMbid,
    foreignAlbumId: album.mbid || album.releaseGroupMbid || album.identityKey,
    albumName: album.title,
    title: album.title,
    releaseDate: album.releaseDate,
    addedAt: null,
    monitored: false,
    statistics: {
      trackCount: albumTracks.length,
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

export function findCanonicalArtist(artists, reference) {
  return artists.find((artist) => recordMatches(artist, reference)) || null;
}

export function findCanonicalAlbumsForArtist(albums, reference) {
  return albums.filter(
    (album) =>
      recordMatches(album, reference) ||
      [album.artistId, album.artistMbid].some(
        (candidate) => String(candidate ?? "").trim() === String(reference ?? "").trim(),
      ),
  );
}

export function findCanonicalTracksForAlbum(tracks, reference) {
  return tracks.filter((track) => String(track.albumId) === String(reference));
}
