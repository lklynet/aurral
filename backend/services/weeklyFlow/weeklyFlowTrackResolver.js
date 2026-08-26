import {
  lastfmRequest,
  musicbrainzResolveArtistMbidByName,
} from "../apiClients/index.js";
import {
  getArtistByMbid,
  getAlbumByMbid,
  listArtistAlbums,
  resolveAlbumByArtistAndTitle,
} from "../providers/brainzmashProvider.js";
import {
  artistNamesMatch,
  scoreTextMatch as scoreTextMatchBase,
  getYear,
  pickResolvedDurationMs,
} from "../providers/brainzmashRanking.js";

const artistAliasCache = new Map();
const releaseGroupSearchCache = new Map();
const releaseContextCache = new Map();
const MATCHER_OPTIONS = { extended: true };
const MAX_CACHE_ENTRIES = 500;

// ponytail: FIFO eviction, not LRU; upgrade to createCache() TTLs if hit rates matter
function boundedCacheSet(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

function pickBestCandidate(candidates, expectedTitle, expectedYear = null) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return null;
  const targetYear = getYear(expectedYear);
  return [...list]
    .map((candidate) => {
      const title =
        candidate?.title || candidate?.["title"] || candidate?.["release-group"]?.title || "";
      const year =
        candidate?.["first-release-date"] ||
        candidate?.date ||
        candidate?.["release-group"]?.["first-release-date"] ||
        null;
      const titleScore = scoreTextMatchBase(title, expectedTitle, MATCHER_OPTIONS);
      const yearScore =
        targetYear && getYear(year) === targetYear ? 10 : targetYear && getYear(year) ? -5 : 0;
      return {
        candidate,
        score: titleScore + yearScore,
      };
    })
    .sort((left, right) => right.score - left.score)[0]?.candidate;
}

function matchesAlbumTitle(actualTitle, expectedTitle) {
  return (
    !actualTitle ||
    !expectedTitle ||
    scoreTextMatchBase(actualTitle, expectedTitle, MATCHER_OPTIONS) >= 85
  );
}

async function fetchArtistAliases(artistMbid) {
  const key = String(artistMbid || "").trim();
  if (!key) return [];
  if (artistAliasCache.has(key)) {
    return artistAliasCache.get(key);
  }
  const promise = (async () => {
    try {
      const artist = await getArtistByMbid(key);
      const aliases = Array.isArray(artist?.aliases)
        ? artist.aliases.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [];
      return [...new Set(aliases)].slice(0, 8);
    } catch {
      return [];
    }
  })();
  boundedCacheSet(artistAliasCache, key, promise);
  const aliases = await promise;
  boundedCacheSet(artistAliasCache, key, aliases);
  return aliases;
}

async function resolveReleaseGroup(artistName, artistMbid, albumName, releaseYear) {
  const safeAlbum = String(albumName || "").trim();
  if (!safeAlbum) return null;
  const safeArtist = String(artistName || "").trim();
  const safeMbid = String(artistMbid || "").trim();
  const cacheKey = JSON.stringify([safeArtist, safeMbid, safeAlbum]);
  if (releaseGroupSearchCache.has(cacheKey)) {
    return releaseGroupSearchCache.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const resolvedId = await resolveAlbumByArtistAndTitle({
        artistName: safeArtist,
        artistMbid: safeMbid,
        albumTitle: safeAlbum,
        releaseYear,
      });
      if (resolvedId) {
        const album = await getAlbumByMbid(resolvedId).catch(() => null);
        return {
          id: String(resolvedId),
          title: String(album?.title || safeAlbum).trim() || safeAlbum,
          releaseYear: getYear(album?.releaseDate),
        };
      }
    } catch {}
    try {
      const candidates = safeMbid ? await listArtistAlbums(safeMbid) : [];
      const best = pickBestCandidate(candidates, safeAlbum, releaseYear);
      const bestTitle = best?.Title || best?.title;
      if ((best?.Id || best?.id) && matchesAlbumTitle(bestTitle, safeAlbum)) {
        return {
          id: String(best?.Id || best?.id),
          title: String(best?.Title || best?.title || safeAlbum).trim() || safeAlbum,
          releaseYear: getYear(best?.FirstReleaseDate || best?.firstReleaseDate),
        };
      }
    } catch {}
    return null;
  })();
  boundedCacheSet(releaseGroupSearchCache, cacheKey, promise);
  const resolved = await promise;
  boundedCacheSet(releaseGroupSearchCache, cacheKey, resolved);
  return resolved;
}

function _flattenReleaseTracks(releaseData) {
  const media = Array.isArray(releaseData?.media) ? releaseData.media : [];
  const tracks = [];
  for (const medium of media) {
    const mediumTracks = Array.isArray(medium?.tracks) ? medium.tracks : [];
    for (const track of mediumTracks) {
      const recording = track?.recording || null;
      const trackTitle = String(recording?.title || track?.title || track?.name || "").trim();
      if (!trackTitle) continue;
      tracks.push({
        title: trackTitle,
        trackNumber:
          track?.position != null && Number.isFinite(Number(track.position))
            ? Number(track.position)
            : null,
        durationMs:
          track?.length != null && Number.isFinite(Number(track.length))
            ? Number(track.length)
            : recording?.length != null && Number.isFinite(Number(recording.length))
              ? Number(recording.length)
              : null,
        recordingId: recording?.id ? String(recording.id) : null,
      });
    }
  }
  return tracks;
}

function matchTrackByTitle(tracks, trackName) {
  const safeTrackName = String(trackName || "").trim();
  if (!safeTrackName) return null;
  const best =
    [...(Array.isArray(tracks) ? tracks : [])]
      .map((track) => ({
        ...track,
        _score: scoreTextMatchBase(track?.title, safeTrackName, MATCHER_OPTIONS),
      }))
      .sort((left, right) => right._score - left._score)[0] || null;
  if (!best || best._score < 82) return null;
  return best;
}

async function fetchReleaseContext(albumMbid) {
  const key = String(albumMbid || "").trim();
  if (!key) return null;
  if (releaseContextCache.has(key)) {
    return releaseContextCache.get(key);
  }
  const promise = (async () => {
    try {
      const album = await getAlbumByMbid(key);
      const primaryArtist = Array.isArray(album?.artists) ? album.artists[0] : null;
      const artistId =
        String(album?.artistId || primaryArtist?.id || "").trim() || null;
      const artistName =
        String(primaryArtist?.name || "").trim() || null;
      const releases = Array.isArray(album?.releases) ? album.releases : [];
      const pickedRelease =
        releases.find((release) => String(release?.status || "").toLowerCase() === "official") ||
        releases.find((release) => Array.isArray(release?.tracks) && release.tracks.length > 0) ||
        releases[0] ||
        null;
      if (!pickedRelease) {
        return {
          albumName: String(album?.title || "").trim() || null,
          artistId,
          artistName,
          releaseYear: getYear(album?.releaseDate),
          albumTrackCount: null,
          albumTrackTitles: [],
          tracks: [],
        };
      }
      const tracks = Array.isArray(pickedRelease?.tracks)
        ? pickedRelease.tracks.map((track) => ({
            title: track.title,
            trackNumber: track.trackPosition || track.trackNumber || null,
            durationMs: track.durationMs || null,
            recordingId: track.recordingId || null,
          }))
        : [];
      return {
        albumName: String(album?.title || "").trim() || null,
        artistId,
        artistName,
        releaseYear: getYear(pickedRelease?.releaseDate) || getYear(album?.releaseDate),
        albumTrackCount: tracks.length > 0 ? tracks.length : null,
        albumTrackTitles: tracks.map((track) => track.title),
        tracks,
      };
    } catch {
      return null;
    }
  })();
  boundedCacheSet(releaseContextCache, key, promise);
  const resolved = await promise;
  boundedCacheSet(releaseContextCache, key, resolved);
  return resolved;
}

async function fetchLastfmTrackInfo(track) {
  const artistName = String(track?.artistName || "").trim();
  const trackName = String(track?.trackName || "").trim();
  if (!artistName || !trackName) return null;
  try {
    return await lastfmRequest("track.getInfo", {
      artist: artistName,
      track: trackName,
      autocorrect: 1,
    });
  } catch {
    return null;
  }
}


export async function resolveWeeklyFlowTrackContext(track) {
  const base = {
    ...track,
    artistName: String(track?.artistName || "").trim(),
    trackName: String(track?.trackName || "").trim(),
    albumName: String(track?.albumName || "").trim() || null,
    artistMbid: String(track?.artistMbid || "").trim() || null,
    albumMbid: String(track?.albumMbid || "").trim() || null,
    trackMbid: String(track?.trackMbid || "").trim() || null,
    releaseYear: getYear(track?.releaseYear) || null,
    durationMs:
      track?.durationMs != null && Number.isFinite(Number(track.durationMs))
        ? Math.max(0, Math.round(Number(track.durationMs)))
        : null,
    artistAliases: Array.isArray(track?.artistAliases)
      ? track.artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
  };
  if (!base.artistName || !base.trackName) {
    return base;
  }

  const lastfmInfo = await fetchLastfmTrackInfo(base);
  const lastfmTrack = lastfmInfo?.track || null;
  const lastfmAlbumName = String(
    lastfmTrack?.album?.title || lastfmTrack?.album?.["#text"] || "",
  ).trim();
  const lastfmTrackMbid = String(lastfmTrack?.mbid || "").trim();
  const lastfmArtistMbid = String(lastfmTrack?.artist?.mbid || "").trim();
  const lastfmDuration =
    lastfmTrack?.duration != null && Number.isFinite(Number(lastfmTrack.duration))
      ? Math.max(0, Math.round(Number(lastfmTrack.duration)))
      : null;

  if (!base.albumName && lastfmAlbumName) {
    base.albumName = lastfmAlbumName;
  }
  if (!base.trackMbid && lastfmTrackMbid) {
    base.trackMbid = lastfmTrackMbid;
  }
  if (!base.artistMbid && lastfmArtistMbid) {
    base.artistMbid = lastfmArtistMbid;
  }

  if (!base.artistMbid) {
    base.artistMbid = await musicbrainzResolveArtistMbidByName(base.artistName);
  }

  let releaseContext = null;
  if (base.albumMbid) {
    releaseContext = await fetchReleaseContext(base.albumMbid);
    if (
      releaseContext?.albumName &&
      base.albumName &&
      !matchesAlbumTitle(releaseContext.albumName, base.albumName)
    ) {
      base.albumMbid = null;
      base.trackMbid = null;
      releaseContext = null;
    }
  }
  if (!base.albumMbid && base.albumName) {
    const releaseGroup = await resolveReleaseGroup(
      base.artistName,
      base.artistMbid,
      base.albumName,
      base.releaseYear,
    );
    if (releaseGroup?.id) {
      base.albumMbid = releaseGroup.id;
      if (!base.artistMbid && releaseGroup.artistMbid) {
        base.artistMbid = releaseGroup.artistMbid;
      }
      if (!base.releaseYear && releaseGroup.releaseYear) {
        base.releaseYear = releaseGroup.releaseYear;
      }
      if (!base.albumName && releaseGroup.title) {
        base.albumName = releaseGroup.title;
      }
    }
  }

  let matchedTrackDurationMs = null;
  if (base.albumMbid) {
    releaseContext ||= await fetchReleaseContext(base.albumMbid);
    if (
      releaseContext?.artistId &&
      artistNamesMatch(base.artistName, releaseContext.artistName)
    ) {
      base.artistMbid = releaseContext.artistId;
    }
    if (releaseContext?.releaseYear && !base.releaseYear) {
      base.releaseYear = releaseContext.releaseYear;
    }
    const matchedTrack = matchTrackByTitle(releaseContext?.tracks, base.trackName);
    if (matchedTrack) {
      if (!base.trackMbid && matchedTrack.recordingId) {
        base.trackMbid = matchedTrack.recordingId;
      }
      matchedTrackDurationMs = matchedTrack.durationMs || null;
      base.trackNumber =
        matchedTrack.trackNumber != null && Number.isFinite(Number(matchedTrack.trackNumber))
          ? Number(matchedTrack.trackNumber)
          : null;
    }
    base.albumTrackCount = releaseContext?.albumTrackCount ?? null;
    base.albumTrackTitles = Array.isArray(releaseContext?.albumTrackTitles)
      ? releaseContext.albumTrackTitles
      : [];
  } else {
    base.albumTrackCount = null;
    base.albumTrackTitles = [];
    base.trackNumber = null;
  }

  base.durationMs = pickResolvedDurationMs({
    playlistDurationMs: base.durationMs,
    lastfmDurationMs: lastfmDuration,
    lastfmAlbumName,
    albumName: base.albumName,
    matchedTrackDurationMs,
  });

  if ((base.artistAliases?.length || 0) === 0 && base.artistMbid) {
    base.artistAliases = await fetchArtistAliases(base.artistMbid);
  }

  return base;
}
