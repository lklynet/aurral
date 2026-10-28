import { audioContentType } from "./audioFileStream.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { RequestUser } from "../middleware/requestUser.ts";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { db } from "../config/db-sqlite.ts";
import {
  getLibraryAlbumPage,
  getLibraryArtistPage,
  getLibraryFavoriteTargetKeys,
  getLibraryGenres,
  getLibrary,
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForTrackMatches,
  getLibrarySearchPage,
  getLibraryTopTracks,
  getLibraryIndexLastModified,
  getLibraryTrack,
  getLibraryTrackPage,
} from "./libraryQueryService.ts";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.ts";
import { getLibraryArtwork } from "./libraryArtwork.ts";
import { buildImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import type { DownloadJob } from "./downloadJobs/downloadTracker.ts";
import type {
  PlaylistTrack,
  PlaylistTrackInput,
  StaticPlaylist,
  StaticPlaylistUpdates,
} from "./playlists/flowPlaylistConfig.ts";
import {
  flowPlaylistConfig,
  normalizePlaylistTrack,
  playlistJobEntries,
  tracksShareMembership,
} from "./playlists/flowPlaylistConfig.ts";
import { playlistManager } from "./playlists/playlistManager.ts";
import { getPlaylistArtworkRevisions, getPlaylistArtworkState } from "./playlistArtworkState.ts";
import { downloadWorker } from "./downloadJobs/downloadWorker.ts";
import { hasPermission } from "../middleware/auth.ts";
import { recordTrackJobQueued } from "./aurralHistoryService.ts";
import { selectCanonicalFile } from "./canonicalFileSelector.ts";
import type {
  LibraryAlbum,
  LibraryArtist,
  LibraryTrack,
  LibraryTrackFile,
} from "./libraryQueryService.ts";
import type { LibraryAlbumsRow, SubsonicStarChangesRow, SubsonicStarsRow } from "../db/rows.ts";
import { subsonicId as idFor } from "./libraryMediaStore.ts";
import { asAppError } from "../../lib/errors.ts";
import { logger } from "./logger.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { withHonkerLock } from "./honkerDb.ts";
import { jobDownloadedItsFile, removePlaylistFileIfUnshared } from "./downloadJobs/fileReuse.ts";
import { withPlaylistMutationLock } from "./downloadJobs/mutationGuards.ts";
import { transferDownloadOwnershipInTransaction } from "./downloadJobs/downloadOwnership.ts";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "./downloadJobs/downloadCancellation.ts";
import { processPlaylistOperation } from "./playlists/playlistOperations.ts";
import { cancelDownloadWorkForJobs } from "./downloadJobs/downloadCancellationService.ts";
import {
  getCustomArtwork,
  getCustomArtworkMap,
  getCustomArtworkRevision,
} from "./customArtworkService.ts";

const LIBRARY_IMAGE_PROFILE = "library";

type SubsonicUser = RequestUser | null | undefined;
type StarredAt = Map<string, string>;
type LibraryInput = {
  artists: LibraryArtist[];
  albums: LibraryAlbum[];
  tracks: LibraryTrack[];
  starredAt?: StarredAt | null;
};
type IndexedLibrary = ReturnType<typeof indexFocusedLibrary>;
type PlaylistOwner = { id: string; tracks?: PlaylistTrack[] };
type StarRow = Pick<SubsonicStarsRow, "entity_kind" | "entity_key" | "created_at">;
type StarKey = Pick<StarRow, "entity_kind" | "entity_key">;
type ParsedKind =
  | "artist"
  | "album"
  | "song"
  | "flow"
  | "flow-song"
  | "shared"
  | "shared-song"
  | "art-album"
  | "art-track"
  | "art-playlist"
  | "art-playlist-track";
type ParsedId = { [K in ParsedKind]: { kind: K; key: string } }[ParsedKind];
type StarredResult = { album: SubsonicAlbum[]; artist: SubsonicArtist[]; song: SubsonicSong[] };
type SubsonicQuery = {
  musicFolderId?: string;
  genre?: string;
  fromYear?: string;
  toYear?: string;
  size?: string;
  type?: string;
  offset?: string;
  count?: string;
  artistCount?: string;
  artistOffset?: string;
  albumCount?: string;
  albumOffset?: string;
  songCount?: string;
  songOffset?: string;
};
type ProtocolArtist = { id: string; name: string; musicBrainzId: string };
type SubsonicGenreFields = { genre?: string; genres?: { name: string }[] };
type SubsonicSong = {
  id: string;
  parent: string;
  isDir: boolean;
  isVideo: boolean;
  title: string | null;
  album: string;
  artist: string;
  albumId?: string;
  artistId: string;
  albumArtists: ProtocolArtist[];
  artists: ProtocolArtist[];
  contentType: string;
  created: string;
  track: number;
  discNumber: number;
  coverArt?: string;
  duration: number;
  size: number;
  suffix: string;
  path: string;
  type: string;
  starred?: string;
  musicBrainzId: string;
  mediaType: string;
  bitRate?: number;
  year?: number;
} & SubsonicGenreFields;
type LibrarySong = SubsonicSong & { title: string };
type SubsonicAlbum = {
  id: string;
  name: string;
  title: string;
  album: string;
  artist: string;
  artistId: string;
  artists: ProtocolArtist[];
  parent: string;
  isDir: boolean;
  isVideo: boolean;
  created: string;
  coverArt: string;
  songCount: number;
  duration: number;
  song: SubsonicSong[];
  starred?: string;
  musicBrainzId: string;
  mediaType: string;
  year?: number;
} & SubsonicGenreFields;
type SubsonicArtist = {
  id: string;
  name: string;
  coverArt: string;
  albumCount: number;
  album?: SubsonicAlbum[];
  starred?: string;
  musicBrainzId: string;
  mediaType: string;
} & SubsonicGenreFields;
type SubsonicPlaylist = {
  id: string;
  name: string;
  owner: string;
  coverArt: string;
  songCount: number;
  duration: number;
  public: boolean;
  created: string;
  changed: string;
  comment?: string;
};

const parseId = (value: unknown): ParsedId | null => {
  const match =
    /^(artist|album|song|flow|flow-song|shared|shared-song|art-album|art-track|art-playlist|art-playlist-track):(.+)$/.exec(
      String(value || ""),
    );
  if (!match) return null;
  try {
    return { kind: match[1] as ParsedKind, key: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
};

const firstFile = (
  track: LibraryTrack | null | undefined,
  albumId: number | null = null,
  managedBy: string | null = null,
) => selectCanonicalFile(track?.files, albumId, managedBy);

const seconds = (durationMs: number | null | undefined) => {
  const value = Number(durationMs);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0;
};

const bitRateKbps = (
  quality: (NonNullable<LibraryTrackFile["quality"]> & { audioBitRate?: unknown }) | null,
) => {
  const lidarrKbps = Number.parseInt(String(quality?.audioBitRate), 10);
  if (lidarrKbps > 0) return lidarrKbps;
  const bitsPerSecond = Number(quality?.bitrate);
  return bitsPerSecond > 0 ? Math.round(bitsPerSecond / 1000) : null;
};

const isoDate = (epochMs: number | null | undefined) =>
  new Date(Number(epochMs) || Date.now()).toISOString();

const year = (value: string | null | undefined) => {
  const match = /^(\d{4})/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
};

const normalizeLimit = (value: string | undefined, fallback = 20) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 500) : fallback;
};

const normalizeOffset = (value: string | undefined) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const includesAurralMusicFolder = (options: SubsonicQuery = {}) => {
  const musicFolderId = String(options.musicFolderId || "").trim();
  return !musicFolderId || musicFolderId === "1";
};

const genreNames = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry || "").split(";"))
    .map((entry) => entry.trim())
    .filter(Boolean);

const readField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

type GenreEntity = { metadata?: object | null } | null | undefined;

const entityGenres = (entity: GenreEntity) => {
  const metadata = entity?.metadata;
  return [
    readField(metadata, "genres"),
    readField(readField(metadata, "common"), "genre"),
    readField(metadata, "genre"),
    readField(readField(metadata, "tags"), "genre"),
  ]
    .flatMap(genreNames)
    .filter((genre, index, values) => values.indexOf(genre) === index);
};

const visibleFlows = (user: SubsonicUser) =>
  user && hasPermission(user, "accessFlow")
    ? flowPlaylistConfig.getFlowsForUser(user).filter((flow) => flow.enabled)
    : [];

const findAlbumForTrack = (library: IndexedLibrary, track: LibraryTrack | null | undefined) => {
  const albumId = track?.albums?.[0]?.albumId;
  return (albumId === undefined ? undefined : library.albumsById.get(albumId)) || null;
};

const findArtistForAlbum = (library: IndexedLibrary, album: LibraryAlbum | null | undefined) =>
  (album ? library.artistsById.get(album.artistId) : undefined) || null;

const protocolArtist = (artist: LibraryArtist | null | undefined, fallback = "Unknown Artist") => ({
  id: idFor("artist", artist?.identityKey || `name:artist:${fallback.toLocaleLowerCase()}`),
  name: artist?.name || fallback,
  musicBrainzId: artist?.mbid || "",
});

const albumTracks = (library: IndexedLibrary, album: LibraryAlbum) =>
  (album?.trackIds || [])
    .map((trackId) => library.tracksById.get(trackId))
    .filter((track): track is NonNullable<typeof track> => Boolean(track));

const artistAlbums = (library: IndexedLibrary, artist: LibraryArtist) => {
  const owned = (artist?.albumIds || [])
    .map((albumId) => library.albumsById.get(albumId))
    .filter((album): album is NonNullable<typeof album> => Boolean(album));
  const { mbid } = artist;
  const shared = mbid
    ? library.albums.filter(
        (album) => album.artistId !== artist.id && album.creditedArtistMbids?.includes(mbid),
      )
    : [];
  return [...owned, ...shared];
};

const customArtworkId = (
  kind: string,
  id: string | number,
  updatedAt: number | string | null | undefined,
  context: Record<string, string> = {},
) =>
  idFor(
    `art-${kind}`,
    JSON.stringify({ id: String(id), updatedAt: Number(updatedAt), ...context }),
  );

const coverArtForAlbum = (library: IndexedLibrary, album: LibraryAlbum) => {
  const updatedAt = library.customAlbumArtwork?.get(String(album.id));
  return updatedAt
    ? customArtworkId("album", album.id, updatedAt)
    : idFor("album", album.identityKey);
};

const coverArtForTrack = (
  library: IndexedLibrary,
  track: LibraryTrack,
  album: LibraryAlbum | null | undefined,
) => {
  const updatedAt = library.customTrackArtwork?.get(String(track.id));
  return updatedAt
    ? customArtworkId("track", track.id, updatedAt)
    : album
      ? coverArtForAlbum(library, album)
      : undefined;
};

const toSong = (
  library: IndexedLibrary,
  track: LibraryTrack,
  album: LibraryAlbum | null = findAlbumForTrack(library, track),
): LibrarySong => {
  const artist = findArtistForAlbum(library, album);
  const file = firstFile(track, album?.id, album?.managedBy);
  const genres = [
    ...new Set([...entityGenres(artist), ...entityGenres(album), ...entityGenres(track)]),
  ];
  const relation = track.albums?.find((entry) => entry.albumId === album?.id);
  const artistValue = protocolArtist(artist, track.artistName || "Unknown Artist");
  const format = String(file?.format || "mp3").toLowerCase();
  const song: LibrarySong = {
    id: idFor("song", track.identityKey),
    parent: album ? idFor("album", album.identityKey) : idFor("album", "unknown"),
    isDir: false,
    isVideo: false,
    title: track.title,
    album: album?.title || "Unknown Album",
    artist: artistValue.name,
    albumId: album ? idFor("album", album.identityKey) : undefined,
    artistId: artistValue.id,
    albumArtists: [artistValue],
    artists: [artistValue],
    contentType: audioContentType(format),
    created: isoDate(track.createdAt ?? file?.createdAt ?? file?.mtimeMs),
    track: Number(relation?.trackNumber) || 0,
    discNumber: Number(relation?.discNumber) || 1,
    coverArt: coverArtForTrack(library, track, album),
    duration: seconds(file?.durationMs),
    size: Number(file?.size || 0),
    suffix: format,
    path: idFor("song", track.identityKey),
    type: "music",
    starred: library.starredAt?.get(`song:${track.identityKey}`),
    musicBrainzId: track.mbid || "",
    mediaType: "song",
  };
  const bitRate = bitRateKbps(file?.quality);
  if (bitRate) song.bitRate = bitRate;
  const releaseYear = year(album?.releaseDate);
  if (releaseYear != null) song.year = releaseYear;
  if (genres.length) {
    song.genre = genres[0];
    song.genres = genres.map((name) => ({ name }));
  }
  return song;
};

const albumData = (library: IndexedLibrary, album: LibraryAlbum) => {
  const artist = findArtistForAlbum(library, album);
  const tracks = albumTracks(library, album);
  const artistValue = protocolArtist(artist, album.albumArtist || "Unknown Artist");
  const genres = [
    ...entityGenres(artist),
    ...entityGenres(album),
    ...tracks.flatMap((track) => entityGenres(track)),
  ].filter((genre, index, values) => values.indexOf(genre) === index);
  const value: SubsonicAlbum = {
    id: idFor("album", album.identityKey),
    name: album.title,
    title: album.title,
    album: album.title,
    artist: artistValue.name,
    artistId: artistValue.id,
    artists: [artistValue],
    parent: artistValue.id,
    isDir: true,
    isVideo: false,
    created: isoDate(album.createdAt),
    coverArt: coverArtForAlbum(library, album),
    songCount: tracks.length,
    duration: tracks.reduce(
      (total, track) => total + seconds(firstFile(track, album.id, album.managedBy)?.durationMs),
      0,
    ),
    song: [],
    starred: library.starredAt?.get(`album:${album.identityKey}`),
    // OpenSubsonic wants the release MBID here; Lidarr-indexed albums only know the
    // release-group id, so they report an empty value rather than a wrong one.
    musicBrainzId: album.mbid || "",
    mediaType: "album",
  };
  const releaseYear = year(album.releaseDate);
  if (releaseYear != null) value.year = releaseYear;
  if (genres.length) {
    value.genre = genres[0];
    value.genres = genres.map((name) => ({ name }));
  }
  return {
    tracks,
    value,
  };
};

const toAlbumSummary = (library: IndexedLibrary, album: LibraryAlbum) =>
  albumData(library, album).value;

const toAlbum = (library: IndexedLibrary, album: LibraryAlbum) => {
  const { tracks, value } = albumData(library, album);
  return { ...value, song: tracks.map((track) => toSong(library, track, album)) };
};

const toArtist = (library: IndexedLibrary, artist: LibraryArtist) => {
  const albums = artistAlbums(library, artist);
  const genres = entityGenres(artist);
  const value: SubsonicArtist = {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: albums.length,
    album: albums.map((album) => toAlbumSummary(library, album)),
    starred: library.starredAt?.get(`artist:${artist.identityKey}`),
    musicBrainzId: artist.mbid || "",
    mediaType: "artist",
  };
  if (genres.length) {
    value.genre = genres[0];
    value.genres = genres.map((name) => ({ name }));
  }
  return value;
};

const toArtistSummary = (
  artist: LibraryArtist & { albumCount?: number },
  library: { starredAt?: StarredAt | null } = {},
): SubsonicArtist => {
  const genres = entityGenres(artist);
  return {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: artist.albumCount ?? artist.albumIds.length,
    starred: library.starredAt?.get(`artist:${artist.identityKey}`),
    musicBrainzId: artist.mbid || "",
    mediaType: "artist",
    ...(genres.length ? { genre: genres[0], genres: genres.map((name) => ({ name })) } : {}),
  };
};

const indexFocusedLibrary = (
  library: LibraryInput,
  starredAt: StarredAt | null | undefined = library.starredAt,
) => ({
  ...library,
  starredAt,
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

function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "artist"; key: string },
): LibraryArtist | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "album"; key: string },
): LibraryAlbum | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: { kind: "song"; key: string },
): LibraryTrack | null;
function findLibraryEntry(
  library: IndexedLibrary,
  parsed: ParsedId | null,
): LibraryArtist | LibraryAlbum | LibraryTrack | null;
function findLibraryEntry(library: IndexedLibrary, parsed: ParsedId | null) {
  if (!parsed) return null;
  if (parsed.kind === "artist") {
    return library.artistsByIdentity.get(parsed.key) || null;
  }
  if (parsed.kind === "album") {
    return library.albumsByIdentity.get(parsed.key) || null;
  }
  if (parsed.kind === "song") {
    return library.tracksByIdentity.get(parsed.key) || null;
  }
  return null;
}

function playlistFromId(user: SubsonicUser, value: unknown) {
  const parsed = parseId(value);
  if (!parsed || !["flow", "shared"].includes(parsed.kind)) return null;
  if (parsed.kind === "flow") return flowPlaylistConfig.getFlowForUser(user, parsed.key);
  return flowPlaylistConfig.getStaticPlaylistForUser(user, parsed.key);
}

function toPlaylistSong(
  playlist: PlaylistOwner,
  kind: string,
  job: DownloadJob,
  starredAt: StarredAt | null = null,
  owned = findAvailableLibraryTrack(trackFromJob(job)),
  customArtworkUpdatedAt: number | null = null,
) {
  const customCoverArt = customArtworkUpdatedAt
    ? customArtworkId("playlist-track", job.id, customArtworkUpdatedAt, {
        playlistKind: kind,
        playlistId: playlist.id,
      })
    : null;
  if (owned) {
    return {
      ...toSong(indexFocusedLibrary(owned.library, starredAt), owned.track),
      parent: idFor(kind, playlist.id),
      ...(customCoverArt ? { coverArt: customCoverArt } : {}),
    };
  }
  const artist = protocolArtist(null, job.artistName || "Unknown Artist");
  const format =
    String(job.finalPath || "")
      .split(".")
      .pop()
      ?.toLowerCase() || "mp3";
  const songKind = kind === "flow" ? "flow-song" : "shared-song";
  const id = idFor(songKind, `${playlist.id}:${job.id}`);
  const albumMbid = String(job.albumMbid || "").trim();
  const song: SubsonicSong = {
    id,
    parent: idFor(kind, playlist.id),
    isDir: false,
    isVideo: false,
    title: job.trackName,
    album: job.albumName || "Unknown Album",
    artist: artist.name,
    artistId: artist.id,
    albumArtists: [artist],
    artists: [artist],
    coverArt:
      customCoverArt || (albumMbid ? idFor("album", `release-group:${albumMbid}`) : undefined),
    contentType: audioContentType(format),
    created: isoDate(job.createdAt),
    // Stars on unmatched playlist songs stay keyed by the playlist song, not a library track.
    starred: starredAt?.get(`${songKind}:${playlist.id}:${job.id}`),
    track: job.trackNumber || 0,
    discNumber: job.discNumber || 1,
    duration: seconds(job.durationMs),
    size: 0,
    suffix: format,
    path: id,
    type: "music",
    musicBrainzId: job.trackMbid || "",
    mediaType: "song",
  };
  if (job.qualityBitrateKbps && job.qualityBitrateKbps > 0) song.bitRate = job.qualityBitrateKbps;
  return song;
}

const playlistJobs = (playlist: PlaylistOwner | null | undefined) =>
  playlistJobEntries(playlist).map(({ job }) => job);

function playlistOwnsJob(
  playlist: PlaylistOwner | null | undefined,
  job: DownloadJob | null | undefined,
) {
  if (!playlist || !job) return false;
  if (String(job.playlistType || "") === String(playlist.id || "")) return true;
  return (playlist.tracks || []).some(
    (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
  );
}

function playlistJobFromId(user: SubsonicUser, value: string) {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  return job && playlistOwnsJob(playlist, job) && job.status === "done" && job.finalPath
    ? { kind, playlist, job }
    : null;
}

const isPlayableJob = (job: DownloadJob) => job.status === "done" && Boolean(job.finalPath);

const visiblePlaylistJobs = (
  flow: PlaylistOwner,
  { includePending = false }: { includePending?: boolean } = {},
) => playlistJobs(flow).filter((job) => includePending || isPlayableJob(job));

const playlistCoverArt = (kind: string, playlistId: string, revision: number | undefined) =>
  revision
    ? customArtworkId("playlist", playlistId, revision, { playlistKind: kind })
    : idFor(kind, playlistId);
const getArtworkChangedStmt = db.prepare<[], { changed_at: number | null }>(
  "SELECT MAX(updated_at) AS changed_at FROM custom_artwork WHERE entity_kind IN ('album', 'track')",
);
const latestArtworkChange = (artwork: Map<string, number>) => Math.max(0, ...artwork.values());
const epochMs = (value: number | string | null | undefined) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

// Stars are per-user library state, so a star change has to move the timestamp too or clients
// keep the starred values they cached before it.
export function getLibraryLastModified(user: SubsonicUser) {
  const stars = user?.id ? Number(getStarsChangedStmt.get(user.id)?.changed_at) || 0 : 0;
  const artwork = Number(getArtworkChangedStmt.get()?.changed_at) || 0;
  const artworkRevision = Math.max(
    getCustomArtworkRevision("album"),
    getCustomArtworkRevision("track"),
  );
  return Math.max(getLibraryIndexLastModified() ?? 0, stars, artwork, artworkRevision);
}

export function listArtists(user: SubsonicUser) {
  const library = { starredAt: starredAtFor(user) };
  return getLibraryArtistPage({ source: "all", availableOnly: true }).artists.map((artist) =>
    toArtistSummary(artist, library),
  );
}

export function getArtist(value: string, user?: SubsonicUser) {
  const parsed = parseId(value);
  if (parsed?.kind !== "artist") return null;
  const library = indexFocusedLibrary(
    getLibraryForArtistReferences({
      source: "all",
      availableOnly: true,
      references: [parsed.key],
      includeSharedAlbums: true,
    }),
    starredAtFor(user),
  );
  const artist = findLibraryEntry(library, parsed);
  return artist?.identityKey ? toArtist(library, artist) : null;
}

export function getAlbum(value: string, user?: SubsonicUser) {
  const parsed = parseId(value);
  if (parsed?.kind !== "album") return null;
  const library = indexFocusedLibrary(
    getLibraryForAlbumReferences({
      source: "all",
      availableOnly: true,
      references: [parsed.key],
    }),
    starredAtFor(user),
  );
  const album = findLibraryEntry(library, parsed);
  return album?.identityKey ? toAlbum(library, album) : null;
}

export function getSong(value: string, user?: SubsonicUser) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    const customArtwork = getCustomArtworkMap("playlist-track", [playlistEntry.job.id]);
    return toPlaylistSong(
      playlistEntry.playlist,
      playlistEntry.kind,
      playlistEntry.job,
      starredAtFor(user),
      undefined,
      customArtwork.get(String(playlistEntry.job.id)) || null,
    );
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: true,
    }),
    starredAtFor(user),
  );
  const track = findLibraryEntry(library, parsed);
  return track?.identityKey ? toSong(library, track) : null;
}

export function findUniqueLibrarySong(artist: string, title: string, user?: SubsonicUser) {
  if (!String(artist).trim() || !String(title).trim()) return null;
  const library = indexFocusedLibrary(
    getLibraryForTrackMatches({
      source: "all",
      availableOnly: true,
      titles: [String(title).trim()],
    }),
    starredAtFor(user),
  );
  const songs = library.tracks
    .map((track) => toSong(library, track))
    .filter(
      (song) =>
        song.artist.toLocaleLowerCase() === String(artist).trim().toLocaleLowerCase() &&
        song.title.toLocaleLowerCase() === String(title).trim().toLocaleLowerCase(),
    );
  return songs.length === 1 ? songs[0] : null;
}

export function getMusicDirectory(value: string, user?: SubsonicUser) {
  if (value === "root" || value === "1") {
    const rootId = value === "1" ? "1" : "root";
    return {
      id: rootId,
      name: "Aurral",
      child: listArtists(user).map((artist) => ({
        id: artist.id,
        parent: rootId,
        isDir: true,
        title: artist.name,
        artist: artist.name,
      })),
    };
  }
  const parsed = parseId(value);
  if (parsed?.kind === "artist") {
    const artist = getArtist(value, user);
    return artist ? { id: artist.id, name: artist.name, child: artist.album || [] } : null;
  }
  if (parsed?.kind === "album") {
    const album = getAlbum(value, user);
    return album ? { id: album.id, name: album.name, child: album.song || [] } : null;
  }
  return null;
}

export function searchLibrary(
  query: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  if (!includesAurralMusicFolder(options)) return { artist: [], album: [], song: [] };
  const needle = String(query || "")
    .trim()
    .toLocaleLowerCase();
  const result = getLibrarySearchPage({
    source: "all",
    availableOnly: true,
    query: needle,
    artistLimit: normalizeLimit(options.artistCount),
    artistOffset: normalizeOffset(options.artistOffset),
    albumLimit: normalizeLimit(options.albumCount),
    albumOffset: normalizeOffset(options.albumOffset),
    songLimit: normalizeLimit(options.songCount),
    songOffset: normalizeOffset(options.songOffset),
  });
  const starredAt = starredAtFor(user);
  const artistLibrary = indexFocusedLibrary(
    { artists: result.artists, albums: [], tracks: [] },
    starredAt,
  );
  const albumLibrary = indexFocusedLibrary(result.albums, starredAt);
  const trackLibrary = indexFocusedLibrary(result.tracks, starredAt);
  return {
    artist: artistLibrary.artists.map((artist) => toArtistSummary(artist, artistLibrary)),
    album: albumLibrary.albums.map((album) => toAlbum(albumLibrary, album)),
    song: trackLibrary.tracks.map((track) => toSong(trackLibrary, track)),
  };
}

export function getRandomSongs(options: SubsonicQuery = {}, user: RequestUser | null = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const library = indexFocusedLibrary(
    getLibraryTrackPage({
      source: "all",
      availableOnly: true,
      genre: options.genre,
      fromYear: options.fromYear,
      toYear: options.toYear,
      limit: normalizeLimit(options.size, 10),
      random: true,
    }),
    starredAtFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getAlbumList(options: SubsonicQuery = {}, user: RequestUser | null = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const type = String(options.type || "alphabeticalByName");
  const offset = normalizeOffset(options.offset);
  const limit = normalizeLimit(options.size);
  if (type === "starred") {
    return getStarred(user).album.slice(offset, offset + limit);
  }
  if (type === "frequent" || type === "recent")
    return getPlayedAlbums(type, user, { offset, limit });
  // Aurral does not currently store per-user ratings. Returning no albums is
  // accurate; falling through would falsely label an alphabetical list as rated.
  if (type === "highest") return [];
  const library = indexFocusedLibrary(
    getLibraryAlbumPage({
      source: "all",
      availableOnly: true,
      type,
      genre: options.genre,
      fromYear: options.fromYear,
      toYear: options.toYear,
      offset,
      limit,
    }),
    starredAtFor(user),
  );
  return library.albums.map((album) => toAlbumSummary(library, album));
}

export function getSongsByGenre(
  genre: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  if (!includesAurralMusicFolder(options)) return [];
  const target = String(genre || "")
    .trim()
    .toLocaleLowerCase();
  if (!target) return [];
  const library = indexFocusedLibrary(
    getLibraryTrackPage({
      source: "all",
      availableOnly: true,
      genre: target,
      offset: normalizeOffset(options.offset),
      limit: normalizeLimit(options.count),
    }),
    starredAtFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getGenres() {
  return getLibraryGenres({ source: "all", availableOnly: true });
}

const getStarsStmt = db.prepare<[number], StarRow>(
  "SELECT entity_kind, entity_key, created_at FROM subsonic_stars WHERE user_id = ? ORDER BY created_at, entity_kind, entity_key",
);
const preparePlayedAlbumsStmt = (orderBy: string) =>
  db.prepare<[number, number, number], Pick<LibraryAlbumsRow, "identity_key">>(`
  SELECT album.identity_key
  FROM play_album_stats AS played
  JOIN library_albums AS album
    ON album.identity_key = played.album_key
  WHERE played.user_id = ?
    AND EXISTS (
      SELECT 1
      FROM library_album_tracks AS album_track
      JOIN library_media_files AS media
        ON media.track_id = album_track.track_id
        AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
      WHERE album_track.album_id = album.id
        AND media.available = 1
    )
  GROUP BY album.id
  ORDER BY ${orderBy},
    album.title COLLATE NOCASE,
    album.id
  LIMIT ? OFFSET ?
`);
const playedAlbumsStmts = {
  frequent: preparePlayedAlbumsStmt("SUM(played.play_count) DESC, MAX(played.last_played_at) DESC"),
  recent: preparePlayedAlbumsStmt("MAX(played.last_played_at) DESC"),
};
const addStarStmt = db.prepare(
  "INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, ?)",
);
const removeStarStmt = db.prepare(
  "DELETE FROM subsonic_stars WHERE user_id = ? AND entity_kind = ? AND entity_key = ?",
);
const touchStarsStmt = db.prepare(
  `INSERT INTO subsonic_star_changes (user_id, changed_at) VALUES (?, ?)
   ON CONFLICT(user_id) DO UPDATE SET changed_at = excluded.changed_at`,
);
const getStarsChangedStmt = db.prepare<[number], Pick<SubsonicStarChangesRow, "changed_at">>(
  "SELECT changed_at FROM subsonic_star_changes WHERE user_id = ?",
);

function getPlayedAlbums(
  type: "frequent" | "recent",
  user: SubsonicUser,
  { offset, limit }: { offset: number; limit: number },
) {
  if (!user?.id || limit === 0) return [];
  const albumKeys = playedAlbumsStmts[type]
    .all(user.id, limit, offset)
    .map((row) => row.identity_key);
  if (!albumKeys.length) return [];
  const library = indexFocusedLibrary(
    getLibrary({
      availableOnly: true,
      favoriteKeys: albumKeys.map((key) => ({ kind: "album", key })),
    }),
    starredAtFor(user),
  );
  return albumKeys
    .map((key) => library.albumsByIdentity.get(key))
    .filter((album): album is NonNullable<typeof album> => Boolean(album))
    .map((album) => toAlbumSummary(library, album));
}

// Clients compare lastModified for equality/greater-than, so a star change must land strictly after
// both the previous star timestamp and the library timestamp even on a fast clock.
const touchStars = (userId: number) => {
  const previous = Number(getStarsChangedStmt.get(userId)?.changed_at) || 0;
  const floor = Math.max(previous, getLibraryIndexLastModified() ?? 0);
  touchStarsStmt.run(userId, Math.max(Date.now(), floor + 1));
};

const isSameTrack = (
  left: PlaylistTrackInput | null | undefined,
  right: PlaylistTrackInput | null | undefined,
) => tracksShareMembership(left, right);

const trackFromJob = (job: DownloadJob | null | undefined) => {
  const track = normalizePlaylistTrack({
    artistName: job?.artistName,
    trackName: job?.trackName,
    albumName: job?.albumName,
    artistMbid: job?.artistMbid,
    albumMbid: job?.albumMbid,
    trackMbid: job?.trackMbid,
    releaseYear: job?.releaseYear,
    durationMs: job?.durationMs,
    trackNumber: job?.trackNumber,
    artistAliases: job?.artistAliases,
  });
  return (
    track && {
      ...track,
      albumTrackCount: job?.albumTrackCount,
      albumTrackTitles: job?.albumTrackTitles,
    }
  );
};

const trackFromLibrary = (library: IndexedLibrary, track: LibraryTrack | null | undefined) => {
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

const resolvePlaylistSong = (user: SubsonicUser, value: string) => {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  if (!playlistOwnsJob(playlist, job) && job?.playlistType !== "library") return null;
  const track = trackFromJob(job);
  return track ? { kind, playlist, job, track } : null;
};

const resolveSubsonicTrack = (user: SubsonicUser, value: string) => {
  const playlistSong = resolvePlaylistSong(user, value);
  if (playlistSong) return playlistSong;
  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: false,
    }),
  );
  const track = findLibraryEntry(library, parsed);
  const normalized = trackFromLibrary(library, track);
  return normalized ? { kind: "song", track: normalized, libraryTrack: track } : null;
};

const favoriteAutoKeepEnabled = () => dbOps.getSettings()?.subsonic?.favoriteAutoKeep !== false;

const findLibraryJob = (track: PlaylistTrackInput) => {
  const jobs = downloadTracker
    .getAll()
    .filter((job) => job.playlistType === "library" && isSameTrack(job, track));
  return (
    jobs.find((job) => job.status === "pending" || job.status === "downloading") ||
    jobs.find((job) => job.status === "done") ||
    jobs.find((job) => job.status === "failed") ||
    null
  );
};

const findReusableLibrarySource = (track: PlaylistTrackInput) =>
  downloadTracker
    .getAll()
    .find(
      (job) =>
        job?.playlistType !== "library" &&
        job?.status === "done" &&
        typeof job.finalPath === "string" &&
        existsSync(job.finalPath) &&
        isSameTrack(job, track),
    );

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

const findAvailableLibraryTrack = (track: PlaylistTrackInput | null | undefined) =>
  resolveLibraryTracks([track])[0];

// Map playlist-song star rows to their library song row when the entry is a library track.
const libraryStarRows = <T extends StarKey>(user: SubsonicUser, rows: T[]) => {
  const playlistSongs = rows.map((row) =>
    ["flow-song", "shared-song"].includes(row?.entity_kind)
      ? resolvePlaylistSong(user, idFor(row.entity_kind, row.entity_key))
      : null,
  );
  const resolved = resolveLibraryTracks(playlistSongs.map((song) => song?.track || null));
  return rows.map((row, index) => {
    const libraryTrack = resolved[index]?.track;
    return libraryTrack
      ? { ...row, entity_kind: "song", entity_key: libraryTrack.identityKey }
      : row;
  });
};

const ensureLibraryJob = (track: PlaylistTrack, createdJobIds: string[] | null = null) => {
  const existing = findLibraryJob(track);
  if (existing) {
    if (existing.status === "failed") {
      downloadTracker.setPending(existing.id, "Requested again", { asRetryCycle: true });
    }
    if (existing.status !== "done") {
      downloadWorker.start().catch((error) => {
        logger.error("subsonic", "Could not start download for a playlist track", {
          jobId: existing.id,
          reason: error?.message || String(error),
        });
      });
    }
    return existing.id;
  }

  const jobId = downloadTracker.addJob(track, "library");
  if (!jobId) return null;
  if (createdJobIds) createdJobIds.push(jobId);
  const owned = findAvailableLibraryTrack(track);
  if (owned) {
    downloadTracker.setDone(jobId, owned.file.path, owned.albumName || track.albumName || null);
    return jobId;
  }
  const reusableSource = findReusableLibrarySource(track);
  if (reusableSource) {
    downloadTracker.setDone(
      jobId,
      reusableSource.finalPath!,
      reusableSource.albumName || track.albumName || null,
      reusableSource.externalPath || null,
    );
    return jobId;
  }
  recordTrackJobQueued(downloadTracker.getJob(jobId));
  downloadWorker.start().catch((error) => {
    logger.error("subsonic", "Could not start download for a playlist track", {
      jobId,
      reason: error?.message || String(error),
    });
  });
  return jobId;
};

const toLibraryPlaylistTrack = (
  track: PlaylistTrack,
  canonicalJobId: string | null | undefined,
) => ({
  ...track,
  canonicalJobId: String(canonicalJobId || "").trim() || null,
});

const cancelLegacyPlaylistJobs = async (jobs: DownloadJob[]) => {
  if (jobs.length === 0) return;
  await cancelDownloadWorkForJobs(jobs);
};

const refreshSubsonicPlaylist = (playlistId: string) => {
  playlistManager.requestPlaylistSync([playlistId]);
  playlistManager.scheduleScanLibrary();
};

const normalizeStaticPlaylistId = (value: unknown) => {
  const parsed = parseId(value);
  return parsed?.kind === "shared" ? parsed.key : String(value || "").trim();
};

const linkPlaylistTracksToLibrary = (
  tracks: PlaylistTrackInput[],
  createdJobIds: string[] | null = null,
) => {
  const normalized = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const candidate = normalizePlaylistTrack(track);
    if (!candidate) continue;
    const existingJob = candidate.canonicalJobId
      ? downloadTracker.getJob(candidate.canonicalJobId)
      : null;
    const jobId =
      existingJob && isSameTrack(existingJob, candidate)
        ? existingJob.id
        : ensureLibraryJob(candidate, createdJobIds);
    if (!jobId) return null;
    normalized.push(toLibraryPlaylistTrack(candidate, jobId));
  }
  return normalized;
};

const replaceSubsonicPlaylistTracks = async (
  user: SubsonicUser,
  playlist: StaticPlaylist,
  tracks: PlaylistTrackInput[],
  updates: StaticPlaylistUpdates = {},
  removedJobIds: Set<string> = new Set(),
) => {
  if (!playlist || !flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist)) return null;
  const createdJobIds: string[] = [];
  const libraryTracks = linkPlaylistTracksToLibrary(tracks, createdJobIds);
  if (!libraryTracks) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    return null;
  }
  const retainedJobIds = new Set(
    libraryTracks.map((track) => String(track.canonicalJobId || "").trim()).filter(Boolean),
  );
  const releasedJobs = downloadTracker
    .getByPlaylistId(playlist.id)
    .filter((job) => !retainedJobIds.has(job.id));
  const isRemovedSongFile = (job: DownloadJob) =>
    removedJobIds.has(job.id) && job.playlistType === playlist.id && isPlayableJob(job);
  const jobsToLibrary = releasedJobs.filter(isRemovedSongFile);
  const jobsToRemove = releasedJobs.filter((job) => !isRemovedSongFile(job));
  const jobIdsToRemove = jobsToRemove.map((job) => job.id);
  const activeJobsToRemove = jobsToRemove.filter((job) => !isDownloadJobCancelled(job.id));
  const restoreLegacyJobs = () => {
    restoreDownloadJobCancellations(activeJobsToRemove.map((job) => job.id));
    for (const job of activeJobsToRemove) {
      if (downloadTracker.getJob(job.id)?.status === "downloading") {
        downloadTracker.setFailed(job.id, "Playlist edit failed during download cancellation");
      }
    }
  };
  let updated;
  try {
    await cancelLegacyPlaylistJobs(jobsToRemove);
    updated = await withPlaylistMutationLock(playlist.id, async () => {
      const redirects: NonNullable<Parameters<typeof downloadTracker.reconcileCommittedJobs>[0]> =
        [];
      const replacement = db.transaction(() => {
        if (!flowPlaylistConfig.getStaticPlaylist(playlist.id)) return null;
        for (const job of jobsToLibrary) {
          if (downloadTracker.getJob(job.id)?.playlistType !== playlist.id) continue;
          redirects.push(transferDownloadOwnershipInTransaction(job.id, "library"));
        }
        return flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
          ...updates,
          tracks: libraryTracks,
        });
      })();
      if (!replacement) return null;
      if (redirects.length) downloadTracker.reconcileCommittedJobs(redirects);
      for (const job of jobsToRemove) {
        const current = downloadTracker.getJob(job.id);
        if (!current) continue;
        if (jobDownloadedItsFile(current)) {
          try {
            await removePlaylistFileIfUnshared(current.finalPath, playlist.id, {
              downloadRoot: playlistManager.downloadRoot,
              excludeJobIds: jobIdsToRemove,
              deleteIfUnshared: true,
            });
          } catch (error) {
            logger.warn("subsonic", "Kept a stale playlist file after cleanup failed", {
              playlistId: playlist.id,
              jobId: current.id,
              reason: asAppError(error)?.message || String(error),
            });
          }
        }
        downloadTracker.removeJob(current.id);
      }
      return replacement;
    });
  } catch (error) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    restoreLegacyJobs();
    throw error;
  }
  if (!updated) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    restoreLegacyJobs();
    return null;
  }
  refreshSubsonicPlaylist(playlist.id);
  return updated;
};

export async function createSubsonicPlaylist(
  user: SubsonicUser,
  { name, songIds = [] }: { name?: string; songIds?: string[] } = {},
) {
  if (!hasPermission(user, "accessFlow")) return null;
  const safeName = String(name || "").trim();
  if (!safeName) return null;
  const resolved = songIds.map((id) => resolveSubsonicTrack(user, id));
  if (resolved.some((entry) => !entry)) return null;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    id: randomUUID(),
    name: safeName,
    ownerUserId: user!.id,
    tracks: [],
  });
  try {
    const updated = await replaceSubsonicPlaylistTracks(
      user,
      playlist,
      resolved.map((entry) => entry!.track),
    );
    if (!updated) flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    return updated;
  } catch (error) {
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    throw error;
  }
}

const playlistEditError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

export async function updateSubsonicPlaylist(
  user: SubsonicUser,
  {
    playlistId,
    name,
    comment,
    songIds,
    songIdsToAdd = [],
    songIndexesToRemove = [],
  }: {
    playlistId?: string;
    name?: string;
    comment?: string;
    songIds?: string[];
    songIdsToAdd?: string[];
    songIndexesToRemove?: (string | number)[];
  } = {},
) {
  return withHonkerLock("weekly-flow-operation", async () => {
    if (parseId(playlistId)?.kind === "flow" && playlistFromId(user, playlistId)) {
      throw playlistEditError("SUBSONIC_PLAYLIST_READ_ONLY", "Flows are read-only");
    }
    const playlist = flowPlaylistConfig.getStaticPlaylistForUser(
      user,
      normalizeStaticPlaylistId(playlistId),
    );
    if (!playlist || !hasPermission(user, "accessFlow")) return null;
    const entries = playlistJobEntries(playlist);
    const visibleEntries = entries.filter(({ job }) => isPlayableJob(job));
    const removedEntries =
      songIds !== undefined
        ? visibleEntries
        : [...new Set(songIndexesToRemove)].map((index) => {
            const entry =
              typeof index === "number" && Number.isInteger(index) ? visibleEntries[index] : null;
            if (!entry) {
              throw playlistEditError(
                "SUBSONIC_PLAYLIST_ENTRY_NOT_FOUND",
                `Playlist has no song at index ${index}`,
              );
            }
            return entry;
          });
    const resolvedAdds = (songIds ?? songIdsToAdd).map((id) => resolveSubsonicTrack(user, id));
    if (!resolvedAdds.every((entry) => entry !== null)) return null;
    const removedJobIds = new Set(removedEntries.map(({ job }) => job.id));
    const pairedJobs = new Map(
      entries
        .filter(({ trackIndex }) => trackIndex >= 0)
        .map(({ job, trackIndex }) => [trackIndex, job]),
    );
    const keptTracks =
      songIds !== undefined
        ? []
        : playlist.tracks.flatMap((track, index) => {
            const job = pairedJobs.get(index);
            const jobId = job?.id ?? track.canonicalJobId;
            if (jobId !== undefined && removedJobIds.has(jobId)) return [];
            return [
              track.canonicalJobId !== undefined && removedJobIds.has(track.canonicalJobId)
                ? { ...track, canonicalJobId: job!.id }
                : track,
            ];
          });
    const keptUnpairedTracks = visibleEntries
      .filter(({ job, trackIndex }) => trackIndex < 0 && !removedJobIds.has(job.id))
      .map(({ job }) => ({ ...trackFromJob(job), canonicalJobId: job.id }));
    const nextTracks = [
      ...keptTracks,
      ...keptUnpairedTracks,
      ...resolvedAdds.map((entry) => {
        const job = "job" in entry ? entry.job : undefined;
        return job?.playlistType === playlist.id
          ? { ...entry.track, canonicalJobId: job.id }
          : entry.track;
      }),
    ];
    const updates: StaticPlaylistUpdates = {};
    if (name !== undefined) updates.name = String(name || "").trim();
    if (comment !== undefined) updates.description = String(comment || "").trim() || null;
    return replaceSubsonicPlaylistTracks(user, playlist, nextTracks, updates, removedJobIds);
  });
}

export async function deleteSubsonicPlaylist(user: SubsonicUser, playlistId: string) {
  const playlist = flowPlaylistConfig.getStaticPlaylistForUser(
    user,
    normalizeStaticPlaylistId(playlistId),
  );
  if (!playlist || !hasPermission(user, "accessFlow")) return false;
  return processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId: playlist.id,
  });
}

const starTarget = (value: unknown) => {
  const parsed = parseId(value);
  return parsed && ["artist", "album", "song", "flow-song", "shared-song"].includes(parsed.kind)
    ? parsed
    : null;
};

export function star(user: SubsonicUser, value: string) {
  return starMany(user, [value]);
}

export function starMany(
  user: SubsonicUser,
  values: string[],
  { skipLibraryValidation = false }: { skipLibraryValidation?: boolean } = {},
) {
  const starTargets = values.map(starTarget);
  const parsed = starTargets.flatMap((target) => (target ? [target] : []));
  if (!starTargets.length || parsed.length !== starTargets.length || !user?.id) return false;
  const libraryTargets = parsed
    .filter((target) => ["artist", "album", "song"].includes(target.kind))
    .map((target) => idFor(target.kind, target.key));
  const playlistSongs = parsed.map((target) =>
    ["flow-song", "shared-song"].includes(target.kind)
      ? resolvePlaylistSong(user, idFor(target.kind, target.key))
      : null,
  );
  const libraryTargetKeys = skipLibraryValidation
    ? null
    : getLibraryFavoriteTargetKeys(libraryTargets);
  if (libraryTargetKeys && libraryTargets.some((target) => !libraryTargetKeys.has(target))) {
    return false;
  }
  if (
    parsed.some((target, index) =>
      ["flow-song", "shared-song"].includes(target.kind) ? !playlistSongs[index] : false,
    )
  )
    return false;
  if (favoriteAutoKeepEnabled()) {
    const createdJobIds: string[] = [];
    for (const entry of playlistSongs.filter((song): song is NonNullable<typeof song> =>
      Boolean(song),
    )) {
      if (!ensureLibraryJob(entry.track, createdJobIds)) {
        for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
        return false;
      }
    }
  }
  const addStars = db.transaction(() => {
    let changed = false;
    for (const target of parsed) {
      changed =
        addStarStmt.run(user.id, target.kind, target.key, Date.now()).changes > 0 || changed;
    }
    if (changed) touchStars(user.id);
  });
  addStars();
  return true;
}

export function unstar(user: SubsonicUser, value: string) {
  return unstarMany(user, [value]);
}

export function unstarMany(user: SubsonicUser, values: string[]) {
  const starTargets = values.map(starTarget);
  const parsed = starTargets.flatMap((target) => (target ? [target] : []));
  if (!starTargets.length || parsed.length !== starTargets.length || !user?.id) return false;
  const targetRows = parsed.map((target) => ({ entity_kind: target.kind, entity_key: target.key }));
  const targetKeys = new Set(
    [...targetRows, ...libraryStarRows(user, targetRows)].map(
      (entry) => `${entry.entity_kind}:${entry.entity_key}`,
    ),
  );
  const rows = starredRows(user);
  const libraryRows = libraryStarRows(user, rows);
  const removed: { id: string; starredAt: number }[] = [];
  const removeStars = db.transaction(() => {
    rows.forEach((row, index) => {
      const libraryRow = libraryRows[index];
      if (
        (targetKeys.has(`${row.entity_kind}:${row.entity_key}`) ||
          targetKeys.has(`${libraryRow.entity_kind}:${libraryRow.entity_key}`)) &&
        removeStarStmt.run(user.id, row.entity_kind, row.entity_key).changes > 0
      ) {
        removed.push({
          id: idFor(row.entity_kind, row.entity_key),
          starredAt: Number(row.created_at) || Date.now(),
        });
      }
    });
    if (removed.length) touchStars(user.id);
  });
  removeStars();
  return removed;
}

export function restoreStars(user: SubsonicUser, entries: unknown) {
  const parsed = (Array.isArray(entries) ? entries : []).map((entry) => ({
    target: starTarget(entry?.id),
    starredAt: Number(entry?.starredAt),
  }));
  const restorable = parsed.flatMap(({ target, starredAt }) =>
    target && Number.isSafeInteger(starredAt) && starredAt > 0 ? [{ target, starredAt }] : [],
  );
  if (!parsed.length || !user?.id || restorable.length !== parsed.length) {
    return false;
  }
  const addStars = db.transaction(() => {
    let changed = false;
    for (const { target, starredAt } of restorable) {
      changed = addStarStmt.run(user.id, target.kind, target.key, starredAt).changes > 0 || changed;
    }
    if (changed) touchStars(user.id);
  });
  addStars();
  return true;
}

const starredRows = (user: SubsonicUser): StarRow[] => (user?.id ? getStarsStmt.all(user.id) : []);

const starredAtFromRows = (rows: StarRow[]) => {
  const starredAt = new Map();
  for (const row of rows) {
    const key = `${row.entity_kind}:${row.entity_key}`;
    if (!starredAt.has(key)) {
      starredAt.set(key, new Date(Number(row.created_at) || Date.now()).toISOString());
    }
  }
  return starredAt;
};

// Star timestamps keyed by protocol id, with playlist-song stars resolved to their library track.
const starredAtFor = (user: SubsonicUser) =>
  starredAtFromRows(libraryStarRows(user, starredRows(user)));

export function getStarredIdentityKeys(user: SubsonicUser) {
  return new Set(
    libraryStarRows(user, starredRows(user)).map((row) => `${row.entity_kind}:${row.entity_key}`),
  );
}

const buildStarred = (library: IndexedLibrary, rows: StarRow[], user: SubsonicUser) => {
  const starred: StarredResult = { album: [], artist: [], song: [] };
  for (const row of rows) {
    const parsed = { kind: row.entity_kind, key: row.entity_key };
    if (["flow-song", "shared-song"].includes(parsed.kind)) {
      const separator = parsed.key.indexOf(":");
      const kind = parsed.kind === "flow-song" ? "flow" : "shared";
      const playlist =
        separator > 0 ? playlistFromId(user, idFor(kind, parsed.key.slice(0, separator))) : null;
      const job = separator > 0 ? downloadTracker.getJob(parsed.key.slice(separator + 1)) : null;
      if (playlist && playlistOwnsJob(playlist, job)) {
        // Rows still flagged as playlist songs did not resolve to a library track above.
        const updatedAt = getCustomArtworkMap("playlist-track", [job!.id]).get(String(job!.id));
        starred.song.push(
          toPlaylistSong(playlist, kind, job!, library.starredAt, null, updatedAt || null),
        );
      }
      continue;
    }
    if (parsed.kind === "artist") {
      const artist = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (artist) starred.artist.push(toArtistSummary(artist, library));
    }
    if (parsed.kind === "album") {
      const album = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (album) starred.album.push(toAlbumSummary(library, album));
    }
    if (parsed.kind === "song") {
      const track = findLibraryEntry(library, { kind: parsed.kind, key: parsed.key });
      if (track) starred.song.push(toSong(library, track));
    }
  }
  return starred;
};

export function getStarredWithLibrary(
  user: SubsonicUser,
  { availableOnly = false }: { availableOnly?: boolean } = {},
) {
  // Several playlist-song stars can resolve to the same library track; render it once.
  const seen = new Set();
  const rows = libraryStarRows(user, starredRows(user)).filter((row) => {
    const key = `${row.entity_kind}:${row.entity_key}`;
    return seen.has(key) ? false : seen.add(key);
  });
  const libraryRows = rows.filter((row) => ["artist", "album", "song"].includes(row.entity_kind));
  const library = getLibrary({
    availableOnly,
    favoriteKeys: libraryRows.map((row) => ({ kind: row.entity_kind, key: row.entity_key })),
  });
  return {
    starred: buildStarred(indexFocusedLibrary(library, starredAtFromRows(rows)), rows, user),
    library,
  };
}

export function getStarred(user: SubsonicUser) {
  return getStarredWithLibrary(user, { availableOnly: true }).starred;
}

export function getArtistInfo(value: string) {
  return getArtist(value) ? { similarArtist: [] } : null;
}

export function getTopSongs(
  artist: string,
  options: SubsonicQuery = {},
  user: RequestUser | null = null,
) {
  const target = String(artist || "").trim();
  if (!target) return [];
  const library = indexFocusedLibrary(
    getLibraryTopTracks({
      source: "all",
      availableOnly: true,
      artist: target,
      limit: normalizeLimit(options.count),
    }),
    starredAtFor(user),
  );
  return library.tracks.map((track) => toSong(library, track));
}

export function getSubsonicPlaylists(user: SubsonicUser) {
  const artworkRevision = getCustomArtworkRevision("playlist-track");
  const coverRevisions = getPlaylistArtworkRevisions();
  const flows = visibleFlows(user).map((flow) => {
    const jobs = visiblePlaylistJobs(flow);
    const artworkChangedAt = latestArtworkChange(
      getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      ),
    );
    const playlist: SubsonicPlaylist = {
      id: idFor("flow", flow.id),
      name: flow.name,
      owner: userOps.getUserById(flow.ownerUserId)?.username || "",
      coverArt: playlistCoverArt("flow", flow.id, coverRevisions.get(flow.id)),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(flow.createdAt || Date.now()).toISOString(),
      changed: new Date(
        Math.max(
          epochMs(flow.lastRunAt || flow.createdAt),
          artworkChangedAt,
          artworkRevision,
          coverRevisions.get(flow.id) || 0,
        ),
      ).toISOString(),
    };
    if (flow.description) playlist.comment = flow.description;
    return playlist;
  });
  const staticPlaylists = flowPlaylistConfig.getStaticPlaylistsForUser(user).map((playlist) => {
    const jobs = visiblePlaylistJobs(playlist, { includePending: true });
    const artworkChangedAt = latestArtworkChange(
      getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      ),
    );
    const value: SubsonicPlaylist = {
      id: idFor("shared", playlist.id),
      name: playlist.name,
      owner: userOps.getUserById(playlist.ownerUserId)?.username || "",
      coverArt: playlistCoverArt("shared", playlist.id, coverRevisions.get(playlist.id)),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(playlist.createdAt || Date.now()).toISOString(),
      changed: new Date(
        Math.max(
          epochMs(playlist.importedAt || playlist.createdAt),
          artworkChangedAt,
          artworkRevision,
          coverRevisions.get(playlist.id) || 0,
        ),
      ).toISOString(),
    };
    if (playlist.description) value.comment = playlist.description;
    return value;
  });
  return [...flows, ...staticPlaylists];
}

export function getSubsonicPlaylist(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const kind = parsed?.kind === "shared" ? "shared" : "flow";
  const playlist = playlistFromId(user, value);
  if (!playlist || (kind === "flow" && !flowPlaylistConfig.isEnabled(playlist.id))) return null;
  const jobs = visiblePlaylistJobs(playlist);
  const starredAt = starredAtFor(user);
  const owned = resolveLibraryTracks(jobs.map((job) => trackFromJob(job)));
  const customArtwork = getCustomArtworkMap(
    "playlist-track",
    jobs.map((job) => job.id),
  );
  const artworkChangedAt = latestArtworkChange(customArtwork);
  const coverRevision = getPlaylistArtworkState(playlist.id)?.revision;
  return {
    id: idFor(kind, playlist.id),
    name: playlist.name,
    ...(playlist.description ? { comment: playlist.description } : {}),
    owner: userOps.getUserById(playlist.ownerUserId)?.username || "",
    coverArt: playlistCoverArt(kind, playlist.id, coverRevision),
    songCount: jobs.length,
    duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
    public: false,
    created: new Date(playlist.createdAt || Date.now()).toISOString(),
    changed: new Date(
      Math.max(
        epochMs(
          (kind === "flow" && "lastRunAt" in playlist
            ? playlist.lastRunAt
            : "importedAt" in playlist
              ? playlist.importedAt
              : undefined) || playlist.createdAt,
        ),
        artworkChangedAt,
        getCustomArtworkRevision("playlist-track"),
        coverRevision || 0,
      ),
    ).toISOString(),
    entry: jobs.map((job, index) =>
      toPlaylistSong(
        playlist,
        kind,
        job,
        starredAt,
        owned[index],
        customArtwork.get(String(job.id)) || null,
      ),
    ),
  };
}

export function resolveStreamPath(value: string, user: SubsonicUser) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    return playlistEntry.job.status === "done" && playlistEntry.job.finalPath
      ? playlistEntry.job.finalPath
      : null;
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(
    getLibraryTrack({
      trackId: parsed.key,
      source: "all",
      availableOnly: true,
    }),
  );
  const track = findLibraryEntry(library, parsed);
  const album = findAlbumForTrack(library, track);
  const file = firstFile(track, album?.id, album?.managedBy);
  return file?.available && file.path ? file.path : null;
}

const storedImageUrl = (key: string) => dbOps.getImage(key)?.imageUrl || null;

const replaceStoredImage = (key: string, expected: string | null, imageUrl: string) => {
  if (storedImageUrl(key) === expected) dbOps.setImage(key, imageUrl);
};

const cachedArtworkUrl = async (key: string) => {
  const stored = storedImageUrl(key);
  if (!stored || stored === "NOT_FOUND") return null;
  const artwork = await warmPublicImageUrl(stored, LIBRARY_IMAGE_PROFILE);
  if (artwork && artwork !== stored) replaceStoredImage(key, stored, artwork);
  return artwork || buildImageProxyUrl(stored);
};

const customArtworkTarget = (parsed: ParsedId | null) => {
  if (!parsed?.kind?.startsWith("art-")) return null;
  try {
    const value = JSON.parse(parsed.key);
    const id = String(value?.id || "").trim();
    const updatedAt = Number(value?.updatedAt);
    return id && Number.isFinite(updatedAt) ? { ...value, id, updatedAt } : null;
  } catch {
    return null;
  }
};

export function resolveCustomArtwork(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const target = customArtworkTarget(parsed);
  if (!target) return null;

  let kind;
  if (parsed!.kind === "art-album") kind = "album";
  if (parsed!.kind === "art-track") kind = "track";
  if (parsed!.kind === "art-playlist-track") {
    if (!["flow", "shared"].includes(target.playlistKind)) return null;
    const playlist = playlistFromId(user, idFor(target.playlistKind, target.playlistId));
    const job = downloadTracker.getJob(target.id);
    if (!playlist || !playlistOwnsJob(playlist, job)) return null;
    kind = "playlist-track";
  }
  if (!kind) return null;

  const artwork = getCustomArtwork(kind, target.id);
  return artwork && Number(artwork.updatedAt) === target.updatedAt ? artwork : null;
}

export async function resolveArtworkUrl(value: string) {
  const parsed = parseId(value);
  if (parsed?.kind !== "album" || !parsed.key.startsWith("release-group:")) return null;
  const releaseGroupMbid = parsed.key.slice("release-group:".length);
  const cacheKey = `rg:${releaseGroupMbid}`;
  const cached = await cachedArtworkUrl(cacheKey);
  if (cached) return cached;
  const result = await fetchReleaseGroupCoverUrl(releaseGroupMbid);
  if (!result?.imageUrl) return null;
  const artwork = await warmPublicImageUrl(result.imageUrl, LIBRARY_IMAGE_PROFILE);
  if (artwork) dbOps.setImage(cacheKey, artwork);
  return artwork;
}

export async function resolveLibraryArtwork(value: string) {
  const parsed = parseId(value);
  if (!parsed) return null;
  if (parsed.kind === "artist") {
    const library = indexFocusedLibrary(
      getLibraryForArtistReferences({
        source: "all",
        availableOnly: false,
        references: [parsed.key],
      }),
    );
    const artist = findLibraryEntry(library, parsed);
    return artist ? getLibraryArtwork("artist", String(artist.id)) : null;
  }
  if (parsed.kind !== "album" && parsed.kind !== "song") return null;
  const library = indexFocusedLibrary(
    parsed.kind === "album"
      ? getLibraryForAlbumReferences({
          source: "all",
          availableOnly: false,
          references: [parsed.key],
        })
      : getLibraryTrack({ trackId: parsed.key, source: "all", availableOnly: false }),
  );
  const album =
    parsed.kind === "album"
      ? findLibraryEntry(library, parsed)
      : findAlbumForTrack(library, findLibraryEntry(library, parsed));
  return album ? getLibraryArtwork("album", String(album.id)) : null;
}

export async function resolvePlaylistArtwork(value: string, user: SubsonicUser) {
  const parsed = parseId(value);
  const target = parsed?.kind === "art-playlist" ? customArtworkTarget(parsed) : null;
  const playlist = target
    ? playlistFromId(user, idFor(String(target.playlistKind), target.id))
    : playlistFromId(user, value);
  if (!playlist) return null;
  const artwork = await playlistManager.resolveArtworkFile(playlist.id);
  return artwork && { ...artwork, versioned: Boolean(target) };
}

export { idFor, parseId };
