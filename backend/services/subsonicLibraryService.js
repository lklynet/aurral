import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dbOps } from "../db/helpers/index.js";
import { db } from "../config/db-sqlite.js";
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
} from "./libraryQueryService.js";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.js";
import { getArtistImage } from "./imageService.js";
import { buildImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import {
  flowPlaylistConfig,
  normalizePlaylistTrack,
  orderJobsByPlaylistTracks,
  tracksShareMembership,
} from "./playlists/flowPlaylistConfig.js";
import { playlistManager } from "./playlists/playlistManager.js";
import { downloadWorker } from "./downloadJobs/downloadWorker.js";
import { hasPermission } from "../middleware/auth.js";
import { recordTrackJobQueued } from "./aurralHistoryService.js";
import { selectCanonicalFile } from "./canonicalFileSelector.js";
import { logger } from "./logger.js";
import { withHonkerLock } from "./honkerDb.js";
import { removePlaylistFileIfUnshared } from "./downloadJobs/fileReuse.js";
import { withPlaylistMutationLock } from "./downloadJobs/mutationGuards.js";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "./downloadJobs/downloadCancellation.js";
import { processPlaylistOperation } from "./playlists/playlistOperations.js";
import { cancelDownloadWorkForJobs } from "./downloadJobs/downloadCancellationService.js";

const idFor = (kind, key) =>
  `${kind}:${encodeURIComponent(String(key)).replaceAll("%3A", ":")}`;
const LIBRARY_IMAGE_PROFILE = "library";

const parseId = (value) => {
  const match = /^(artist|album|song|flow|flow-song|shared|shared-song):(.+)$/.exec(String(value || ""));
  if (!match) return null;
  try {
    return { kind: match[1], key: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
};

const firstFile = (track, albumId = null, managedBy = null) =>
  selectCanonicalFile(track?.files, albumId, managedBy);

const seconds = (durationMs) => {
  const value = Number(durationMs);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0;
};

const isoDate = (epochMs) => new Date(Number(epochMs) || Date.now()).toISOString();

const year = (value) => {
  const match = /^(\d{4})/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
};

const normalizeLimit = (value, fallback = 20) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 500) : fallback;
};

const normalizeOffset = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const includesAurralMusicFolder = (options = {}) => {
  const musicFolderId = String(options.musicFolderId || "").trim();
  return !musicFolderId || musicFolderId === "1";
};

const genreNames = (value) =>
  (Array.isArray(value) ? value : [value])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

const entityGenres = (entity) => {
  const metadata = entity?.metadata || {};
  return [
    metadata.genres,
    metadata.common?.genre,
    metadata.genre,
    metadata.tags?.genre,
  ]
    .flatMap(genreNames)
    .filter((genre, index, values) => values.indexOf(genre) === index);
};

const visibleFlows = (user) =>
  user && hasPermission(user, "accessFlow") ? flowPlaylistConfig.getFlowsForUser(user) : [];

const findAlbumForTrack = (library, track) => {
  const relation = track?.albums?.[0];
  return library.albumsById.get(relation?.albumId) || null;
};

const findArtistForAlbum = (library, album) =>
  library.artistsById.get(album?.artistId) || null;

const protocolArtist = (artist, fallback = "Unknown Artist") => ({
  id: idFor("artist", artist?.identityKey || `name:artist:${fallback.toLocaleLowerCase()}`),
  name: artist?.name || fallback,
  musicBrainzId: artist?.mbid || "",
});

const albumTracks = (library, album) =>
  (album?.trackIds || [])
    .map((trackId) => library.tracksById.get(trackId))
    .filter(Boolean);

const artistAlbums = (library, artist) =>
  (artist?.albumIds || [])
    .map((albumId) => library.albumsById.get(albumId))
    .filter(Boolean);

const coverArtForAlbum = (album) => idFor("album", album.identityKey);

const toSong = (library, track, album = findAlbumForTrack(library, track)) => {
  const artist = findArtistForAlbum(library, album);
  const file = firstFile(track, album?.id, album?.managedBy);
  const genres = [...new Set([
    ...entityGenres(artist),
    ...entityGenres(album),
    ...entityGenres(track),
  ])];
  const relation = track.albums?.find((entry) => entry.albumId === album?.id);
  const artistValue = protocolArtist(artist, track.artistName || "Unknown Artist");
  const format = String(file?.format || "mp3").toLowerCase();
  const song = {
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
    contentType: `audio/${format}`,
    created: isoDate(track.createdAt ?? file?.createdAt ?? file?.mtimeMs),
    track: Number(relation?.trackNumber) || 0,
    discNumber: Number(relation?.discNumber) || 1,
    coverArt: album ? coverArtForAlbum(album) : undefined,
    duration: seconds(file?.durationMs),
    size: Number(file?.size || 0),
    suffix: format,
    path: idFor("song", track.identityKey),
    type: "music",
    starred: library.starredAt?.get(`song:${track.identityKey}`),
    musicBrainzId: track.mbid || "",
    mediaType: "song",
  };
  const releaseYear = year(album?.releaseDate);
  if (releaseYear != null) song.year = releaseYear;
  const genre = (Array.isArray(genres) ? genres[0] : genres) || null;
  if (genre) {
    song.genre = genre;
    song.genres = [{ name: genre }];
  }
  return song;
};

const albumData = (library, album) => {
  const artist = findArtistForAlbum(library, album);
  const tracks = albumTracks(library, album);
  const artistValue = protocolArtist(artist, album.albumArtist || "Unknown Artist");
  const genres = [
    ...entityGenres(artist),
    ...entityGenres(album),
    ...tracks.flatMap((track) => entityGenres(track)),
  ].filter((genre, index, values) => values.indexOf(genre) === index);
  const value = {
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
    coverArt: coverArtForAlbum(album),
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

const toAlbumSummary = (library, album) => albumData(library, album).value;

const toAlbum = (library, album) => {
  const { tracks, value } = albumData(library, album);
  return { ...value, song: tracks.map((track) => toSong(library, track, album)) };
};

const toArtist = (library, artist) => {
  const albums = artistAlbums(library, artist);
  const genres = entityGenres(artist);
  const value = {
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

const toArtistSummary = (artist, library = {}) => {
  const genres = entityGenres(artist);
  return {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: artist.albumCount ?? artist.albumIds.length,
    starred: library.starredAt?.get(`artist:${artist.identityKey}`),
    musicBrainzId: artist.mbid || "",
    mediaType: "artist",
    ...(genres.length
      ? { genre: genres[0], genres: genres.map((name) => ({ name })) }
      : {}),
  };
};

const indexFocusedLibrary = (library, starredAt = library.starredAt) => ({
  ...library,
  starredAt,
  artistsById: new Map(library.artists.map((artist) => [artist.id, artist])),
  albumsById: new Map(library.albums.map((album) => [album.id, album])),
  tracksById: new Map(library.tracks.map((track) => [track.id, track])),
  artistsByIdentity: new Map(library.artists.map((artist) => [artist.identityKey, artist])),
  albumsByIdentity: new Map(library.albums.map((album) => [album.identityKey, album])),
  tracksByIdentity: new Map(library.tracks.map((track) => [track.identityKey, track])),
});

function findLibraryEntry(library, parsed) {
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

function playlistFromId(user, value) {
  const parsed = parseId(value);
  if (!parsed || !["flow", "shared"].includes(parsed.kind)) return null;
  if (parsed.kind === "flow") return flowPlaylistConfig.getFlowForUser(user, parsed.key);
  return flowPlaylistConfig.getStaticPlaylistForUser(user, parsed.key);
}

function toPlaylistSong(
  playlist,
  kind,
  job,
  starredAt = null,
  owned = findAvailableLibraryTrack(trackFromJob(job)),
) {
  if (owned) {
    return {
      ...toSong(indexFocusedLibrary(owned.library, starredAt), owned.track),
      parent: idFor(kind, playlist.id),
    };
  }
  const artist = protocolArtist(null, job.artistName || "Unknown Artist");
  const format = String(job.finalPath || "").split(".").pop()?.toLowerCase() || "mp3";
  const songKind = kind === "flow" ? "flow-song" : "shared-song";
  const id = idFor(songKind, `${playlist.id}:${job.id}`);
  const albumMbid = String(job.releaseGroupMbid || job.albumMbid || "").trim();
  return {
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
    coverArt: albumMbid ? idFor("album", `release-group:${albumMbid}`) : undefined,
    contentType: `audio/${format}`,
    created: isoDate(job.createdAt),
    // Stars on unmatched playlist songs stay keyed by the playlist song, not a library track.
    starred: starredAt?.get(`${songKind}:${playlist.id}:${job.id}`),
    track: job.trackNumber || 0,
    discNumber: job.discNumber || 1,
    duration: seconds(job.durationMs),
    size: Number(job.size || 0),
    suffix: format,
    path: id,
    type: "music",
    musicBrainzId: job.trackMbid || "",
    mediaType: "song",
  };
}

function playlistJobs(playlist) {
  if (!playlist) return [];
  const referencedJobs = (playlist.tracks || [])
    .map((track) => (track?.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null))
    .filter(Boolean);
  const jobs = [...referencedJobs, ...downloadTracker.getByPlaylistType(playlist.id)];
  const uniqueJobs = jobs.filter(
    (job, index, values) => values.findIndex((candidate) => candidate.id === job.id) === index,
  );
  return orderJobsByPlaylistTracks(uniqueJobs, playlist.tracks);
}

function playlistOwnsJob(playlist, job) {
  if (!playlist || !job) return false;
  if (String(job.playlistType || "") === String(playlist.id || "")) return true;
  return (playlist.tracks || []).some(
    (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
  );
}

function playlistJobFromId(user, value) {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  return playlistOwnsJob(playlist, job) && job.status === "done" && job.finalPath
    ? { kind, playlist, job }
    : null;
}

const visiblePlaylistJobs = (flow, { includePending = false } = {}) =>
  playlistJobs(flow).filter(
    (job) => includePending || (job.status === "done" && job.finalPath),
  );

const playlistCoverArt = (kind, playlistId) => idFor(kind, playlistId);

// Stars are per-user library state, so a star change has to move the timestamp too or clients
// keep the starred values they cached before it.
export function getLibraryLastModified(user) {
  const stars = user?.id ? Number(getStarsChangedStmt.get(user.id)?.changed_at) || 0 : 0;
  return Math.max(getLibraryIndexLastModified() ?? 0, stars);
}

export function listArtists(user) {
  const library = { starredAt: starredAtFor(user) };
  return getLibraryArtistPage({ source: "all", availableOnly: true }).artists.map(
    (artist) => toArtistSummary(artist, library),
  );
}

export function getArtist(value, user) {
  const parsed = parseId(value);
  if (parsed?.kind !== "artist") return null;
  const library = indexFocusedLibrary(getLibraryForArtistReferences({
    source: "all",
    availableOnly: true,
    references: [parsed.key],
  }), starredAtFor(user));
  const artist = findLibraryEntry(library, parsed);
  return artist?.identityKey ? toArtist(library, artist) : null;
}

export function getAlbum(value, user) {
  const parsed = parseId(value);
  if (parsed?.kind !== "album") return null;
  const library = indexFocusedLibrary(getLibraryForAlbumReferences({
    source: "all",
    availableOnly: true,
    references: [parsed.key],
  }), starredAtFor(user));
  const album = findLibraryEntry(library, parsed);
  return album?.identityKey ? toAlbum(library, album) : null;
}

export function getSong(value, user) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    return toPlaylistSong(
      playlistEntry.playlist,
      playlistEntry.kind,
      playlistEntry.job,
      starredAtFor(user),
    );
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(getLibraryTrack({
    trackId: parsed.key,
    source: "all",
    availableOnly: true,
  }), starredAtFor(user));
  const track = findLibraryEntry(library, parsed);
  return track?.identityKey ? toSong(library, track) : null;
}

export function getMusicDirectory(value, user) {
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

export function searchLibrary(query, options = {}, user = null) {
  if (!includesAurralMusicFolder(options)) return { artist: [], album: [], song: [] };
  const needle = String(query || "").trim().toLocaleLowerCase();
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
  const artistLibrary = indexFocusedLibrary({ artists: result.artists, albums: [], tracks: [] }, starredAt);
  const albumLibrary = indexFocusedLibrary(result.albums, starredAt);
  const trackLibrary = indexFocusedLibrary(result.tracks, starredAt);
  return {
    artist: artistLibrary.artists.map((artist) => toArtistSummary(artist, artistLibrary)),
    album: albumLibrary.albums.map((album) => toAlbum(albumLibrary, album)),
    song: trackLibrary.tracks.map((track) => toSong(trackLibrary, track)),
  };
}

export function getRandomSongs(options = {}, user = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const library = indexFocusedLibrary(getLibraryTrackPage({
    source: "all",
    availableOnly: true,
    genre: options.genre,
    fromYear: options.fromYear,
    toYear: options.toYear,
    limit: normalizeLimit(options.size, 10),
    random: true,
  }), starredAtFor(user));
  return library.tracks.map((track) => toSong(library, track));
}

export function getAlbumList(options = {}, user = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const type = String(options.type || "alphabeticalByName");
  const offset = normalizeOffset(options.offset);
  const limit = normalizeLimit(options.size);
  if (type === "starred") {
    return getStarred(user).album.slice(offset, offset + limit);
  }
  if (type === "frequent") return getFrequentlyPlayedAlbums(user, { offset, limit });
  // Aurral does not currently store per-user ratings. Returning no albums is
  // accurate; falling through would falsely label an alphabetical list as rated.
  if (type === "highest") return [];
  const library = indexFocusedLibrary(getLibraryAlbumPage({
    source: "all",
    availableOnly: true,
    type,
    genre: options.genre,
    fromYear: options.fromYear,
    toYear: options.toYear,
    offset,
    limit,
  }), starredAtFor(user));
  return library.albums.map((album) => toAlbumSummary(library, album));
}

export function getSongsByGenre(genre, options = {}, user = null) {
  if (!includesAurralMusicFolder(options)) return [];
  const target = String(genre || "").trim().toLocaleLowerCase();
  if (!target) return [];
  const library = indexFocusedLibrary(getLibraryTrackPage({
    source: "all",
    availableOnly: true,
    genre: target,
    offset: normalizeOffset(options.offset),
    limit: normalizeLimit(options.count),
  }), starredAtFor(user));
  return library.tracks.map((track) => toSong(library, track));
}

export function getGenres() {
  return getLibraryGenres({ source: "all", availableOnly: true });
}

const getStarsStmt = db.prepare(
  "SELECT entity_kind, entity_key, created_at FROM subsonic_stars WHERE user_id = ? ORDER BY created_at, entity_kind, entity_key",
);
const getFrequentlyPlayedAlbumsStmt = db.prepare(`
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
  ORDER BY SUM(played.play_count) DESC,
    MAX(played.last_played_at) DESC,
    album.title COLLATE NOCASE,
    album.id
  LIMIT ? OFFSET ?
`);
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
const getStarsChangedStmt = db.prepare(
  "SELECT changed_at FROM subsonic_star_changes WHERE user_id = ?",
);

function getFrequentlyPlayedAlbums(user, { offset, limit }) {
  if (!user?.id || limit === 0) return [];
  const albumKeys = getFrequentlyPlayedAlbumsStmt
    .all(user.id, limit, offset)
    .map((row) => row.identity_key);
  if (!albumKeys.length) return [];
  const library = indexFocusedLibrary(getLibrary({
    availableOnly: true,
    favoriteKeys: albumKeys.map((key) => ({ kind: "album", key })),
  }), starredAtFor(user));
  return albumKeys
    .map((key) => library.albumsByIdentity.get(key))
    .filter(Boolean)
    .map((album) => toAlbumSummary(library, album));
}

// Clients compare lastModified for equality/greater-than, so a star change must land strictly after
// both the previous star timestamp and the library timestamp even on a fast clock.
const touchStars = (userId) => {
  const previous = Number(getStarsChangedStmt.get(userId)?.changed_at) || 0;
  const floor = Math.max(previous, getLibraryIndexLastModified() ?? 0);
  touchStarsStmt.run(userId, Math.max(Date.now(), floor + 1));
};

const isSameTrack = (left, right) => tracksShareMembership(left, right);

const trackFromJob = (job) => normalizePlaylistTrack({
  artistName: job?.artistName,
  trackName: job?.trackName,
  albumName: job?.albumName,
  artistMbid: job?.artistMbid,
  albumMbid: job?.albumMbid,
  trackMbid: job?.trackMbid,
  releaseYear: job?.releaseYear,
  durationMs: job?.durationMs,
  trackNumber: job?.trackNumber,
  albumTrackCount: job?.albumTrackCount,
  albumTrackTitles: job?.albumTrackTitles,
  artistAliases: job?.artistAliases,
});

const trackFromLibrary = (library, track) => {
  const album = findAlbumForTrack(library, track);
  return normalizePlaylistTrack({
    artistName: track?.artistName,
    trackName: track?.title,
    albumName: album?.title,
    artistMbid: findArtistForAlbum(library, album)?.mbid,
    albumMbid: album?.releaseGroupMbid || album?.mbid,
    trackMbid: track?.mbid,
    releaseYear: year(album?.releaseDate),
    durationMs: firstFile(track, album?.id, album?.managedBy)?.durationMs,
    trackNumber: track?.albums?.[0]?.trackNumber,
  });
};

const resolvePlaylistSong = (user, value) => {
  const parsed = parseId(value);
  if (!parsed || !["flow-song", "shared-song"].includes(parsed.kind)) return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const kind = parsed.kind === "flow-song" ? "flow" : "shared";
  const playlist = playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)));
  if (!playlist) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  if (!playlistOwnsJob(playlist, job)) return null;
  const track = trackFromJob(job);
  return track ? { kind, playlist, job, track } : null;
};

const resolveSubsonicTrack = (user, value) => {
  const playlistSong = resolvePlaylistSong(user, value);
  if (playlistSong) return playlistSong;
  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(getLibraryTrack({
    trackId: parsed.key,
    source: "all",
    availableOnly: false,
  }));
  const track = findLibraryEntry(library, parsed);
  const normalized = trackFromLibrary(library, track);
  return normalized ? { kind: "song", track: normalized, libraryTrack: track } : null;
};

const favoriteAutoKeepEnabled = () => dbOps.getSettings()?.subsonic?.favoriteAutoKeep !== false;

const findLibraryJob = (track) => {
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

const findReusableLibrarySource = (track) =>
  downloadTracker.getAll().find(
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
export function resolveLibraryTracks(descriptors) {
  const items = (Array.isArray(descriptors) ? descriptors : []).map((entry) => normalizePlaylistTrack(entry));
  const present = items.filter(Boolean);
  if (!present.length) return items.map(() => null);
  const library = indexFocusedLibrary(getLibraryForTrackMatches({
    source: "all",
    availableOnly: true,
    mbids: present.map((track) => track.trackMbid),
    titles: present.map((track) => track.trackName),
  }));
  const byTitle = new Map();
  const byMbid = new Map();
  for (const track of library.tracks) {
    const title = String(track.title || "").trim().toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(track);
    if (track.mbid && !byMbid.has(track.mbid)) byMbid.set(track.mbid, track);
  }
  const resolveFile = (entry) => {
    const album = findAlbumForTrack(library, entry);
    return { album, file: firstFile(entry, album?.id, album?.managedBy) };
  };
  const playable = (entry) => {
    const { file } = resolveFile(entry);
    return Boolean(file?.available && file.path);
  };
  return items.map((track) => {
    if (!track) return null;
    // A shared recording MBID identifies the track even when the titles differ (remaster, typo).
    const byId = track.trackMbid ? byMbid.get(track.trackMbid) : null;
    const candidates = byTitle.get(track.trackName.toLowerCase()) || [];
    const match = byId && playable(byId)
      ? byId
      : candidates.find(
        (entry) => playable(entry) && isSameTrack(track, trackFromLibrary(library, entry)),
      );
    if (!match) return null;
    const { album, file } = resolveFile(match);
    return { file, library, track: match, albumName: album?.title };
  });
}

const findAvailableLibraryTrack = (track) => resolveLibraryTracks([track])[0];

// Map playlist-song star rows to their library song row when the entry is a library track.
const libraryStarRows = (user, rows) => {
  const playlistSongs = rows.map((row) =>
    ["flow-song", "shared-song"].includes(row?.entity_kind)
      ? resolvePlaylistSong(user, idFor(row.entity_kind, row.entity_key))
      : null,
  );
  const resolved = resolveLibraryTracks(playlistSongs.map((song) => song?.track || null));
  return rows.map((row, index) => {
    const libraryTrack = resolved[index]?.track;
    return libraryTrack ? { ...row, entity_kind: "song", entity_key: libraryTrack.identityKey } : row;
  });
};

const ensureLibraryJob = (track, createdJobIds = null) => {
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
      reusableSource.finalPath,
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

const toLibraryPlaylistTrack = (track, canonicalJobId) => ({
  ...track,
  canonicalJobId: String(canonicalJobId || "").trim() || null,
});

const cancelLegacyPlaylistJobs = async (jobs) => {
  if (jobs.length === 0) return;
  await cancelDownloadWorkForJobs(jobs);
};

const refreshSubsonicPlaylist = (playlistId) => {
  playlistManager.updateConfig(false);
  Promise.all([
    playlistManager.ensureSmartPlaylists(),
    playlistManager.refreshPlaylist(playlistId),
  ]).catch((error) => {
    logger.error("subsonic", "Could not refresh playlist", {
      playlistId,
      reason: error?.message || String(error),
    });
  });
  playlistManager.scheduleScanLibrary();
};

const normalizeStaticPlaylistId = (value) => {
  const parsed = parseId(value);
  return parsed?.kind === "shared" ? parsed.key : String(value || "").trim();
};

const linkPlaylistTracksToLibrary = (tracks, createdJobIds = null) => {
  const normalized = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const candidate = normalizePlaylistTrack(track);
    if (!candidate) continue;
    const existingJob = candidate.canonicalJobId
      ? downloadTracker.getJob(candidate.canonicalJobId)
      : null;
    const jobId = existingJob && isSameTrack(existingJob, candidate)
      ? existingJob.id
      : ensureLibraryJob(candidate, createdJobIds);
    if (!jobId) return null;
    normalized.push(toLibraryPlaylistTrack(candidate, jobId));
  }
  return normalized;
};

const replaceSubsonicPlaylistTracks = async (user, playlist, tracks, updates = {}) => {
  if (!playlist || !flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist)) return null;
  const createdJobIds = [];
  const libraryTracks = linkPlaylistTracksToLibrary(tracks, createdJobIds);
  if (!libraryTracks) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    return null;
  }
  const legacyJobs = downloadTracker.getByPlaylistId(playlist.id);
  const retainedJobIds = new Set(
    libraryTracks.map((track) => String(track.canonicalJobId || "").trim()).filter(Boolean),
  );
  const jobsToRemove = legacyJobs.filter((job) => !retainedJobIds.has(job.id));
  const legacyJobIds = jobsToRemove.map((job) => job.id);
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
      const replacement = flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
        ...updates,
        tracks: libraryTracks,
      });
      if (!replacement) return null;
      for (const job of jobsToRemove) {
        const current = downloadTracker.getJob(job.id);
        if (!current) continue;
        if (current.status === "done" && current.finalPath && current.managedBy === "aurral" && !current.externalPath) {
          try {
            const removal = await removePlaylistFileIfUnshared(current.finalPath, playlist.id, {
              downloadRoot: playlistManager.downloadRoot,
              excludeJobIds: legacyJobIds,
              deleteIfUnshared: true,
            });
            if (removal.action !== "deleted" && removal.action !== "relocated") {
              logger.warn("subsonic", "Retaining legacy playlist job with an unremoved file", {
                playlistId: playlist.id,
                jobId: current.id,
                action: removal.action,
              });
              continue;
            }
          } catch (error) {
            logger.warn("subsonic", "Retaining legacy playlist job after file cleanup failed", {
              playlistId: playlist.id,
              jobId: current.id,
              reason: error?.message || String(error),
            });
            continue;
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

export async function createSubsonicPlaylist(user, { name, songIds = [] } = {}) {
  if (!hasPermission(user, "accessFlow")) return null;
  const safeName = String(name || "").trim();
  if (!safeName) return null;
  const resolved = songIds.map((id) => resolveSubsonicTrack(user, id));
  if (resolved.some((entry) => !entry)) return null;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    id: randomUUID(),
    name: safeName,
    ownerUserId: user.id,
    tracks: [],
  });
  try {
    const updated = await replaceSubsonicPlaylistTracks(
      user,
      playlist,
      resolved.map((entry) => entry.track),
    );
    if (!updated) flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    return updated;
  } catch (error) {
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
    throw error;
  }
}

export async function updateSubsonicPlaylist(
  user,
  { playlistId, name, comment, songIdsToAdd = [], songIndexesToRemove = [] } = {},
) {
  return withHonkerLock("weekly-flow-operation", async () => {
    const playlist = flowPlaylistConfig.getStaticPlaylistForUser(
      user,
      normalizeStaticPlaylistId(playlistId),
    );
    if (!playlist || !hasPermission(user, "accessFlow")) return null;
    const resolvedAdds = songIdsToAdd.map((id) => resolveSubsonicTrack(user, id));
    if (resolvedAdds.some((entry) => !entry)) return null;
    const removals = new Set(songIndexesToRemove);
    const currentTracks = playlist.tracks.filter((_track, index) => !removals.has(index));
    const nextTracks = [
      ...currentTracks,
      ...resolvedAdds.map((entry) => entry.track),
    ];
    const updates = {};
    if (name !== undefined) updates.name = String(name || "").trim();
    if (comment !== undefined) updates.description = String(comment || "").trim() || null;
    return replaceSubsonicPlaylistTracks(user, playlist, nextTracks, updates);
  });
}

export async function deleteSubsonicPlaylist(user, playlistId) {
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

const starTarget = (value) => {
  const parsed = parseId(value);
  return parsed && ["artist", "album", "song", "flow-song", "shared-song"].includes(parsed.kind)
    ? parsed
    : null;
};

export function star(user, value) {
  return starMany(user, [value]);
}

export function starMany(user, values, { skipLibraryValidation = false } = {}) {
  const parsed = values.map(starTarget);
  if (!parsed.length || parsed.some((target) => !target) || !user?.id) return false;
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
  if (parsed.some((target, index) =>
    ["flow-song", "shared-song"].includes(target.kind)
      ? !playlistSongs[index]
      : false,
  )) return false;
  if (favoriteAutoKeepEnabled()) {
    const createdJobIds = [];
    for (const entry of playlistSongs.filter(Boolean)) {
      if (!ensureLibraryJob(entry.track, createdJobIds)) {
        for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
        return false;
      }
    }
  }
  const addStars = db.transaction(() => {
    let changed = false;
    for (const target of parsed) {
      changed = addStarStmt.run(user.id, target.kind, target.key, Date.now()).changes > 0 || changed;
    }
    if (changed) touchStars(user.id);
  });
  addStars();
  return true;
}

export function unstar(user, value) {
  return unstarMany(user, [value]);
}

export function unstarMany(user, values) {
  const parsed = values.map(starTarget);
  if (!parsed.length || parsed.some((target) => !target) || !user?.id) return false;
  const targetRows = parsed.map((target) => ({ entity_kind: target.kind, entity_key: target.key }));
  const targetKeys = new Set(
    [...targetRows, ...libraryStarRows(user, targetRows)].map((entry) => `${entry.entity_kind}:${entry.entity_key}`),
  );
  const rows = starredRows(user);
  const libraryRows = libraryStarRows(user, rows);
  const removeStars = db.transaction(() => {
    let changed = false;
    rows.forEach((row, index) => {
      const libraryRow = libraryRows[index];
      if (
        targetKeys.has(`${row.entity_kind}:${row.entity_key}`) ||
        targetKeys.has(`${libraryRow.entity_kind}:${libraryRow.entity_key}`)
      ) {
        changed = removeStarStmt.run(user.id, row.entity_kind, row.entity_key).changes > 0 || changed;
      }
    });
    if (changed) touchStars(user.id);
  });
  removeStars();
  return true;
}

const starredRows = (user) => (user?.id ? getStarsStmt.all(user.id) : []);

const starredAtFromRows = (rows) => {
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
const starredAtFor = (user) => starredAtFromRows(libraryStarRows(user, starredRows(user)));

export function getStarredIdentityKeys(user) {
  return new Set(
    libraryStarRows(user, starredRows(user)).map((row) => `${row.entity_kind}:${row.entity_key}`),
  );
}

const buildStarred = (library, rows, user) => {
  const starred = { album: [], artist: [], song: [] };
  for (const row of rows) {
    const parsed = { kind: row.entity_kind, key: row.entity_key };
    if (["flow-song", "shared-song"].includes(parsed.kind)) {
      const separator = parsed.key.indexOf(":");
      const kind = parsed.kind === "flow-song" ? "flow" : "shared";
      const playlist = separator > 0
        ? playlistFromId(user, idFor(kind, parsed.key.slice(0, separator)))
        : null;
      const job = separator > 0 ? downloadTracker.getJob(parsed.key.slice(separator + 1)) : null;
      if (playlist && playlistOwnsJob(playlist, job)) {
        // Rows still flagged as playlist songs did not resolve to a library track above.
        starred.song.push(toPlaylistSong(playlist, kind, job, library.starredAt, null));
      }
      continue;
    }
    const entity = findLibraryEntry(library, parsed);
    if (!entity) continue;
    if (parsed.kind === "artist") starred.artist.push(toArtistSummary(entity, library));
    if (parsed.kind === "album") starred.album.push(toAlbumSummary(library, entity));
    if (parsed.kind === "song") starred.song.push(toSong(library, entity));
  }
  return starred;
};

export function getStarredWithLibrary(user, { availableOnly = false } = {}) {
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
  return { starred: buildStarred(indexFocusedLibrary(library, starredAtFromRows(rows)), rows, user), library };
}

export function getStarred(user) {
  return getStarredWithLibrary(user, { availableOnly: true }).starred;
}

export function getArtistInfo(value) {
  return getArtist(value) ? { similarArtist: [] } : null;
}

export function getTopSongs(artist, options = {}, user = null) {
  const target = String(artist || "").trim();
  if (!target) return [];
  const library = indexFocusedLibrary(getLibraryTopTracks({
    source: "all",
    availableOnly: true,
    artist: target,
    limit: normalizeLimit(options.count),
  }), starredAtFor(user));
  return library.tracks.map((track) => toSong(library, track));
}

export function getSubsonicPlaylists(user) {
  const flows = visibleFlows(user).map((flow) => {
    const jobs = visiblePlaylistJobs(flow);
    const playlist = {
      id: idFor("flow", flow.id),
      name: flow.name,
      owner: user.username,
      coverArt: playlistCoverArt("flow", flow.id),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(flow.createdAt || Date.now()).toISOString(),
      changed: new Date(flow.lastRunAt || flow.createdAt || Date.now()).toISOString(),
    };
    if (flow.description) playlist.comment = flow.description;
    return playlist;
  });
  const staticPlaylists = flowPlaylistConfig.getStaticPlaylistsForUser(user).map((playlist) => {
    const jobs = visiblePlaylistJobs(playlist, { includePending: true });
    const value = {
      id: idFor("shared", playlist.id),
      name: playlist.name,
      owner: user.username,
      coverArt: playlistCoverArt("shared", playlist.id),
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(playlist.createdAt || Date.now()).toISOString(),
      changed: new Date(playlist.importedAt || playlist.createdAt || Date.now()).toISOString(),
    };
    if (playlist.description) value.comment = playlist.description;
    return value;
  });
  return [...flows, ...staticPlaylists];
}

export function getSubsonicPlaylist(value, user) {
  const parsed = parseId(value);
  const kind = parsed?.kind === "shared" ? "shared" : "flow";
  const playlist = playlistFromId(user, value);
  if (!playlist) return null;
  const jobs = visiblePlaylistJobs(playlist);
  const starredAt = starredAtFor(user);
  const owned = resolveLibraryTracks(jobs.map((job) => trackFromJob(job)));
  return {
    id: idFor(kind, playlist.id),
    name: playlist.name,
    owner: user.username,
    coverArt: playlistCoverArt(kind, playlist.id),
    songCount: jobs.length,
    duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
    public: false,
    created: new Date(playlist.createdAt || Date.now()).toISOString(),
    changed: new Date(
      (kind === "flow" ? playlist.lastRunAt : playlist.importedAt) || playlist.createdAt || Date.now(),
    ).toISOString(),
    entry: jobs.map((job, index) => toPlaylistSong(playlist, kind, job, starredAt, owned[index])),
  };
}

export function resolveStreamPath(value, user) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    return playlistEntry.job.status === "done" && playlistEntry.job.finalPath
      ? playlistEntry.job.finalPath
      : null;
  }

  const parsed = parseId(value);
  if (parsed?.kind !== "song") return null;
  const library = indexFocusedLibrary(getLibraryTrack({
    trackId: parsed.key,
    source: "all",
    availableOnly: false,
  }));
  const track = findLibraryEntry(library, parsed);
  const album = findAlbumForTrack(library, track);
  const file = firstFile(track, album?.id, album?.managedBy);
  return file?.available && file.path ? file.path : null;
}

const cachedArtworkUrl = async (key) => {
  const cached = dbOps.getImage(key);
  if (!cached?.imageUrl || cached.imageUrl === "NOT_FOUND") return null;
  const artwork = await warmPublicImageUrl(cached.imageUrl, LIBRARY_IMAGE_PROFILE);
  if (artwork && artwork !== cached.imageUrl) dbOps.setImage(key, artwork);
  return artwork || buildImageProxyUrl(cached.imageUrl);
};

export async function resolveArtworkUrl(value) {
  const parsed = parseId(value);
  if (!parsed) return null;

  if (parsed.kind === "album" && parsed.key.startsWith("release-group:")) {
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

  const library = indexFocusedLibrary(parsed.kind === "artist"
    ? getLibraryForArtistReferences({
        source: "all",
        availableOnly: false,
        references: [parsed.key],
      })
    : parsed.kind === "album"
      ? getLibraryForAlbumReferences({
          source: "all",
          availableOnly: false,
          references: [parsed.key],
        })
      : getLibraryTrack({
          trackId: parsed.key,
          source: "all",
          availableOnly: false,
        }));
  const entity = findLibraryEntry(library, parsed);
  if (!entity) return null;

  if (parsed.kind === "artist") {
    const artistCacheKey = entity.mbid || entity.identityKey;
    const cached = await cachedArtworkUrl(artistCacheKey);
    if (cached) return cached;
    const albums = artistAlbums(library, entity);
    for (const album of albums) {
      const cacheId = album.releaseGroupMbid || album.mbid;
      const albumArtwork = cacheId ? await cachedArtworkUrl(`rg:${cacheId}`) : null;
      if (albumArtwork) {
        dbOps.setImage(artistCacheKey, albumArtwork);
        return albumArtwork;
      }
    }
    if (entity.mbid) {
      const result = await getArtistImage(entity.mbid, { artistName: entity.name });
      if (result?.url) {
        const artwork = await warmPublicImageUrl(result.url, LIBRARY_IMAGE_PROFILE);
        if (artwork) dbOps.setImage(artistCacheKey, artwork);
        return artwork;
      }
    }
    return null;
  }

  const album = parsed.kind === "album" ? entity : findAlbumForTrack(library, entity);
  if (!album) return null;
  const cacheId = album.releaseGroupMbid || album.mbid;
  const cached = cacheId ? await cachedArtworkUrl(`rg:${cacheId}`) : null;
  if (cached) return cached;
  if (!cacheId) return null;
  const artist = findArtistForAlbum(library, album);
  const result = await fetchReleaseGroupCoverUrl(cacheId, {
    artistName: artist?.name || album.albumArtist || "",
    albumTitle: album.title,
  });
  if (!result?.imageUrl) return null;
  const artwork = await warmPublicImageUrl(result.imageUrl, LIBRARY_IMAGE_PROFILE);
  if (artwork) dbOps.setImage(`rg:${cacheId}`, artwork);
  return artwork;
}

export async function resolvePlaylistArtwork(value, user) {
  const parsed = parseId(value);
  if (!parsed || !["flow", "shared"].includes(parsed.kind)) return null;
  const playlist = playlistFromId(user, value);
  return playlist ? playlistManager.resolveArtworkFile(playlist.id) : null;
}

export { idFor, parseId };
