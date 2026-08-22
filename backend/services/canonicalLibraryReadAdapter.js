import {
  getCanonicalArtistPage,
  getCanonicalLibraryForAlbumIds,
  getCanonicalLibraryForAlbumReferences,
  getCanonicalLibraryForArtistReferences,
  getCanonicalLibraryForArtists,
  getCanonicalTrackPath,
} from "./libraryQueryService.js";

const albumFiles = (track, albumId) =>
  (track.files || []).filter((file) => file.albumId == null || file.albumId === albumId);

const firstAvailableFile = (track, albumId) => {
  const albumSpecific = (track.files || []).filter((file) => file.albumId === albumId);
  const unscoped = (track.files || []).filter((file) => file.albumId == null);
  return albumSpecific.find((file) => file.available)
    || unscoped.find((file) => file.available)
    || albumSpecific[0]
    || unscoped[0]
    || null;
};

const recordMatches = (record, reference) => {
  const value = String(reference ?? "").trim();
  if (!value) return false;
  return [record.id, record.mbid, record.identityKey].some(
    (candidate) => String(candidate ?? "").trim() === value,
  );
};

const buildArtist = (artist, albumsByArtistId) => {
  const artistAlbums = albumsByArtistId.get(artist.id) || [];
  const hasSummary = artist.albumCount !== undefined;
  const trackCount = hasSummary
    ? Number(artist.trackCount || 0)
    : artistAlbums.reduce((count, album) => count + album.trackIds.length, 0);
  const sizeOnDisk = hasSummary
    ? Number(artist.sizeOnDisk || 0)
    : artistAlbums.reduce((total, album) => total + album.statistics.sizeOnDisk, 0);
  const providerId = artist.metadata?.id ?? null;
  return {
    id: artist.id,
    canonicalId: artist.id,
    providerId,
    mbid: artist.mbid,
    foreignArtistId: artist.metadata?.foreignArtistId || artist.mbid || artist.identityKey,
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
      albumCount: hasSummary ? Number(artist.albumCount || 0) : artistAlbums.length,
      trackCount,
      sizeOnDisk,
    },
    sources: artist.sources,
    available: artist.available,
  };
};

const buildAlbum = (album, artistsById, tracksById) => {
  const artist = artistsById.get(album.artistId);
  const albumTracks = album.trackIds
    .map((trackId) => tracksById.get(trackId))
    .filter(Boolean);
  const sizeOnDisk = albumTracks.reduce((total, track) => {
    const file = firstAvailableFile(track, album.id);
    return total + Number(file?.size || 0);
  }, 0);
  const trackFileCount = albumTracks.filter((track) =>
    albumFiles(track, album.id).some((file) => file.available),
  ).length;
  const providerId = album.metadata?.id ?? null;
  return {
    id: album.id,
    canonicalId: album.id,
    identityKey: album.identityKey,
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
        albumTracks.length > 0 && trackFileCount === albumTracks.length ? 100 : 0,
    },
    trackIds: [...album.trackIds],
    sources: album.sources,
    available: album.available,
  };
};

const buildTrack = (track, album) => {
  const file = firstAvailableFile(track, album.id);
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
    available: Boolean(file?.available),
    sources: track.sources,
  };
};

export function buildCanonicalLibraryReadModel(library) {
  const { artists, albums, tracks } = library;
  const artistsById = new Map(artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const readAlbums = albums.map((album) => buildAlbum(album, artistsById, tracksById));
  const albumsByArtistId = new Map();
  for (const album of readAlbums) {
    const artistAlbums = albumsByArtistId.get(album.artistId) || [];
    artistAlbums.push(album);
    albumsByArtistId.set(album.artistId, artistAlbums);
  }
  const readArtists = artists.map((artist) => buildArtist(artist, albumsByArtistId));
  const readTracks = readAlbums.flatMap((album) =>
    album.trackIds
      .map((trackId) => tracksById.get(trackId))
      .filter(Boolean)
      .map((track) => buildTrack(track, album)),
  );
  return { artists: readArtists, albums: readAlbums, tracks: readTracks };
}

export function getCanonicalLibraryReadModelForArtistPage({
  source = "lidarr",
  availableOnly = true,
  limit = 10000,
  offset = 0,
} = {}) {
  const library = getCanonicalArtistPage({ source, availableOnly, limit, offset, includeStats: true });
  return {
    artists: library.artists.map((artist) => buildArtist(artist, new Map())),
    albums: [],
    tracks: [],
  };
}

export function getCanonicalLibraryReadModelForArtists({
  source = "lidarr",
  availableOnly = true,
  mbids = [],
} = {}) {
  return buildCanonicalLibraryReadModel(
    getCanonicalLibraryForArtists({ source, availableOnly, mbids }),
  );
}

export function getCanonicalLibraryReadModelForArtistReferences({
  source = "all",
  availableOnly = false,
  references = [],
} = {}) {
  return buildCanonicalLibraryReadModel(
    getCanonicalLibraryForArtistReferences({ source, availableOnly, references }),
  );
}

export function getCanonicalLibraryReadModelForAlbumIds({
  source = "lidarr",
  availableOnly = true,
  ids = [],
} = {}) {
  return buildCanonicalLibraryReadModel(
    getCanonicalLibraryForAlbumIds({ source, availableOnly, ids }),
  );
}
export function getCanonicalLibraryReadModelForAlbumReferences({
  source = "lidarr",
  availableOnly = true,
  references = [],
} = {}) {
  return buildCanonicalLibraryReadModel(
    getCanonicalLibraryForAlbumReferences({ source, availableOnly, references }),
  );
}

export function resolveCanonicalTrackPath(albumReference, trackReference) {
  return getCanonicalTrackPath(albumReference, trackReference);
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
