import { randomUUID } from "node:crypto";
import { dbOps } from "../db/helpers/index.js";
import { db } from "../config/db-sqlite.js";
import { getCanonicalLibrary } from "./libraryQueryService.js";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.js";
import { getArtistImage } from "./imageService.js";
import { buildImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  flowPlaylistConfig,
  normalizeSharedTrack,
  orderJobsBySharedPlaylistTracks,
  tracksShareMembership,
} from "./weeklyFlow/weeklyFlowPlaylistConfig.js";
import { playlistManager } from "./weeklyFlow/weeklyFlowPlaylistManager.js";
import { weeklyFlowWorker } from "./weeklyFlow/weeklyFlowWorker.js";
import { hasPermission } from "../middleware/auth.js";
import { recordTrackJobQueued } from "./aurralHistoryService.js";

const idFor = (kind, key) => `${kind}:${encodeURIComponent(String(key))}`;
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

const firstFile = (track) =>
  (track?.files || []).find((file) => file.available) || (track?.files || [])[0] || null;

const seconds = (durationMs) => {
  const value = Number(durationMs);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0;
};

const PROTOCOL_DATE = "1970-01-01T00:00:00.000Z";

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
  const file = firstFile(track);
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
    created: PROTOCOL_DATE,
    track: Number(relation?.trackNumber) || 0,
    discNumber: Number(relation?.discNumber) || 1,
    coverArt: album ? coverArtForAlbum(album) : undefined,
    duration: seconds(file?.durationMs),
    size: Number(file?.size || 0),
    suffix: format,
    path: idFor("song", track.identityKey),
    type: "music",
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
    isDir: false,
    isVideo: false,
    created: PROTOCOL_DATE,
    coverArt: coverArtForAlbum(album),
    songCount: tracks.length,
    duration: tracks.reduce((total, track) => total + seconds(firstFile(track)?.durationMs), 0),
    song: [],
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
  };
  if (genres.length) {
    value.genre = genres[0];
    value.genres = genres.map((name) => ({ name }));
  }
  return value;
};

const toArtistSummary = (artist) => {
  const genres = entityGenres(artist);
  return {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: artist.albumIds.length,
    ...(genres.length
      ? { genre: genres[0], genres: genres.map((name) => ({ name })) }
      : {}),
  };
};

const indexLibrary = (library) => ({
  ...library,
  artistsById: new Map(library.artists.map((artist) => [artist.id, artist])),
  albumsById: new Map(library.albums.map((album) => [album.id, album])),
  tracksById: new Map(library.tracks.map((track) => [track.id, track])),
  artistsByIdentity: new Map(library.artists.map((artist) => [artist.identityKey, artist])),
  albumsByIdentity: new Map(library.albums.map((album) => [album.identityKey, album])),
  tracksByIdentity: new Map(library.tracks.map((track) => [track.identityKey, track])),
});

function readLibrary() {
  return indexLibrary(getCanonicalLibrary({ availableOnly: false }));
}

function findCanonical(library, parsed) {
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
  return flowPlaylistConfig.getSharedPlaylistForUser(user, parsed.key);
}

function toPlaylistSong(playlist, kind, job) {
  const artist = protocolArtist(null, job.artistName || "Unknown Artist");
  const format = String(job.finalPath || "").split(".").pop()?.toLowerCase() || "mp3";
  const id = idFor(kind === "flow" ? "flow-song" : "shared-song", `${playlist.id}:${job.id}`);
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
    created: PROTOCOL_DATE,
    track: job.trackNumber || 0,
    discNumber: job.discNumber || 1,
    duration: seconds(job.durationMs),
    size: Number(job.size || 0),
    suffix: format,
    path: id,
    type: "music",
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
  return orderJobsBySharedPlaylistTracks(uniqueJobs, playlist.tracks);
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

const flowJobs = (flow, { includePending = false } = {}) =>
  playlistJobs(flow).filter(
    (job) => includePending || (job.status === "done" && job.finalPath),
  );

const playlistCoverArt = (kind, playlistId) => idFor(kind, playlistId);

export function listArtists() {
  const library = readLibrary();
  const artists = [...library.artists].sort((left, right) =>
    String(left.sortName || left.name).localeCompare(String(right.sortName || right.name)),
  );
  return artists.map(toArtistSummary);
}

export function getArtist(value) {
  const library = readLibrary();
  const parsed = parseId(value);
  const artist = parsed?.kind === "artist" ? findCanonical(library, parsed) : null;
  return artist?.identityKey ? toArtist(library, artist) : null;
}

export function getAlbum(value) {
  const library = readLibrary();
  const parsed = parseId(value);
  const album = parsed?.kind === "album" ? findCanonical(library, parsed) : null;
  return album?.identityKey ? toAlbum(library, album) : null;
}

export function getSong(value, user) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) return toPlaylistSong(playlistEntry.playlist, playlistEntry.kind, playlistEntry.job);

  const library = readLibrary();
  const parsed = parseId(value);
  const track = parsed?.kind === "song" ? findCanonical(library, parsed) : null;
  return track?.identityKey ? toSong(library, track) : null;
}

export function getMusicDirectory(value) {
  if (value === "root" || value === "1") {
    const rootId = value === "1" ? "1" : "root";
    return {
      id: rootId,
      name: "Aurral",
      child: listArtists().map((artist) => ({
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
    const artist = getArtist(value);
    return artist ? { id: artist.id, name: artist.name, child: artist.album || [] } : null;
  }
  if (parsed?.kind === "album") {
    const album = getAlbum(value);
    return album ? { id: album.id, name: album.name, child: album.song || [] } : null;
  }
  return null;
}

export function searchLibrary(query, options = {}) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  const library = readLibrary();
  const artists = library.artists.filter((artist) =>
    artist.name.toLocaleLowerCase().includes(needle),
  );
  const albums = library.albums
    .filter((album) => {
      const artist = findArtistForAlbum(library, album);
      return [album.title, album.albumArtist, artist?.name].some((value) =>
        String(value || "").toLocaleLowerCase().includes(needle),
      );
    });
  const songs = library.tracks
    .filter((track) => {
      const album = findAlbumForTrack(library, track);
      const artist = findArtistForAlbum(library, album);
      return [track.title, track.artistName, album?.title, artist?.name].some((value) =>
        String(value || "").toLocaleLowerCase().includes(needle),
      );
    });
  const page = (items, count, offset) => items.slice(offset, offset + count);
  return {
    artist: page(artists, normalizeLimit(options.artistCount), normalizeOffset(options.artistOffset)).map(
      toArtistSummary,
    ),
    album: page(albums, normalizeLimit(options.albumCount), normalizeOffset(options.albumOffset)).map(
      (album) => toAlbum(library, album),
    ),
    song: page(songs, normalizeLimit(options.songCount), normalizeOffset(options.songOffset)).map(
      (track) => toSong(library, track),
    ),
  };
}

export function getAlbumList(options = {}) {
  const library = readLibrary();
  const type = String(options.type || "alphabeticalByName");
  let albums = [...library.albums];

  if (type === "starred") return [];
  if (options.genre) {
    const genre = String(options.genre).toLocaleLowerCase();
    albums = albums.filter((album) =>
      albumData(library, album).value.genres?.some((entry) =>
        entry.name.toLocaleLowerCase() === genre,
      ),
    );
  }
  if (type === "byYear" || options.fromYear || options.toYear) {
    const fromYear = Number.parseInt(options.fromYear, 10);
    const toYear = Number.parseInt(options.toYear, 10);
    const lowerYear = Number.isFinite(fromYear) && Number.isFinite(toYear)
      ? Math.min(fromYear, toYear)
      : fromYear;
    const upperYear = Number.isFinite(fromYear) && Number.isFinite(toYear)
      ? Math.max(fromYear, toYear)
      : toYear;
    albums = albums.filter((album) => {
      const releaseYear = year(album.releaseDate) || 0;
      return (!Number.isFinite(lowerYear) || releaseYear >= lowerYear) &&
        (!Number.isFinite(upperYear) || releaseYear <= upperYear);
    });
  }

  const values = new Map(albums.map((album) => [album.id, albumData(library, album).value]));
  const compareName = (left, right) =>
    `${left.title}\u0000${left.albumArtist}`.localeCompare(
      `${right.title}\u0000${right.albumArtist}`,
    );
  const compareArtist = (left, right) =>
    `${left.albumArtist}\u0000${left.title}`.localeCompare(
      `${right.albumArtist}\u0000${right.title}`,
    );
  const compareReleaseDate = (left, right) => {
    const leftDate = Date.parse(String(left.releaseDate || ""));
    const rightDate = Date.parse(String(right.releaseDate || ""));
    if (!Number.isFinite(leftDate) && !Number.isFinite(rightDate)) return compareName(left, right);
    if (!Number.isFinite(leftDate)) return 1;
    if (!Number.isFinite(rightDate)) return -1;
    return rightDate - leftDate || compareName(left, right);
  };
  const compareYear = (left, right) => {
    const leftYear = year(left.releaseDate) || 0;
    const rightYear = year(right.releaseDate) || 0;
    return leftYear - rightYear || compareName(left, right);
  };
  const compareGenre = (left, right) =>
    `${values.get(left.id)?.genre || ""}\u0000${left.title}`.localeCompare(
      `${values.get(right.id)?.genre || ""}\u0000${right.title}`,
    );

  if (type === "random") {
    for (let index = albums.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [albums[index], albums[swapIndex]] = [albums[swapIndex], albums[index]];
    }
  } else if (type === "newest" || type === "recent") {
    albums.sort(compareReleaseDate);
  } else if (type === "alphabeticalByArtist") {
    albums.sort(compareArtist);
  } else if (type === "byYear") {
    const fromYear = Number.parseInt(options.fromYear, 10);
    const toYear = Number.parseInt(options.toYear, 10);
    albums.sort((left, right) => {
      const comparison = compareYear(left, right);
      return Number.isFinite(fromYear) && Number.isFinite(toYear) && fromYear > toYear
        ? -comparison
        : comparison;
    });
  } else if (type === "byGenre") {
    albums.sort(compareGenre);
  } else {
    albums.sort(compareName);
  }
  const offset = normalizeOffset(options.offset);
  const size = normalizeLimit(options.size);
  return albums.slice(offset, offset + size).map((album) => toAlbumSummary(library, album));
}

export function getSongsByGenre(genre, options = {}) {
  const target = String(genre || "").trim().toLocaleLowerCase();
  if (!target) return [];
  const library = readLibrary();
  const tracks = library.tracks.filter((track) => {
    const album = findAlbumForTrack(library, track);
    const artist = findArtistForAlbum(library, album);
    return [
      ...entityGenres(artist),
      ...entityGenres(album),
      ...entityGenres(track),
    ].some((value) => value.toLocaleLowerCase() === target);
  });
  const offset = normalizeOffset(options.offset);
  const size = normalizeLimit(options.count);
  return tracks.slice(offset, offset + size).map((track) => toSong(library, track));
}

export function getGenres() {
  const library = readLibrary();
  const genres = new Map();
  for (const album of library.albums) {
    const tracks = albumTracks(library, album);
    const artistGenres = entityGenres(findArtistForAlbum(library, album));
    const albumMetadataGenres = entityGenres(album);
    const albumGenres = [
      ...artistGenres,
      ...entityGenres(album),
      ...tracks.flatMap((track) => entityGenres(track)),
    ];
    for (const name of new Set(albumGenres)) {
      const value = genres.get(name) || { albumCount: 0, songCount: 0, value: name };
      value.albumCount += 1;
      value.songCount +=
        artistGenres.includes(name) || albumMetadataGenres.includes(name)
          ? tracks.length
          : tracks.filter((track) => entityGenres(track).includes(name)).length;
      genres.set(name, value);
    }
  }
  return [...genres.values()].sort((left, right) => left.value.localeCompare(right.value));
}

const getStarsStmt = db.prepare(
  "SELECT entity_kind, entity_key FROM subsonic_stars WHERE user_id = ? ORDER BY created_at, entity_kind, entity_key",
);
const addStarStmt = db.prepare(
  "INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, ?)",
);
const removeStarStmt = db.prepare(
  "DELETE FROM subsonic_stars WHERE user_id = ? AND entity_kind = ? AND entity_key = ?",
);

const isSameTrack = (left, right) => tracksShareMembership(left, right);

const trackFromJob = (job) => normalizeSharedTrack({
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

const trackFromCanonical = (library, track) => {
  const album = findAlbumForTrack(library, track);
  return normalizeSharedTrack({
    artistName: track?.artistName,
    trackName: track?.title,
    albumName: album?.title,
    artistMbid: findArtistForAlbum(library, album)?.mbid,
    albumMbid: album?.mbid || album?.releaseGroupMbid,
    trackMbid: track?.mbid,
    releaseYear: year(album?.releaseDate),
    durationMs: firstFile(track)?.durationMs,
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
  const library = readLibrary();
  const track = findCanonical(library, parsed);
  const normalized = trackFromCanonical(library, track);
  return normalized ? { kind: "song", track: normalized, canonical: track } : null;
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

const findAvailableCanonicalFile = (track) => {
  const library = readLibrary();
  const candidate = library.tracks.find((entry) => isSameTrack(track, trackFromCanonical(library, entry)));
  const file = firstFile(candidate);
  return file?.available && file.path ? { file, albumName: findAlbumForTrack(library, candidate)?.title } : null;
};

const ensureLibraryJob = (track, createdJobIds = null) => {
  const existing = findLibraryJob(track);
  if (existing) {
    if (existing.status === "failed") {
      downloadTracker.setPending(existing.id, "Requested again", { asRetryCycle: true });
    }
    if (existing.status !== "done") {
      weeklyFlowWorker.start().catch(() => {});
    }
    return existing.id;
  }

  const jobId = downloadTracker.addJob(track, "library");
  if (!jobId) return null;
  if (createdJobIds) createdJobIds.push(jobId);
  const owned = findAvailableCanonicalFile(track);
  if (owned) {
    downloadTracker.setDone(jobId, owned.file.path, owned.albumName || track.albumName || null);
    return jobId;
  }
  recordTrackJobQueued(downloadTracker.getJob(jobId));
  weeklyFlowWorker.start().catch(() => {});
  return jobId;
};

const toCanonicalPlaylistTrack = (track, canonicalJobId) => ({
  ...track,
  canonicalJobId: String(canonicalJobId || "").trim() || null,
});

const removeLegacyPlaylistJobs = (playlistId) => {
  for (const job of downloadTracker.getByPlaylistType(playlistId)) {
    downloadTracker.removeJob(job.id);
  }
};

const refreshSubsonicPlaylist = (playlistId) => {
  playlistManager.updateConfig(false);
  Promise.all([
    playlistManager.ensureSmartPlaylists(),
    playlistManager.refreshPlaylist(playlistId),
  ]).catch(() => {});
  playlistManager.scheduleScanLibrary();
};

const normalizeSharedPlaylistId = (value) => {
  const parsed = parseId(value);
  return parsed?.kind === "shared" ? parsed.key : String(value || "").trim();
};

const canonicalizePlaylistTracks = (tracks, createdJobIds = null) => {
  const normalized = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const candidate = normalizeSharedTrack(track);
    if (!candidate) continue;
    const existingJob = candidate.canonicalJobId
      ? downloadTracker.getJob(candidate.canonicalJobId)
      : null;
    const jobId = existingJob && isSameTrack(existingJob, candidate)
      ? existingJob.id
      : ensureLibraryJob(candidate, createdJobIds);
    if (!jobId) return null;
    normalized.push(toCanonicalPlaylistTrack(candidate, jobId));
  }
  return normalized;
};

const replaceSubsonicPlaylistTracks = (user, playlist, tracks, updates = {}) => {
  if (!playlist || !flowPlaylistConfig.canUserAccessSharedPlaylist(user, playlist)) return null;
  const createdJobIds = [];
  const canonicalTracks = canonicalizePlaylistTracks(tracks, createdJobIds);
  if (!canonicalTracks) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    return null;
  }
  const updated = flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
    ...updates,
    tracks: canonicalTracks,
  });
  if (!updated) {
    for (const jobId of createdJobIds) downloadTracker.removeJob(jobId);
    return null;
  }
  removeLegacyPlaylistJobs(playlist.id);
  refreshSubsonicPlaylist(playlist.id);
  return updated;
};

export function createSubsonicPlaylist(user, { name, songIds = [] } = {}) {
  if (!hasPermission(user, "accessFlow")) return null;
  const safeName = String(name || "").trim();
  if (!safeName) return null;
  const resolved = songIds.map((id) => resolveSubsonicTrack(user, id));
  if (resolved.some((entry) => !entry)) return null;
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    id: randomUUID(),
    name: safeName,
    ownerUserId: user.id,
    tracks: [],
  });
  const updated = replaceSubsonicPlaylistTracks(
    user,
    playlist,
    resolved.map((entry) => entry.track),
  );
  if (!updated) flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
  return updated;
}

export function updateSubsonicPlaylist(
  user,
  { playlistId, name, comment, songIdsToAdd = [], songIndexesToRemove = [] } = {},
) {
  const playlist = flowPlaylistConfig.getSharedPlaylistForUser(
    user,
    normalizeSharedPlaylistId(playlistId),
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
}

export function deleteSubsonicPlaylist(user, playlistId) {
  const playlist = flowPlaylistConfig.getSharedPlaylistForUser(
    user,
    normalizeSharedPlaylistId(playlistId),
  );
  if (!playlist || !hasPermission(user, "accessFlow")) return false;
  removeLegacyPlaylistJobs(playlist.id);
  const deleted = flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
  if (deleted) {
    playlistManager.updateConfig(false);
    playlistManager.deletePlaybackPlaylist(playlist).catch(() => {});
  }
  return deleted;
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

export function starMany(user, values) {
  const parsed = values.map(starTarget);
  if (!parsed.length || parsed.some((target) => !target) || !user?.id) return false;
  const library = readLibrary();
  const playlistSongs = parsed.map((target) =>
    ["flow-song", "shared-song"].includes(target.kind)
      ? resolvePlaylistSong(user, idFor(target.kind, target.key))
      : null,
  );
  if (parsed.some((target, index) =>
    ["flow-song", "shared-song"].includes(target.kind)
      ? !playlistSongs[index]
      : !findCanonical(library, target),
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
    for (const target of parsed) addStarStmt.run(user.id, target.kind, target.key, Date.now());
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
  const removeStars = db.transaction(() => {
    for (const target of parsed) removeStarStmt.run(user.id, target.kind, target.key);
  });
  removeStars();
  return true;
}

const starredRows = (user) => (user?.id ? getStarsStmt.all(user.id) : []);

export function getStarredIdentityKeys(user) {
  return new Set(starredRows(user).map((row) => `${row.entity_kind}:${row.entity_key}`));
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
        starred.song.push(toPlaylistSong(playlist, kind, job));
      }
      continue;
    }
    const entity = findCanonical(library, parsed);
    if (!entity) continue;
    if (parsed.kind === "artist") starred.artist.push(toArtistSummary(entity));
    if (parsed.kind === "album") starred.album.push(toAlbumSummary(library, entity));
    if (parsed.kind === "song") starred.song.push(toSong(library, entity));
  }
  return starred;
};

export function getStarredWithLibrary(user) {
  const rows = starredRows(user);
  const canonicalRows = rows.filter((row) => ["artist", "album", "song"].includes(row.entity_kind));
  const library = getCanonicalLibrary({
    favoriteKeys: canonicalRows.map((row) => ({ kind: row.entity_kind, key: row.entity_key })),
  });
  return { starred: buildStarred(indexLibrary(library), rows, user), library };
}

export function getStarred(user) {
  return getStarredWithLibrary(user).starred;
}

export function getArtistInfo(value) {
  return getArtist(value) ? { similarArtist: [] } : null;
}

export function getTopSongs(artist, options = {}) {
  const target = String(artist || "").trim();
  if (!target) return [];
  const library = readLibrary();
  const normalizedTarget = target.toLocaleLowerCase();
  const artistRecord = library.artists.find(
    (entry) =>
      entry.identityKey === target || entry.name.toLocaleLowerCase() === normalizedTarget,
  );
  if (!artistRecord) return [];
  const tracks = library.tracks.filter((track) => {
    const album = findAlbumForTrack(library, track);
    const trackArtist = findArtistForAlbum(library, album);
    return (
      trackArtist?.id === artistRecord.id ||
      String(track.artistName || "").trim().toLocaleLowerCase() === normalizedTarget
    );
  });
  return tracks.slice(0, normalizeLimit(options.count)).map((track) => toSong(library, track));
}

export function getFlowPlaylists(user) {
  const flows = visibleFlows(user).map((flow) => {
    const jobs = flowJobs(flow);
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
  const sharedPlaylists = flowPlaylistConfig.getSharedPlaylistsForUser(user).map((playlist) => {
    const jobs = flowJobs(playlist, { includePending: true });
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
  return [...flows, ...sharedPlaylists];
}

export function getFlowPlaylist(value, user) {
  const parsed = parseId(value);
  const kind = parsed?.kind === "shared" ? "shared" : "flow";
  const playlist = playlistFromId(user, value);
  if (!playlist) return null;
  const jobs = flowJobs(playlist);
  return {
    id: idFor(kind, playlist.id),
    name: playlist.name,
    owner: user.username,
    coverArt: playlistCoverArt(kind, playlist.id),
    songCount: jobs.length,
    duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
    public: false,
    entry: jobs.map((job) => toPlaylistSong(playlist, kind, job)),
  };
}

export function resolveStreamPath(value, user) {
  const playlistEntry = playlistJobFromId(user, value);
  if (playlistEntry) {
    return playlistEntry.job.status === "done" && playlistEntry.job.finalPath
      ? playlistEntry.job.finalPath
      : null;
  }

  const library = readLibrary();
  const track = findCanonical(library, parseId(value));
  const file = firstFile(track);
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

  const library = readLibrary();
  const entity = findCanonical(library, parsed);
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
