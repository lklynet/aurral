import { dbOps } from "../db/helpers/index.js";
import { getCanonicalLibrary } from "./libraryQueryService.js";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.js";
import { getArtistImage } from "./imageService.js";
import { buildImageProxyUrl } from "./imageProxyService.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { flowPlaylistConfig } from "./weeklyFlow/weeklyFlowPlaylistConfig.js";
import { hasPermission } from "../middleware/auth.js";

const idFor = (kind, key) => `${kind}:${encodeURIComponent(String(key))}`;

const parseId = (value) => {
  const match = /^(artist|album|song|flow|flow-song):(.+)$/.exec(String(value || ""));
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
  return genreNames(
    metadata.common?.genre || metadata.genre || metadata.tags?.genre,
  );
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
  const genres = entityGenres(track);
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
  return {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: albums.length,
    album: albums.map((album) => toAlbumSummary(library, album)),
  };
};

const toArtistSummary = (artist) => ({
  id: idFor("artist", artist.identityKey),
  name: artist.name,
  coverArt: idFor("artist", artist.identityKey),
  albumCount: artist.albumIds.length,
});

function readLibrary() {
  const library = getCanonicalLibrary({ availableOnly: false });
  return {
    ...library,
    artistsById: new Map(library.artists.map((artist) => [artist.id, artist])),
    albumsById: new Map(library.albums.map((album) => [album.id, album])),
    tracksById: new Map(library.tracks.map((track) => [track.id, track])),
    artistsByIdentity: new Map(library.artists.map((artist) => [artist.identityKey, artist])),
    albumsByIdentity: new Map(library.albums.map((album) => [album.identityKey, album])),
    tracksByIdentity: new Map(library.tracks.map((track) => [track.identityKey, track])),
  };
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

function flowFromId(user, value) {
  const parsed = parseId(value);
  if (!parsed || parsed.kind !== "flow") return null;
  const flow = flowPlaylistConfig.getFlow(parsed.key);
  return flow && visibleFlows(user).some((entry) => entry.id === flow.id) ? flow : null;
}

function toFlowSong(flow, job) {
  const artist = protocolArtist(null, job.artistName || "Unknown Artist");
  const format = String(job.finalPath || "").split(".").pop()?.toLowerCase() || "mp3";
  const id = idFor("flow-song", `${flow.id}:${job.id}`);
  return {
    id,
    parent: idFor("flow", flow.id),
    isDir: false,
    isVideo: false,
    title: job.trackName,
    album: job.albumName || "Unknown Album",
    artist: artist.name,
    artistId: artist.id,
    albumArtists: [artist],
    artists: [artist],
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

function flowJobFromId(user, value) {
  const parsed = parseId(value);
  if (!parsed || parsed.kind !== "flow-song") return null;
  const separator = parsed.key.indexOf(":");
  if (separator < 1) return null;
  const flow = flowFromId(user, idFor("flow", parsed.key.slice(0, separator)));
  if (!flow) return null;
  const job = downloadTracker.getJob(parsed.key.slice(separator + 1));
  return job?.playlistType === flow.id && job.status === "done" && job.finalPath
    ? { flow, job }
    : null;
}

const flowJobs = (flow) =>
  downloadTracker
    .getByPlaylistType(flow.id)
    .filter((job) => job.status === "done" && job.finalPath);

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
  const flowEntry = flowJobFromId(user, value);
  if (flowEntry) return toFlowSong(flowEntry.flow, flowEntry.job);

  const library = readLibrary();
  const parsed = parseId(value);
  const track = parsed?.kind === "song" ? findCanonical(library, parsed) : null;
  return track?.identityKey ? toSong(library, track) : null;
}

export function getMusicDirectory(value) {
  if (value === "root") {
    return {
      id: "root",
      name: "Aurral",
      child: listArtists().map((artist) => ({
        id: artist.id,
        parent: "root",
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
    albums = albums.filter((album) => {
      const releaseYear = year(album.releaseDate) || 0;
      return (!Number.isFinite(fromYear) || releaseYear >= fromYear) &&
        (!Number.isFinite(toYear) || releaseYear <= toYear);
    });
  }

  albums.sort((left, right) =>
    `${left.title}\u0000${left.albumArtist}`.localeCompare(
      `${right.title}\u0000${right.albumArtist}`,
    ),
  );
  const offset = normalizeOffset(options.offset);
  const size = normalizeLimit(options.size);
  return albums.slice(offset, offset + size).map((album) => toAlbumSummary(library, album));
}

export function getGenres() {
  const library = readLibrary();
  const genres = new Map();
  for (const album of library.albums) {
    const tracks = albumTracks(library, album);
    const albumGenres = [
      ...entityGenres(album),
      ...tracks.flatMap((track) => entityGenres(track)),
    ];
    for (const name of new Set(albumGenres)) {
      const value = genres.get(name) || { albumCount: 0, songCount: 0, value: name };
      value.albumCount += 1;
      value.songCount += tracks.filter((track) => entityGenres(track).includes(name)).length;
      genres.set(name, value);
    }
  }
  return [...genres.values()].sort((left, right) => left.value.localeCompare(right.value));
}

export function getStarred() {
  return { album: [], artist: [], song: [] };
}

export function getArtistInfo(value) {
  return getArtist(value) ? { similarArtist: [] } : null;
}

export function getTopSongs(artist, options = {}) {
  return searchLibrary(artist, { songCount: options.count }).song;
}

export function getFlowPlaylists(user) {
  return visibleFlows(user).map((flow) => {
    const jobs = flowJobs(flow);
    const playlist = {
      id: idFor("flow", flow.id),
      name: flow.name,
      owner: user.username,
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      public: false,
      created: new Date(flow.createdAt || Date.now()).toISOString(),
      changed: new Date(flow.lastRunAt || flow.createdAt || Date.now()).toISOString(),
    };
    if (flow.description) playlist.comment = flow.description;
    return playlist;
  });
}

export function getFlowPlaylist(value, user) {
  const flow = flowFromId(user, value);
  if (!flow) return null;
  const jobs = flowJobs(flow);
  return {
    id: idFor("flow", flow.id),
    name: flow.name,
    owner: user.username,
    songCount: jobs.length,
    duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
    public: false,
    entry: jobs.map((job) => toFlowSong(flow, job)),
  };
}

export function resolveStreamPath(value, user) {
  const flowEntry = flowJobFromId(user, value);
  if (flowEntry) {
    return flowEntry.job.status === "done" && flowEntry.job.finalPath
      ? flowEntry.job.finalPath
      : null;
  }

  const library = readLibrary();
  const track = findCanonical(library, parseId(value));
  const file = firstFile(track);
  return file?.available && file.path ? file.path : null;
}

const cachedArtworkUrl = (key) => {
  const cached = dbOps.getImage(key);
  if (!cached?.imageUrl || cached.imageUrl === "NOT_FOUND") return null;
  return buildImageProxyUrl(cached.imageUrl);
};

export async function resolveArtworkUrl(value) {
  const library = readLibrary();
  const parsed = parseId(value);
  const entity = findCanonical(library, parsed);
  if (!entity) return null;

  if (parsed.kind === "artist") {
    const cached = cachedArtworkUrl(entity.mbid || entity.identityKey);
    if (cached) return cached;
    if (!entity.mbid) return null;
    const result = await getArtistImage(entity.mbid, { artistName: entity.name });
    return result?.url ? buildImageProxyUrl(result.url) : null;
  }

  const album = parsed.kind === "album" ? entity : findAlbumForTrack(library, entity);
  if (!album) return null;
  const cacheId = album.releaseGroupMbid || album.mbid;
  const cached = cacheId ? cachedArtworkUrl(`rg:${cacheId}`) : null;
  if (cached) return cached;
  if (!cacheId) return null;
  const artist = findArtistForAlbum(library, album);
  const result = await fetchReleaseGroupCoverUrl(cacheId, {
    artistName: artist?.name || album.albumArtist || "",
    albumTitle: album.title,
  });
  return result?.imageUrl ? buildImageProxyUrl(result.imageUrl) : null;
}

export { idFor, parseId };
