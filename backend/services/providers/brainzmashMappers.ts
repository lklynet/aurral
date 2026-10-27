import { isOwnKey } from "../../../lib/ownKey.ts";
interface RawImage {
  Url?: unknown;
  url?: unknown;
  CoverType?: unknown;
  kind?: unknown;
}

interface RawLink {
  target?: unknown;
  type?: unknown;
  url?: { resource?: unknown };
}

interface RawRating {
  Count?: unknown;
  Value?: unknown;
}

interface RawArtist {
  id?: unknown;
  artistname?: unknown;
  name?: unknown;
  sortname?: unknown;
  sortName?: unknown;
  type?: unknown;
  status?: unknown;
  disambiguation?: unknown;
  overview?: unknown;
  genres?: unknown;
  artistaliases?: unknown;
  images?: unknown;
  links?: unknown;
  rating?: RawRating | null;
}

interface RawTrack {
  id?: unknown;
  recordingid?: unknown;
  recordingId?: unknown;
  oldrecordingids?: unknown;
  trackname?: unknown;
  title?: unknown;
  trackposition?: unknown;
  trackNumber?: unknown;
  mediumnumber?: unknown;
  durationms?: unknown;
  artistid?: unknown;
}

interface RawRelease {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  country?: unknown;
  label?: unknown;
  media?: unknown;
  tracks?: unknown;
  track_count?: unknown;
  releasedate?: unknown;
  releaseDate?: unknown;
  disambiguation?: unknown;
}

interface RawAlbum {
  id?: unknown;
  title?: unknown;
  artistid?: unknown;
  artists?: unknown;
  type?: unknown;
  secondarytypes?: unknown;
  releasedate?: unknown;
  genres?: unknown;
  aliases?: unknown;
  overview?: unknown;
  images?: unknown;
  links?: unknown;
  releases?: unknown;
  rating?: RawRating | null;
}

interface RawArtistAlbum {
  Id?: unknown;
  id?: unknown;
  Title?: unknown;
  title?: unknown;
  Type?: unknown;
  type?: unknown;
  SecondaryTypes?: unknown;
  secondaryTypes?: unknown;
  ReleaseStatuses?: unknown;
  releaseStatuses?: unknown;
  FirstReleaseDate?: unknown;
  firstReleaseDate?: unknown;
  ReleaseDate?: unknown;
  releaseDate?: unknown;
  releasedate?: unknown;
  images?: unknown;
}

export type NormalizedArtist = ReturnType<typeof toNormalizedArtist>;
export type NormalizedTrack = ReturnType<typeof toNormalizedTrack>;
export type NormalizedRelease = ReturnType<typeof toNormalizedRelease>;
export type NormalizedAlbum = ReturnType<typeof toNormalizedAlbum>;

function normalizeArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value: unknown) {
  return String(value || "").trim();
}

function normalizeType(value: unknown) {
  const normalized = normalizeString(value);
  if (normalized === "Album" || normalized === "EP" || normalized === "Single") {
    return normalized;
  }
  return normalized || "Album";
}

function normalizeImageKind(value: unknown) {
  const normalized = normalizeString(value);
  return normalized || "Cover";
}

export function toNormalizedArtistImage(image: RawImage | null | undefined) {
  const url = normalizeString(image?.Url || image?.url);
  if (!url) return null;
  return {
    kind: normalizeImageKind(image?.CoverType || image?.kind),
    url,
  };
}

export function toNormalizedArtistLink(link: RawLink | null | undefined) {
  const target = normalizeString(link?.target || link?.url);
  if (!target) return null;
  return {
    type: normalizeString(link?.type) || "external",
    target,
  };
}

const LINKED_ARTIST_PROVIDERS = {
  "deezer.com": "deezer",
  "discogs.com": "discogs",
};

export function getLinkedArtistProviderIds(links: (RawLink | null | undefined)[] = []) {
  const providerIds = [];
  for (const link of normalizeArray(links)) {
    try {
      const url = new URL(normalizeString(link?.target || link?.url?.resource));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const provider = isOwnKey(LINKED_ARTIST_PROVIDERS, host)
        ? LINKED_ARTIST_PROVIDERS[host]
        : undefined;
      const segments = url.pathname.split("/").filter(Boolean);
      const artistIndex = segments.findIndex((segment) => segment.toLowerCase() === "artist");
      const id = String(segments[artistIndex + 1] || "").match(/^\d+/)?.[0];
      if (provider && artistIndex >= 0 && id) providerIds.push(`${id}@${provider}`);
    } catch {}
  }
  return [...new Set(providerIds)];
}

export function getLinkedDeezerArtistId(links: (RawLink | null | undefined)[] = []) {
  const providerId = getLinkedArtistProviderIds(links).find((id) => id.endsWith("@deezer"));
  return providerId ? providerId.split("@")[0] : null;
}

export function toNormalizedArtist(raw: RawArtist | null | undefined) {
  const images = normalizeArray(raw?.images)
    .map(toNormalizedArtistImage)
    .filter((entry) => entry !== null);
  const links = normalizeArray(raw?.links)
    .map(toNormalizedArtistLink)
    .filter((entry) => entry !== null);
  return {
    id: normalizeString(raw?.id),
    name: normalizeString(raw?.artistname || raw?.name),
    sortName: normalizeString(raw?.sortname || raw?.sortName || raw?.artistname || raw?.name),
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
            count: Number.parseInt(String(raw.rating.Count), 10) || 0,
            value:
              raw.rating.Value != null && Number.isFinite(Number(raw.rating.Value))
                ? Number(raw.rating.Value)
                : null,
          }
        : null,
  };
}

export function toNormalizedTrack(raw: RawTrack | null | undefined) {
  return {
    id: normalizeString(raw?.id),
    recordingId: normalizeString(raw?.recordingid || raw?.recordingId),
    oldRecordingIds: normalizeArray(raw?.oldrecordingids)
      .map((id) => normalizeString(id))
      .filter(Boolean),
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

export function toNormalizedRelease(raw: RawRelease | null | undefined) {
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
        : null,
    tracks,
    releaseDate: normalizeString(raw?.releasedate || raw?.releaseDate) || null,
    disambiguation: normalizeString(raw?.disambiguation) || "",
  };
}

export function toNormalizedAlbum(raw: RawAlbum | null | undefined) {
  const artists = normalizeArray(raw?.artists)
    .map(toNormalizedArtist)
    .filter((artist) => artist?.id);
  const images = normalizeArray(raw?.images)
    .map(toNormalizedArtistImage)
    .filter((entry) => entry !== null);
  const links = normalizeArray(raw?.links)
    .map(toNormalizedArtistLink)
    .filter((entry) => entry !== null);
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
            count: Number.parseInt(String(raw.rating.Count), 10) || 0,
            value:
              raw.rating.Value != null && Number.isFinite(Number(raw.rating.Value))
                ? Number(raw.rating.Value)
                : null,
          }
        : null,
  };
}

export function toNormalizedArtistAlbum(raw: RawArtistAlbum | null | undefined) {
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
    coverImages: normalizeArray(raw?.images)
      .map(toNormalizedArtistImage)
      .filter((entry) => entry !== null),
    rating: null,
  };
}

export function toLegacyReleaseGroupSummary(
  album: Pick<NormalizedAlbum, "id" | "title" | "type" | "secondaryTypes" | "rating"> &
    Partial<Pick<NormalizedAlbum, "releaseDate" | "releases" | "artistId">> & {
      artistName?: string | null;
      firstReleaseDate?: string | null;
    },
  artist: { id?: string | null; name?: string | null } | null = null,
  { score = 0 }: { score?: number } = {},
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
            artist: { ...(artistId ? { id: artistId } : {}), name: artistName },
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

export type LegacyReleaseGroupSummary = ReturnType<typeof toLegacyReleaseGroupSummary>;
