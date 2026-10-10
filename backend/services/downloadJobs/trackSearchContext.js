import {
  lastfmRequest,
  musicbrainzResolveArtistMbidByName,
} from "../apiClients/index.js";
import {
  getArtistByMbid,
  getAlbumByMbid,
  listArtistAlbums,
  resolveAlbumByArtistAndTitle,
  selectAlbumRelease,
} from "../providers/brainzmashProvider.js";
import {
  artistNamesMatch,
  scoreTextMatch as scoreTextMatchBase,
  getYear,
  pickResolvedDurationMs,
} from "../providers/brainzmashRanking.js";
import createCache from "../apiClients/simpleCache.js";

const CONTEXT_CACHE_TTL_SECONDS = 15 * 60;
const MAX_CACHE_ENTRIES = 500;
const artistAliasCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const releaseGroupSearchCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const releaseContextCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const MATCHER_OPTIONS = { extended: true };

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
  const cachedAliases = artistAliasCache.get(key);
  if (cachedAliases !== undefined) return cachedAliases;
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
  artistAliasCache.set(key, promise);
  const aliases = await promise;
  artistAliasCache.set(key, aliases);
  return aliases;
}

async function resolveReleaseGroup(artistName, artistMbid, albumName, releaseYear) {
  const safeAlbum = String(albumName || "").trim();
  if (!safeAlbum) return null;
  const safeArtist = String(artistName || "").trim();
  const safeMbid = String(artistMbid || "").trim();
  const cacheKey = JSON.stringify([safeArtist, safeMbid, safeAlbum]);
  const cachedReleaseGroup = releaseGroupSearchCache.get(cacheKey);
  if (cachedReleaseGroup !== undefined) return cachedReleaseGroup;
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
  releaseGroupSearchCache.set(cacheKey, promise);
  const resolved = await promise;
  releaseGroupSearchCache.set(cacheKey, resolved);
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

export function matchTrackByTitle(tracks, trackName, trackNumber = null, discNumber = null) {
  const safeTrackName = String(trackName || "").trim();
  if (!safeTrackName) return null;
  const expectedTrackNumber = Number(trackNumber);
  const expectedDiscNumber = Number(discNumber) > 0 ? Number(discNumber) : 1;
  const positionMatch = (track) =>
    (Number(track.trackNumber) === expectedTrackNumber ? 2 : 0)
    + (Number(track.discNumber || 1) === expectedDiscNumber ? 1 : 0);
  const best =
    [...(Array.isArray(tracks) ? tracks : [])]
      .map((track) => ({
        ...track,
        _score: scoreTextMatchBase(track?.title, safeTrackName, MATCHER_OPTIONS),
      }))
      .sort((left, right) => {
        const scoreDifference = right._score - left._score;
        if (scoreDifference !== 0) return scoreDifference;
        if (!Number.isFinite(expectedTrackNumber) || expectedTrackNumber <= 0) return 0;
        return positionMatch(right) - positionMatch(left);
      })[0] || null;
  if (!best || best._score < 82) return null;
  return best;
}

function applyReleaseContext(base, releaseContext) {
  if (
    releaseContext?.artistId &&
    artistNamesMatch(base.artistName, releaseContext.artistName)
  ) {
    base.artistMbid = releaseContext.artistId;
  }
  if (releaseContext?.releaseYear && !base.releaseYear) {
    base.releaseYear = releaseContext.releaseYear;
  }
  const titleMatchedTrack = matchTrackByTitle(
    releaseContext?.tracks,
    base.trackName,
    base.trackNumber,
    base.discNumber,
  );
  const existingTrackMbid = String(base.trackMbid || "").trim().toLowerCase();
  let identityMatchedTrack = null;
  if (existingTrackMbid) {
    identityMatchedTrack = matchTrackByTitle(
      releaseContext?.identityTracks?.filter(
        (track) => String(track?.recordingId || "").trim().toLowerCase() === existingTrackMbid,
      ),
      base.trackName,
      base.trackNumber,
      base.discNumber,
    );
    if (!identityMatchedTrack) {
      identityMatchedTrack = matchTrackByTitle(
        releaseContext?.identityTracks?.filter(
          (track) => String(track?.id || "").trim().toLowerCase() === existingTrackMbid,
        ),
        base.trackName,
        base.trackNumber,
        base.discNumber,
      );
    }
  }
  const matchedTrack = identityMatchedTrack || titleMatchedTrack;
  if (identityMatchedTrack?.recordingId) {
    // Preserve a recording already present on any edition, or translate a
    // stored release-track ID through the exact edition that contains it.
    base.trackMbid = identityMatchedTrack.recordingId;
  } else if (!existingTrackMbid && titleMatchedTrack?.recordingId) {
    base.trackMbid = titleMatchedTrack.recordingId;
  } else {
    // Do not carry an unverified legacy ID into recording-ID validation.
    base.trackMbid = null;
  }
  if (matchedTrack) {
    base.trackNumber =
      matchedTrack.trackNumber != null && Number.isFinite(Number(matchedTrack.trackNumber))
        ? Number(matchedTrack.trackNumber)
        : null;
    base.discNumber = base.trackNumber ? matchedTrack.discNumber || null : null;
  }
  base.albumTrackCount = matchedTrack?.releaseTrackCount ?? releaseContext?.albumTrackCount ?? null;
  base.albumTrackTitles = Array.isArray(matchedTrack?.releaseTrackTitles)
    ? matchedTrack.releaseTrackTitles
    : Array.isArray(releaseContext?.albumTrackTitles)
      ? releaseContext.albumTrackTitles
      : [];
  return matchedTrack;
}

function mapReleaseContextTracks(release) {
  const source = Array.isArray(release?.tracks) ? release.tracks : [];
  const releaseTrackTitles = source.map((track) => track.title).filter(Boolean);
  return source.map((track) => ({
    id: track.id || null,
    title: track.title,
    trackNumber: track.trackPosition || track.trackNumber || null,
    discNumber: track.mediumNumber || null,
    durationMs: track.durationMs || null,
    recordingId: track.recordingId || null,
    releaseTrackCount: source.length || null,
    releaseTrackTitles,
  }));
}

async function fetchReleaseContext(albumMbid) {
  const key = String(albumMbid || "").trim();
  if (!key) return null;
  const cachedContext = releaseContextCache.get(key);
  if (cachedContext !== undefined) return cachedContext;
  const promise = (async () => {
    try {
      const album = await getAlbumByMbid(key);
      const primaryArtist = Array.isArray(album?.artists) ? album.artists[0] : null;
      const artistId =
        String(album?.artistId || primaryArtist?.id || "").trim() || null;
      const artistName =
        String(primaryArtist?.name || "").trim() || null;
      const pickedRelease = selectAlbumRelease(album);
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
      const tracks = mapReleaseContextTracks(pickedRelease);
      const identityTracks = (Array.isArray(album?.releases) ? album.releases : [])
        .flatMap(mapReleaseContextTracks);
      return {
        albumName: String(album?.title || "").trim() || null,
        artistId,
        artistName,
        releaseYear: getYear(pickedRelease?.releaseDate) || getYear(album?.releaseDate),
        albumTrackCount: tracks.length > 0 ? tracks.length : null,
        albumTrackTitles: tracks.map((track) => track.title),
        tracks,
        identityTracks,
      };
    } catch {
      return null;
    }
  })();
  releaseContextCache.set(key, promise);
  const resolved = await promise;
  releaseContextCache.set(key, resolved);
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


// A complete release identity can skip Last.fm and release discovery. Its
// recording ID is still checked against the cached BrainzMash tracklist so
// jobs created before that rule can be repaired safely.
function hasReleaseIdentity(track) {
  return Boolean(track.trackMbid && track.albumMbid)
    && track.durationMs > 0
    && Number(track.trackNumber) > 0
    && Array.isArray(track.albumTrackTitles)
    && track.albumTrackTitles.length > 0;
}

export async function resolveTrackSearchContext(track) {
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
  if (hasReleaseIdentity(base)) {
    const releaseContext = await fetchReleaseContext(base.albumMbid);
    if (
      releaseContext?.albumName &&
      base.albumName &&
      !matchesAlbumTitle(releaseContext.albumName, base.albumName)
    ) {
      base.albumMbid = null;
      base.trackMbid = null;
    } else if (releaseContext) {
      const matchedTrack = applyReleaseContext(base, releaseContext);
      if (matchedTrack?.durationMs) base.durationMs = matchedTrack.durationMs;
      if (base.artistAliases.length === 0 && base.artistMbid) {
        base.artistAliases = await fetchArtistAliases(base.artistMbid);
      }
      return base;
    } else {
      // The ID cannot be proven to be a recording while metadata is
      // unavailable. Title, artist, album, and duration checks still apply.
      base.trackMbid = null;
      if (base.artistAliases.length === 0 && base.artistMbid) {
        base.artistAliases = await fetchArtistAliases(base.artistMbid);
      }
      return base;
    }
  }

  const lastfmInfo = await fetchLastfmTrackInfo(base);
  const lastfmTrack = lastfmInfo?.track || null;
  const lastfmAlbumName = String(
    lastfmTrack?.album?.title || lastfmTrack?.album?.["#text"] || "",
  ).trim();
  const lastfmArtistMbid = String(lastfmTrack?.artist?.mbid || "").trim();
  const lastfmDuration =
    lastfmTrack?.duration != null && Number.isFinite(Number(lastfmTrack.duration))
      ? Math.max(0, Math.round(Number(lastfmTrack.duration)))
      : null;

  if (!base.albumName && lastfmAlbumName) {
    base.albumName = lastfmAlbumName;
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
    const matchedTrack = applyReleaseContext(base, releaseContext);
    if (matchedTrack) {
      matchedTrackDurationMs = matchedTrack.durationMs || null;
    }
  } else {
    base.albumTrackCount = null;
    base.albumTrackTitles = [];
    base.trackNumber = null;
    base.discNumber = null;
  }

  base.durationMs = pickResolvedDurationMs({
    playlistDurationMs: base.durationMs,
    lastfmDurationMs: lastfmDuration,
    matchedTrackDurationMs,
  });

  if ((base.artistAliases?.length || 0) === 0 && base.artistMbid) {
    base.artistAliases = await fetchArtistAliases(base.artistMbid);
  }

  return base;
}
