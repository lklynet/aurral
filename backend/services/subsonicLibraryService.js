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

const visibleFlows = (user) =>
  user && hasPermission(user, "accessFlow") ? flowPlaylistConfig.getFlowsForUser(user) : [];

const findAlbumForTrack = (library, track) => {
  const relation = track?.albums?.[0];
  return library.albums.find((album) => album.id === relation?.albumId) || null;
};

const findArtistForAlbum = (library, album) =>
  library.artists.find((artist) => artist.id === album?.artistId) || null;

const albumTracks = (library, album) =>
  (album?.trackIds || [])
    .map((trackId) => library.tracks.find((track) => track.id === trackId))
    .filter(Boolean);

const artistAlbums = (library, artist) =>
  library.albums.filter((album) => album.artistId === artist?.id);

const coverArtForAlbum = (album) => idFor("album", album.identityKey);

const toSong = (library, track, album = findAlbumForTrack(library, track)) => {
  const artist = findArtistForAlbum(library, album);
  const file = firstFile(track);
  const genres = track.metadata?.common?.genre || track.metadata?.genre;
  return {
    id: idFor("song", track.identityKey),
    parent: album ? idFor("album", album.identityKey) : null,
    isDir: false,
    title: track.title,
    album: album?.title || null,
    artist: artist?.name || track.artistName || null,
    albumId: album ? idFor("album", album.identityKey) : null,
    artistId: artist ? idFor("artist", artist.identityKey) : null,
    track: album
      ? album.trackIds
          .map((trackId) => library.tracks.find((entry) => entry.id === trackId))
          .findIndex((entry) => entry?.id === track.id) + 1
      : 0,
    year: year(album?.releaseDate),
    genre: (Array.isArray(genres) ? genres[0] : genres) || null,
    coverArt: album ? coverArtForAlbum(album) : null,
    duration: seconds(file?.durationMs),
    size: Number(file?.size || 0),
    suffix: file?.format || null,
    type: "music",
  };
};

const toAlbum = (library, album) => {
  const artist = findArtistForAlbum(library, album);
  const tracks = albumTracks(library, album);
  return {
    id: idFor("album", album.identityKey),
    name: album.title,
    artist: artist?.name || album.albumArtist || null,
    artistId: artist ? idFor("artist", artist.identityKey) : null,
    coverArt: coverArtForAlbum(album),
    songCount: tracks.length,
    duration: tracks.reduce((total, track) => total + seconds(firstFile(track)?.durationMs), 0),
    year: year(album.releaseDate),
    song: tracks.map((track) => toSong(library, track, album)),
  };
};

const toArtist = (library, artist) => {
  const albums = artistAlbums(library, artist);
  return {
    id: idFor("artist", artist.identityKey),
    name: artist.name,
    coverArt: idFor("artist", artist.identityKey),
    albumCount: albums.length,
    album: albums.map((album) => ({
      ...toAlbum(library, album),
      song: undefined,
    })),
  };
};

const toArtistSummary = (artist) => ({
  id: idFor("artist", artist.identityKey),
  name: artist.name,
  coverArt: idFor("artist", artist.identityKey),
  albumCount: artist.albumIds.length,
});

function readLibrary() {
  return getCanonicalLibrary({ availableOnly: false });
}

function findCanonical(library, parsed) {
  if (!parsed) return null;
  if (parsed.kind === "artist") {
    return library.artists.find((artist) => artist.identityKey === parsed.key) || null;
  }
  if (parsed.kind === "album") {
    return library.albums.find((album) => album.identityKey === parsed.key) || null;
  }
  if (parsed.kind === "song") {
    return library.tracks.find((track) => track.identityKey === parsed.key) || null;
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
  return {
    id: idFor("flow-song", `${flow.id}:${job.id}`),
    parent: idFor("flow", flow.id),
    isDir: false,
    title: job.trackName,
    album: job.albumName,
    artist: job.artistName,
    track: job.trackNumber || 0,
    year: job.releaseYear ? Number(job.releaseYear) : null,
    duration: seconds(job.durationMs),
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
  const artists = library.artists
    .filter((artist) => artist.name.toLocaleLowerCase().includes(needle))
    .map(toArtistSummary);
  const albums = library.albums
    .filter((album) => {
      const artist = findArtistForAlbum(library, album);
      return [album.title, album.albumArtist, artist?.name].some((value) =>
        String(value || "").toLocaleLowerCase().includes(needle),
      );
    })
    .map((album) => ({ ...toAlbum(library, album), song: undefined }));
  const songs = library.tracks
    .filter((track) => {
      const album = findAlbumForTrack(library, track);
      const artist = findArtistForAlbum(library, album);
      return [track.title, track.artistName, album?.title, artist?.name].some((value) =>
        String(value || "").toLocaleLowerCase().includes(needle),
      );
    })
    .map((track) => toSong(library, track));
  const page = (items, count, offset) => items.slice(offset, offset + count);
  return {
    artist: page(artists, normalizeLimit(options.artistCount), normalizeOffset(options.artistOffset)),
    album: page(albums, normalizeLimit(options.albumCount), normalizeOffset(options.albumOffset)),
    song: page(songs, normalizeLimit(options.songCount), normalizeOffset(options.songOffset)),
  };
}

export function getFlowPlaylists(user) {
  return visibleFlows(user).map((flow) => {
    const jobs = flowJobs(flow);
    return {
      id: idFor("flow", flow.id),
      name: flow.name,
      owner: user.username,
      songCount: jobs.length,
      duration: jobs.reduce((total, job) => total + seconds(job.durationMs), 0),
      created: new Date(flow.createdAt || Date.now()).toISOString(),
      changed: new Date(flow.lastRunAt || flow.createdAt || Date.now()).toISOString(),
      comment: flow.description || null,
    };
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
