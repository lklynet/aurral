import { getNormalizedText } from "./brainzmashRanking.js";

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeType(value) {
  const normalized = normalizeString(value);
  if (normalized === "Album" || normalized === "EP" || normalized === "Single") {
    return normalized;
  }
  return normalized || "Album";
}

function normalizeImageKind(value) {
  const normalized = normalizeString(value);
  return normalized || "Cover";
}

export function toNormalizedArtistImage(image) {
  const url = normalizeString(image?.Url || image?.url);
  if (!url) return null;
  return {
    kind: normalizeImageKind(image?.CoverType || image?.kind),
    url,
  };
}

export function toNormalizedArtistLink(link) {
  const target = normalizeString(link?.target || link?.url);
  if (!target) return null;
  return {
    type: normalizeString(link?.type) || "external",
    target,
  };
}

export function toNormalizedArtist(raw) {
  const images = normalizeArray(raw?.images)
    .map(toNormalizedArtistImage)
    .filter(Boolean);
  const links = normalizeArray(raw?.links)
    .map(toNormalizedArtistLink)
    .filter(Boolean);
  return {
    id: normalizeString(raw?.id),
    name: normalizeString(raw?.artistname || raw?.name),
    sortName:
      normalizeString(raw?.sortname || raw?.sortName || raw?.artistname || raw?.name),
    type: normalizeString(raw?.type) || null,
    status: normalizeString(raw?.status) || null,
    disambiguation: normalizeString(raw?.disambiguation) || "",
    overview: normalizeString(raw?.overview) || "",
    genres: normalizeArray(raw?.genres)
      .map((genre) => normalizeString(genre))
      .filter(Boolean),
    aliases: normalizeArray(raw?.artistaliases)
      .map((alias) => normalizeString(alias))
      .filter(Boolean),
    images,
    links,
    rating:
      raw?.rating && raw.rating.Value != null
        ? {
            count: Number.parseInt(raw.rating.Count, 10) || 0,
            value:
              raw.rating.Value != null && Number.isFinite(Number(raw.rating.Value))
                ? Number(raw.rating.Value)
                : null,
          }
        : null,
  };
}

export function toNormalizedTrack(raw) {
  return {
    id: normalizeString(raw?.id),
    recordingId: normalizeString(raw?.recordingid || raw?.recordingId || raw?.id),
    title: normalizeString(raw?.trackname || raw?.title),
    trackNumber:
      raw?.trackposition != null && Number.isFinite(Number(raw.trackposition))
        ? Number(raw.trackposition)
        : raw?.trackNumber != null && Number.isFinite(Number(raw.trackNumber))
          ? Number(raw.trackNumber)
          : null,
    trackPosition:
      raw?.trackposition != null && Number.isFinite(Number(raw.trackposition))
        ? Number(raw.trackposition)
        : null,
    mediumNumber:
      raw?.mediumnumber != null && Number.isFinite(Number(raw.mediumnumber))
        ? Number(raw.mediumnumber)
        : null,
    durationMs:
      raw?.durationms != null && Number.isFinite(Number(raw.durationms))
        ? Number(raw.durationms)
        : null,
    artistId: normalizeString(raw?.artistid) || null,
  };
}

export function toNormalizedRelease(raw) {
  const tracks = normalizeArray(raw?.tracks).map(toNormalizedTrack).filter(Boolean);
  return {
    id: normalizeString(raw?.id),
    title: normalizeString(raw?.title),
    status: normalizeString(raw?.status) || null,
    country: normalizeArray(raw?.country)
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
    label: normalizeArray(raw?.label)
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
    media: normalizeArray(raw?.media).map((entry) => ({
      format: normalizeString(entry?.Format || entry?.format),
      name: normalizeString(entry?.Name || entry?.name),
      position:
        entry?.Position != null && Number.isFinite(Number(entry.Position))
          ? Number(entry.Position)
          : null,
    })),
    trackCount:
      raw?.track_count != null && Number.isFinite(Number(raw.track_count))
        ? Number(raw.track_count)
        : tracks.length,
    tracks,
    releaseDate: normalizeString(raw?.releasedate || raw?.releaseDate) || null,
    disambiguation: normalizeString(raw?.disambiguation) || "",
  };
}

export function toNormalizedAlbum(raw) {
  const artists = normalizeArray(raw?.artists)
    .map(toNormalizedArtist)
    .filter((artist) => artist?.id);
  const images = normalizeArray(raw?.images)
    .map(toNormalizedArtistImage)
    .filter(Boolean);
  const links = normalizeArray(raw?.links)
    .map(toNormalizedArtistLink)
    .filter(Boolean);
  const releases = normalizeArray(raw?.releases)
    .map(toNormalizedRelease)
    .filter((release) => release?.id);
  return {
    id: normalizeString(raw?.id),
    title: normalizeString(raw?.title),
    artistId: normalizeString(raw?.artistid) || artists[0]?.id || null,
    artists,
    type: normalizeType(raw?.type),
    secondaryTypes: normalizeArray(raw?.secondarytypes)
      .map((value) => normalizeString(value))
      .filter(Boolean),
    releaseDate: normalizeString(raw?.releasedate) || null,
    genres: normalizeArray(raw?.genres)
      .map((value) => normalizeString(value))
      .filter(Boolean),
    aliases: normalizeArray(raw?.aliases)
      .map((value) => normalizeString(value))
      .filter(Boolean),
    overview: normalizeString(raw?.overview) || "",
    images,
    links,
    releases,
    rating:
      raw?.rating && raw.rating.Value != null
        ? {
            count: Number.parseInt(raw.rating.Count, 10) || 0,
            value:
              raw.rating.Value != null && Number.isFinite(Number(raw.rating.Value))
                ? Number(raw.rating.Value)
                : null,
          }
        : null,
  };
}

export function toNormalizedArtistAlbum(raw) {
  return {
    id: normalizeString(raw?.Id || raw?.id),
    title: normalizeString(raw?.Title || raw?.title),
    type: normalizeType(raw?.Type || raw?.type),
    secondaryTypes: normalizeArray(raw?.SecondaryTypes || raw?.secondaryTypes)
      .map((value) => normalizeString(value))
      .filter(Boolean),
    releaseStatuses: normalizeArray(raw?.ReleaseStatuses || raw?.releaseStatuses)
      .map((value) => normalizeString(value))
      .filter(Boolean),
    firstReleaseDate:
      normalizeString(
        raw?.FirstReleaseDate ||
          raw?.firstReleaseDate ||
          raw?.ReleaseDate ||
          raw?.releaseDate ||
          raw?.releasedate,
      ) || null,
    coverImages: normalizeArray(raw?.images).map(toNormalizedArtistImage).filter(Boolean),
    rating: null,
  };
}

export function toLegacyArtist(normalizedArtist) {
  return {
    id: normalizedArtist.id,
    name: normalizedArtist.name,
    "sort-name": normalizedArtist.sortName,
    type: normalizedArtist.type,
    status: normalizedArtist.status,
    disambiguation: normalizedArtist.disambiguation || "",
    genres: normalizedArtist.genres,
    aliases: normalizedArtist.aliases.map((name) => ({ name })),
    relations: normalizedArtist.links.map((link) => ({
      type: link.type,
      url: { resource: link.target },
    })),
    overview: normalizedArtist.overview,
  };
}

export function toLegacyReleaseGroupSummary(
  album,
  artist = null,
  { score = 0 } = {},
) {
  const artistName = artist?.name || album?.artistName || "";
  const artistId = artist?.id || album?.artistId || null;
  return {
    id: album.id,
    title: album.title,
    "primary-type": album.type || "Album",
    "secondary-types": album.secondaryTypes || [],
    "first-release-date": album.releaseDate || album.firstReleaseDate || null,
    rating: album.rating || null,
    score,
    "artist-credit": artistName
      ? [
          {
            name: artistName,
            artist: artistId ? { id: artistId, name: artistName } : { name: artistName },
          },
        ]
      : [],
    releases: normalizeArray(album.releases).map((release) => ({
      id: release.id,
      status: release.status || null,
      date: release.releaseDate || null,
      title: release.title || album.title,
    })),
  };
}

export function toLegacyRelease(release) {
  return {
    id: release.id,
    title: release.title,
    status: release.status,
    date: release.releaseDate,
    media: normalizeArray(release.media).map((medium) => ({
      format: medium.format,
      name: medium.name,
      position: medium.position,
      tracks: normalizeArray(release.tracks)
        .filter(
          (track) =>
            medium.position == null ||
            track.mediumNumber == null ||
            track.mediumNumber === medium.position,
        )
        .map((track) => ({
          id: track.id,
          title: track.title,
          length: track.durationMs,
          position: track.trackPosition || track.trackNumber || 0,
          number:
            track.trackNumber != null ? String(track.trackNumber) : null,
          recording: {
            id: track.recordingId || track.id,
            title: track.title,
            length: track.durationMs,
          },
        })),
    })),
  };
}

export function toLegacySearchArtistResult(normalizedArtist, score = 0) {
  return {
    id: normalizedArtist.id,
    name: normalizedArtist.name,
    "sort-name": normalizedArtist.sortName,
    type: normalizedArtist.type,
    disambiguation: normalizedArtist.disambiguation || "",
    genres: normalizedArtist.genres,
    score,
  };
}

export function toLegacySearchAlbumResult(item) {
  const normalizedArtistName = normalizeString(item?.artistName) || "Unknown Artist";
  return {
    id: item.id,
    title: item.title,
    "primary-type": item.type || "Album",
    "secondary-types": item.secondaryTypes || [],
    "first-release-date": item.releaseDate || null,
    score: Number(item?.score || 0),
    "artist-credit": normalizedArtistName
      ? [
          {
            name: normalizedArtistName,
            artist: item?.artistId
              ? { id: item.artistId, name: normalizedArtistName }
              : { name: normalizedArtistName },
          },
        ]
      : [],
  };
}

export function matchesGenreQuery(artist, query) {
  const normalizedQuery = getNormalizedText(query);
  if (!normalizedQuery) return false;
  return normalizeArray(artist?.genres).some((genre) =>
    getNormalizedText(genre).includes(normalizedQuery),
  );
}
