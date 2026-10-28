import { lastfmRequest } from "../apiClients/index.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import {
  getArtistByMbid,
  getAlbumByMbid,
  isCreditedArtist,
  isMetadataNotFoundError,
  listArtistAlbums,
  resolveAlbumByArtistAndTitle,
  selectAlbumRelease,
} from "../providers/brainzmashProvider.ts";
import {
  scoreTextMatch as scoreTextMatchBase,
  getYear,
  pickResolvedDurationMs,
} from "../providers/brainzmashRanking.ts";
import createCache from "../apiClients/simpleCache.ts";
import { sameVersion, trackRequestFor } from "../releaseManifest.ts";
import { resolveReleaseManifest } from "../releaseResolver.ts";
import type { DownloadTrackFields } from "../downloadUtils.ts";
import type { NormalizedAlbum, NormalizedRelease } from "../providers/brainzmashMappers.ts";

type ResolvedTrack = DownloadTrackFields & {
  artistName: string;
  trackName: string;
  albumName: string | null;
  artistMbid: string | null;
  albumMbid: string | null;
  trackMbid: string | null;
  releaseMbid: string | null;
  recordingMbidAliases: string[];
  releaseYear: string | null;
  durationMs: number | null;
  artistAliases: string[];
  metadataUnreachable?: boolean;
};

type ReleaseContextTrack = ReturnType<typeof mapReleaseContextTracks>[number];
type ReleaseContextMatch = ReturnType<typeof matchTrackByTitle<ReleaseContextTrack>>;
type ReleaseContext = {
  albumName: string | null;
  artists: NormalizedAlbum["artists"];
  releaseYear: string | null;
  albumTrackCount: number | null;
  albumTrackTitles: string[];
  tracks: ReleaseContextTrack[];
  identityTracks?: ReleaseContextTrack[];
  releaseIds: string[];
  unknown?: undefined;
};
type UnknownAlbum = { unknown: true } & {
  [Key in Exclude<keyof ReleaseContext, "unknown">]?: undefined;
};

type RankableRelease = Awaited<ReturnType<typeof listArtistAlbums>>[number];

type MatchableTrack = {
  title?: string | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  recordingId?: string | null;
};

const CONTEXT_CACHE_TTL_SECONDS = 15 * 60;
const MAX_CACHE_ENTRIES = 500;
const artistAliasCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const releaseGroupSearchCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const releaseContextCache = createCache(CONTEXT_CACHE_TTL_SECONDS, MAX_CACHE_ENTRIES);
const MATCHER_OPTIONS = { extended: true };

function rankCandidates<T extends RankableRelease>(
  candidates: T[],
  expectedTitle: string,
  expectedYear: string | number | null = null,
) {
  const list = Array.isArray(candidates) ? candidates : [];
  const targetYear = getYear(expectedYear);
  return [...list]
    .map((candidate) => {
      const title = candidate?.title || "";
      const year = candidate?.firstReleaseDate || null;
      const titleScore = scoreTextMatchBase(title, expectedTitle, MATCHER_OPTIONS);
      const yearScore =
        targetYear && getYear(year) === targetYear ? 10 : targetYear && getYear(year) ? -5 : 0;
      return {
        candidate,
        score: titleScore + yearScore,
      };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ candidate }) => candidate);
}

function matchesAlbumTitle(
  actualTitle: string | null | undefined,
  expectedTitle: string | null | undefined,
) {
  return (
    !actualTitle ||
    !expectedTitle ||
    scoreTextMatchBase(actualTitle, expectedTitle, MATCHER_OPTIONS) >= 85
  );
}

async function fetchArtistAliases(artistMbid: string | null | undefined) {
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

// A release group is a track's when one of its releases lists the track. One
// the provider has no tracklist for, as for many singles, is the track's when
// it has the track's title. Null means metadata could not be read.
async function holdsTrack(albumMbid: string, track: DownloadTrackFields) {
  const context = await fetchReleaseContext(albumMbid);
  if (!context) return null;
  if (context.unknown) return false;
  if (!context.identityTracks?.length) {
    return scoreTextMatchBase(context.albumName, track.trackName, MATCHER_OPTIONS) >= 85;
  }
  return Boolean(
    matchTrackByTitle(context.identityTracks, track.trackName, track.trackNumber, track.discNumber),
  );
}

const UNREACHABLE = Object.freeze({ unreachable: true });

// A guessed release group must list the track, so a search that finds an
// album of the same name, such as another of an artist's self-titled albums,
// is not the track's. A search metadata could not answer is not remembered.
async function resolveReleaseGroup(track: DownloadTrackFields) {
  const safeAlbum = String(track.albumName || "").trim();
  if (!safeAlbum) return null;
  const safeArtist = String(track.artistName || "").trim();
  const safeMbid = String(track.artistMbid || "").trim();
  const cacheKey = JSON.stringify([safeArtist, safeMbid, safeAlbum, track.trackName]);
  const cachedReleaseGroup = releaseGroupSearchCache.get(cacheKey);
  if (cachedReleaseGroup !== undefined) return cachedReleaseGroup;
  let unreachable = false;
  const holds = async (albumMbid: string) => {
    const held = await holdsTrack(albumMbid, track);
    if (held === null) unreachable = true;
    return held === true;
  };
  const noteFailure = (error: unknown) => {
    if (!isMetadataNotFoundError(error)) unreachable = true;
  };
  const promise = (async () => {
    try {
      const resolvedId = await resolveAlbumByArtistAndTitle({
        artistName: safeArtist,
        artistMbid: safeMbid,
        albumTitle: safeAlbum,
        releaseYear: track.releaseYear,
        holds,
      });
      if (resolvedId) {
        const album = await getAlbumByMbid(resolvedId).catch(() => null);
        return {
          id: String(resolvedId),
          title: String(album?.title || safeAlbum).trim() || safeAlbum,
          releaseYear: getYear(album?.releaseDate),
        };
      }
    } catch (error) {
      noteFailure(error);
    }
    try {
      const candidates = safeMbid ? await listArtistAlbums(safeMbid) : [];
      for (const best of rankCandidates(candidates, safeAlbum, track.releaseYear)) {
        const id = best?.id;
        if (!id || !matchesAlbumTitle(best?.title, safeAlbum)) continue;
        if (!(await holds(id))) continue;
        return {
          id: String(id),
          title: String(best?.title || safeAlbum).trim() || safeAlbum,
          releaseYear: getYear(best?.firstReleaseDate),
        };
      }
    } catch (error) {
      noteFailure(error);
    }
    return unreachable ? UNREACHABLE : null;
  })();
  releaseGroupSearchCache.set(cacheKey, promise);
  const resolved = await promise;
  if (resolved === UNREACHABLE) releaseGroupSearchCache.delete(cacheKey);
  else releaseGroupSearchCache.set(cacheKey, resolved);
  return resolved;
}

type RawReleaseData =
  | {
      media?: {
        tracks?: {
          title?: string;
          name?: string;
          position?: number;
          length?: number;
          recording?: { id?: string; title?: string; length?: number };
        }[];
      }[];
    }
  | null
  | undefined;

function _flattenReleaseTracks(releaseData: RawReleaseData) {
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

export function matchTrackByTitle<T extends MatchableTrack>(
  tracks: T[] | null | undefined,
  trackName: string | null | undefined,
  trackNumber: number | null = null,
  discNumber: number | null = null,
) {
  const safeTrackName = String(trackName || "").trim();
  if (!safeTrackName) return null;
  const expectedTrackNumber = Number(trackNumber);
  const expectedDiscNumber = Number(discNumber) > 0 ? Number(discNumber) : 1;
  const positionMatch = (track: T) =>
    (Number(track.trackNumber) === expectedTrackNumber ? 2 : 0) +
    (Number(track.discNumber || 1) === expectedDiscNumber ? 1 : 0);
  const best =
    [...(Array.isArray(tracks) ? tracks : [])]
      .filter((track) => sameVersion(track?.title, safeTrackName))
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

function applyReleaseContext(base: ResolvedTrack, releaseContext: ReleaseContext | null) {
  const existingArtistMbid = String(base.artistMbid || "")
    .trim()
    .toLowerCase();
  const creditedArtist =
    releaseContext?.artists?.find(
      (artist) => artist?.id && String(artist.id).trim().toLowerCase() === existingArtistMbid,
    ) ||
    releaseContext?.artists?.find(
      (artist) => artist?.id && isCreditedArtist(base.artistName, artist),
    );
  if (creditedArtist) {
    base.artistMbid = creditedArtist.id;
  }
  if (releaseContext?.releaseYear && !base.releaseYear) {
    base.releaseYear = releaseContext.releaseYear;
  }
  const titleMatchedTrack = [
    releaseContext?.tracks,
    releaseContext?.identityTracks,
  ].reduce<ReleaseContextMatch>(
    (found, tracks) =>
      found || matchTrackByTitle(tracks, base.trackName, base.trackNumber, base.discNumber),
    null,
  );
  const existingTrackMbid = String(base.trackMbid || "")
    .trim()
    .toLowerCase();
  let identityMatchedTrack = null;
  if (existingTrackMbid) {
    identityMatchedTrack = matchTrackByTitle(
      releaseContext?.identityTracks?.filter((track) =>
        [track?.recordingId, ...(track?.recordingAliases || [])].some(
          (id) =>
            String(id || "")
              .trim()
              .toLowerCase() === existingTrackMbid,
        ),
      ),
      base.trackName,
      base.trackNumber,
      base.discNumber,
    );
    if (!identityMatchedTrack) {
      identityMatchedTrack = matchTrackByTitle(
        releaseContext?.identityTracks?.filter(
          (track) =>
            String(track?.id || "")
              .trim()
              .toLowerCase() === existingTrackMbid,
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
  base.recordingMbidAliases = mergedRecordingIds(releaseContext, base.trackMbid);
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

// Files tagged before MusicBrainz merged a recording carry the old ID, on
// whichever release of the group listed it.
function mergedRecordingIds(releaseContext: ReleaseContext | null, recordingMbid: string | null) {
  const current = String(recordingMbid || "")
    .trim()
    .toLowerCase();
  if (!current) return [];
  const merged = (releaseContext?.identityTracks || [])
    .filter(
      (track) =>
        String(track?.recordingId || "")
          .trim()
          .toLowerCase() === current,
    )
    .flatMap((track) => track.recordingAliases || []);
  return [
    ...new Set(
      merged
        .map((entry) =>
          String(entry || "")
            .trim()
            .toLowerCase(),
        )
        .filter((entry) => entry && entry !== current),
    ),
  ];
}

function mapReleaseContextTracks(release: Pick<NormalizedRelease, "tracks"> | null | undefined) {
  const source = Array.isArray(release?.tracks) ? release.tracks : [];
  const releaseTrackTitles = source.map((track) => track.title).filter(Boolean);
  return source.map((track) => ({
    id: track.id || null,
    title: track.title,
    trackNumber: track.trackPosition || track.trackNumber || null,
    discNumber: track.mediumNumber || null,
    durationMs: track.durationMs || null,
    recordingId: track.recordingId || null,
    recordingAliases: track.oldRecordingIds || [],
    releaseTrackCount: source.length || null,
    releaseTrackTitles,
  }));
}

const UNKNOWN_ALBUM = Object.freeze({ unknown: true });

async function fetchReleaseContext(
  albumMbid: string | null | undefined,
): Promise<ReleaseContext | UnknownAlbum | null> {
  const key = String(albumMbid || "").trim();
  if (!key) return null;
  const cachedContext = releaseContextCache.get(key);
  if (cachedContext !== undefined) return cachedContext;
  const promise = (async () => {
    try {
      const album = await getAlbumByMbid(key);
      const artists = (Array.isArray(album?.artists) ? album.artists : []).toSorted(
        (left, right) => Number(right.id === album.artistId) - Number(left.id === album.artistId),
      );
      const pickedRelease = selectAlbumRelease(album);
      if (!pickedRelease) {
        return {
          albumName: String(album?.title || "").trim() || null,
          artists,
          releaseYear: getYear(album?.releaseDate),
          albumTrackCount: null,
          albumTrackTitles: [],
          tracks: [],
          releaseIds: [],
        };
      }
      const tracks = mapReleaseContextTracks(pickedRelease);
      const identityTracks = (Array.isArray(album?.releases) ? album.releases : []).flatMap(
        mapReleaseContextTracks,
      );
      return {
        albumName: String(album?.title || "").trim() || null,
        artists,
        releaseYear: getYear(pickedRelease?.releaseDate) || getYear(album?.releaseDate),
        albumTrackCount: tracks.length > 0 ? tracks.length : null,
        albumTrackTitles: tracks.map((track) => track.title),
        tracks,
        identityTracks,
        releaseIds: album.releases.map((release) => release.id),
      };
    } catch (error) {
      return isMetadataNotFoundError(error) ? UNKNOWN_ALBUM : null;
    }
  })();
  releaseContextCache.set(key, promise);
  const resolved = await promise;
  if (resolved) releaseContextCache.set(key, resolved);
  else releaseContextCache.delete(key);
  return resolved;
}

async function fetchLastfmTrackInfo(track: DownloadTrackFields) {
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

// The edition the job asks for decides its place, length, and the album's
// whole tracklist, so they all describe one release.
async function applyReleaseManifest(
  base: ResolvedTrack,
  { guessedRecording = false }: { guessedRecording?: boolean } = {},
) {
  // A recording matched only by title may come from another edition, and
  // would keep the job off the edition it asks for.
  const job = guessedRecording ? { ...base, trackMbid: null, recordingMbidAliases: [] } : base;
  const manifest = await resolveReleaseManifest(job);
  if (!manifest) return null;
  const request = trackRequestFor(job, manifest)!;
  base.releaseMbid = manifest.releaseMbid;
  base.trackMbid = request.trackMbid;
  base.recordingMbidAliases = request.recordingMbidAliases;
  base.trackNumber = request.trackNumber;
  base.discNumber = request.discNumber;
  base.albumTrackCount = request.albumTrackCount;
  base.albumTrackTitles = request.albumTrackTitles;
  return request;
}

// A complete release identity can skip Last.fm and release discovery. Its
// recording ID is still checked against the cached BrainzMash tracklist so
// jobs created before that rule can be repaired safely.
function hasReleaseIdentity(track: ResolvedTrack) {
  return (
    Boolean(track.trackMbid && track.albumMbid) &&
    (track.durationMs ?? 0) > 0 &&
    Number(track.trackNumber) > 0 &&
    Array.isArray(track.albumTrackTitles) &&
    track.albumTrackTitles.length > 0
  );
}

// `metadataUnreachable` says the album named by the track could not be read
// because metadata was unreachable, so the result is not the album's.
export async function resolveTrackSearchContext(
  track: DownloadTrackFields,
): Promise<ResolvedTrack> {
  const base: ResolvedTrack = {
    ...track,
    artistName: String(track?.artistName || "").trim(),
    trackName: String(track?.trackName || "").trim(),
    albumName: String(track?.albumName || "").trim() || null,
    artistMbid: String(track?.artistMbid || "").trim() || null,
    albumMbid: String(track?.albumMbid || "").trim() || null,
    trackMbid: String(track?.trackMbid || "").trim() || null,
    releaseMbid: String(track?.releaseMbid || "").trim() || null,
    recordingMbidAliases: [],
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
  const namesAlbum = Boolean(base.albumMbid || base.albumName || base.releaseMbid);
  let unreachable = false;

  let releaseContext: ReleaseContext | UnknownAlbum | null = null;
  if (base.albumMbid) {
    releaseContext = await fetchReleaseContext(base.albumMbid);
    unreachable = !releaseContext;
    const otherAlbum =
      releaseContext?.albumName &&
      base.albumName &&
      !matchesAlbumTitle(releaseContext.albumName, base.albumName);
    const credited = releaseContext?.artists?.some(
      (artist) =>
        (base.artistMbid &&
          String(artist?.id || "").toLowerCase() === base.artistMbid.toLowerCase()) ||
        isCreditedArtist(base.artistName, artist),
    );
    if (
      releaseContext?.unknown ||
      otherAlbum ||
      (releaseContext && (!credited || !(await holdsTrack(base.albumMbid, base))))
    ) {
      base.albumMbid = null;
      base.releaseMbid = null;
      base.trackMbid = null;
      base.albumTrackTitles = [];
      releaseContext = null;
    }
  }

  if (hasReleaseIdentity(base)) {
    if (releaseContext) {
      const matchedTrack = applyReleaseContext(base, releaseContext);
      const releaseTrack = await applyReleaseManifest(base);
      const durationMs = releaseTrack?.durationMs || matchedTrack?.durationMs;
      if (durationMs) base.durationMs = durationMs;
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
      return unreachable ? { ...base, metadataUnreachable: true } : base;
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
    base.artistMbid = await guessArtistMbid(base.artistName, { album: base.albumName });
  }

  if (!base.albumMbid && base.albumName) {
    const releaseGroup = await resolveReleaseGroup(base);
    unreachable ||= releaseGroup === UNREACHABLE;
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
    if (releaseContext?.unknown) releaseContext = null;
    const guessedRecording = !base.trackMbid;
    const matchedTrack = applyReleaseContext(base, releaseContext);
    const releaseTrack = await applyReleaseManifest(base, { guessedRecording });
    const pin = String(base.releaseMbid || "").toLowerCase();
    if (
      !releaseTrack &&
      releaseContext?.releaseIds &&
      !releaseContext.releaseIds.some((id) => String(id).toLowerCase() === pin)
    ) {
      base.releaseMbid = null;
    }
    matchedTrackDurationMs = releaseTrack?.durationMs || matchedTrack?.durationMs || null;
  } else if (!unreachable) {
    base.releaseMbid = null;
  }
  if (!base.albumMbid && !base.albumTrackTitles?.length) {
    // A tracklist the job brought from the Library still describes its album.
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

  return namesAlbum && unreachable ? { ...base, metadataUnreachable: true } : base;
}
