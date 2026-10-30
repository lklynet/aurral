import {
  getLibraryArtistPage,
  getLibraryForAlbumIds,
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForArtists,
  getLibraryTrackPath,
  type LibraryTrackFile,
} from "./libraryQueryService.ts";
import { getManagedByMap, type LibraryOwner } from "./libraryManagementStore.ts";
import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import type { LibraryMetadata } from "./libraryMetadata.ts";

type ManagementByEntityId = ReturnType<typeof getManagedByMap>;

type LibraryArtistRecord = {
  id: number;
  identityKey: string;
  mbid: string | null;
  name: string;
  sortName: string | null;
  metadata: LibraryMetadata | null;
  source?: string | null;
  sources?: string[];
  available: boolean;
  albumCount?: number;
  trackCount?: number;
  sizeOnDisk?: number;
};

type LibraryAlbumRecord = {
  id: number;
  identityKey: string;
  mbid: string | null;
  releaseGroupMbid: string | null;
  artistId: number;
  title: string;
  albumArtist: string | null;
  releaseDate: string | null;
  metadata: LibraryMetadata | null;
  managedBy?: LibraryOwner | null;
  source?: string | null;
  trackIds: number[];
  sources: string[];
  available: boolean;
};

type LibraryTrackRecord = {
  id: number;
  identityKey: string;
  mbid: string | null;
  title: string;
  artistName: string | null;
  metadata: LibraryMetadata | null;
  monitored: boolean;
  keepFile: boolean;
  albums: { albumId: number; discNumber: number; trackNumber: number }[];
  files: LibraryTrackFile[];
  sources: string[];
  available: boolean;
};

type LibraryReadInput = {
  artists: LibraryArtistRecord[];
  albums: LibraryAlbumRecord[];
  tracks: LibraryTrackRecord[];
};

type ReadArtist = ReturnType<typeof buildArtist>;
type ReadAlbum = ReturnType<typeof buildAlbum>;
type ReadTrack = ReturnType<typeof buildTrack>;

const albumFiles = (track: LibraryTrackRecord, albumId: number) =>
  (track.files || []).filter((file) => file.albumId == null || file.albumId === albumId);

const recordMatches = (record: ReadArtist, reference: unknown) => {
  const value = String(reference ?? "").trim();
  if (!value) return false;
  return [record.id, record.canonicalId, record.providerId, record.mbid, record.identityKey].some(
    (candidate) => String(candidate ?? "").trim() === value,
  );
};

const buildArtist = (
  artist: LibraryArtistRecord,
  albumsByArtistId: Map<number, ReadAlbum[]>,
  managementByArtistId: ManagementByEntityId = new Map(),
) => {
  const artistAlbums = albumsByArtistId.get(artist.id) || [];
  const hasSummary = artist.albumCount !== undefined;
  const trackCount = hasSummary
    ? Number(artist.trackCount || 0)
    : artistAlbums.reduce((count, album) => count + album.trackIds.length, 0);
  const sizeOnDisk = hasSummary
    ? Number(artist.sizeOnDisk || 0)
    : artistAlbums.reduce((total, album) => total + album.statistics.sizeOnDisk, 0);
  const providerId = artist.metadata?.id ?? null;
  const management = managementByArtistId.get(Number(artist.id)) || null;
  return {
    id: artist.id,
    canonicalId: artist.id,
    identityKey: artist.identityKey,
    providerId,
    lidarrManaged: artist.metadata?.librarySource === "lidarr",
    source: artist.source || (artist.sources?.length === 1 ? artist.sources[0] : null),
    managedBy: management?.managedBy ?? null,
    monitorMode: management?.monitorMode ?? null,
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

const buildAlbum = (
  album: LibraryAlbumRecord,
  artistsById: Map<number, LibraryArtistRecord>,
  tracksById: Map<number, LibraryTrackRecord>,
  managementByAlbumId: ManagementByEntityId = new Map(),
) => {
  const artist = artistsById.get(album.artistId);
  const albumTracks = album.trackIds
    .map((trackId) => tracksById.get(trackId))
    .filter(Boolean) as LibraryTrackRecord[];
  const sizeOnDisk = albumTracks.reduce((total, track) => {
    const file = selectCanonicalFile(track.files, album.id, album.managedBy);
    return total + (file?.available ? Number(file.size || 0) : 0);
  }, 0);
  const trackFileCount = albumTracks.filter((track) =>
    albumFiles(track, album.id).some((file) => file.available),
  ).length;
  const providerId = album.metadata?.id ?? null;
  const management = managementByAlbumId.get(Number(album.id)) || null;
  return {
    id: album.id,
    canonicalId: album.id,
    identityKey: album.identityKey,
    providerId,
    source: album.source || (album.sources?.length === 1 ? album.sources[0] : null),
    managedBy: management?.managedBy ?? null,
    monitorMode: management?.monitorMode ?? null,
    providerArtistId: album.metadata?.artistId ?? null,
    artistId: album.artistId,
    artistMbid: artist?.mbid || null,
    artistName: artist?.name || album.albumArtist,
    mbid: album.mbid || album.releaseGroupMbid,
    releaseGroupMbid: album.releaseGroupMbid || null,
    foreignAlbumId:
      album.metadata?.foreignAlbumId || album.mbid || album.releaseGroupMbid || album.identityKey,
    albumName: album.title,
    title: album.title,
    releaseDate: album.releaseDate,
    addedAt: null,
    monitored: Boolean(album.metadata?.monitored),
    trackListComplete:
      management?.managedBy !== "aurral" ||
      album.metadata?.trackListComplete === true ||
      Boolean(album.metadata?.trackList?.release),
    statistics: {
      trackCount: albumTracks.length,
      trackFileCount,
      sizeOnDisk,
      percentOfTracks: albumTracks.length > 0 && trackFileCount === albumTracks.length ? 100 : 0,
    },
    trackIds: [...album.trackIds],
    sources: album.sources,
    available: album.available,
  };
};

const buildTrack = (track: LibraryTrackRecord, album: ReadAlbum) => {
  const file: LibraryTrackFile | null = selectCanonicalFile(track.files, album.id, album.managedBy);
  const relation = track.albums.find((entry) => entry.albumId === album.id);
  return {
    id: track.id,
    canonicalId: track.id,
    providerId: track.metadata?.id ?? null,
    albumId: album.id,
    artistId: album.artistId,
    mbid: track.mbid,
    foreignTrackId:
      track.metadata?.foreignRecordingId ||
      track.metadata?.foreignTrackId ||
      track.mbid ||
      track.identityKey,
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
    managedBy: album.managedBy ?? null,
    monitorMode: album.monitorMode ?? null,
    monitored: track.monitored !== false,
    keepFile: track.keepFile === true,
    available: Boolean(file?.available),
    sources: track.sources,
  };
};

export function buildLibraryReadModel(library: LibraryReadInput) {
  const { artists, albums, tracks } = library;
  const artistsById = new Map(artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const management = {
    artist: getManagedByMap("artist"),
    album: getManagedByMap("album"),
  };
  const readAlbums = albums.map((album) =>
    buildAlbum(album, artistsById, tracksById, management.album),
  );
  const albumsByArtistId = new Map<number, ReadAlbum[]>();
  for (const album of readAlbums) {
    const artistAlbums = albumsByArtistId.get(album.artistId) || [];
    artistAlbums.push(album);
    albumsByArtistId.set(album.artistId, artistAlbums);
  }
  const readArtists = artists.map((artist) =>
    buildArtist(artist, albumsByArtistId, management.artist),
  );
  const readTracks = readAlbums.flatMap((album) =>
    (
      album.trackIds
        .map((trackId) => tracksById.get(trackId))
        .filter(Boolean) as LibraryTrackRecord[]
    ).map((track) => buildTrack(track, album)),
  );
  return { artists: readArtists, albums: readAlbums, tracks: readTracks };
}

export function getLibraryReadModelForArtistPage({
  source = "lidarr",
  availableOnly = true,
  limit = 10000,
  offset = 0,
}: { source?: unknown; availableOnly?: boolean; limit?: number; offset?: number } = {}) {
  const library = getLibraryArtistPage({
    source,
    availableOnly,
    limit,
    offset,
    includeStats: true,
  });
  return {
    artists: (library.artists as LibraryArtistRecord[]).map((artist) =>
      buildArtist(artist, new Map(), getManagedByMap("artist")),
    ),
    albums: [],
    tracks: [],
  };
}

export function getLibraryReadModelForArtists({
  source = "lidarr",
  availableOnly = true,
  mbids = [],
  includeSharedAlbums = false,
}: {
  source?: unknown;
  availableOnly?: boolean;
  mbids?: string[];
  includeSharedAlbums?: boolean;
} = {}) {
  return buildLibraryReadModel(
    getLibraryForArtists({ source, availableOnly, mbids, includeSharedAlbums }),
  );
}

export function getLibraryReadModelForArtistReferences({
  source = "all",
  availableOnly = false,
  references = [],
  includeSharedAlbums = false,
}: {
  source?: unknown;
  availableOnly?: boolean;
  references?: unknown[];
  includeSharedAlbums?: boolean;
} = {}) {
  return buildLibraryReadModel(
    getLibraryForArtistReferences({ source, availableOnly, references, includeSharedAlbums }),
  );
}

export function getLibraryReadModelForAlbumIds({
  source = "lidarr",
  availableOnly = true,
  ids = [],
} = {}) {
  return buildLibraryReadModel(getLibraryForAlbumIds({ source, availableOnly, ids }));
}
export function getLibraryReadModelForAlbumReferences({
  source = "lidarr",
  availableOnly = true,
  references = [],
}: { source?: unknown; availableOnly?: boolean; references?: unknown[] } = {}) {
  return buildLibraryReadModel(getLibraryForAlbumReferences({ source, availableOnly, references }));
}

export function resolveLibraryTrackPath(albumReference: string, trackReference: string) {
  return getLibraryTrackPath(albumReference, trackReference);
}

export function findLibraryArtist(artists: ReadArtist[], reference: unknown) {
  return artists.find((artist) => recordMatches(artist, reference)) || null;
}

export function findLibraryTracksForAlbum(tracks: ReadTrack[], reference: unknown) {
  return tracks.filter((track) => String(track.albumId) === String(reference));
}
