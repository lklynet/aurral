import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";

const text = v.nullish(v.string());
const texts = v.nullish(v.array(v.string()));

const imageSchema = v.looseObject({ CoverType: text, Url: text });

const linkSchema = v.looseObject({ type: text, target: text });

const ratingSchema = v.nullish(
  v.looseObject({ Count: v.nullish(v.number()), Value: v.nullish(v.number()) }),
);

export const artistSchema = v.looseObject({
  id: v.string(),
  artistname: text,
  sortname: text,
  type: text,
  status: text,
  disambiguation: text,
  overview: text,
  genres: texts,
  artistaliases: texts,
  images: v.nullish(v.array(imageSchema)),
  links: v.nullish(v.array(linkSchema)),
  rating: ratingSchema,
});

const artistAlbumSchema = v.looseObject({
  Id: v.string(),
  Title: text,
  Type: text,
  SecondaryTypes: texts,
  ReleaseStatuses: texts,
});

export const artistDetailSchema = v.looseObject({
  ...artistSchema.entries,
  Albums: v.nullish(v.array(artistAlbumSchema)),
});

const trackSchema = v.looseObject({
  id: text,
  recordingid: text,
  oldrecordingids: texts,
  trackname: text,
  trackposition: v.nullish(v.number()),
  mediumnumber: v.nullish(v.number()),
  durationms: v.nullish(v.number()),
  artistid: text,
});

const releaseSchema = v.looseObject({
  id: v.string(),
  title: text,
  status: text,
  country: texts,
  label: texts,
  media: v.nullish(
    v.array(v.looseObject({ Format: text, Name: text, Position: v.nullish(v.number()) })),
  ),
  track_count: v.nullish(v.number()),
  tracks: v.nullish(v.array(trackSchema)),
  releasedate: text,
  disambiguation: text,
});

export const albumSchema = v.looseObject({
  id: v.string(),
  title: text,
  artistid: text,
  artists: v.nullish(v.array(artistSchema)),
  type: text,
  secondarytypes: texts,
  releasedate: text,
  genres: texts,
  aliases: texts,
  overview: text,
  images: v.nullish(v.array(imageSchema)),
  links: v.nullish(v.array(linkSchema)),
  releases: v.nullish(v.array(releaseSchema)),
  rating: ratingSchema,
});

export type BrainzmashImage = v.InferOutput<typeof imageSchema>;

export type NormalizedArtist = ReturnType<typeof toNormalizedArtist>;
export type NormalizedTrack = ReturnType<typeof toNormalizedTrack>;
export type NormalizedRelease = ReturnType<typeof toNormalizedRelease>;
export type NormalizedAlbum = ReturnType<typeof toNormalizedAlbum>;

function clean(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function cleanList(values: string[] | null | undefined) {
  return (values ?? []).map(clean).filter(Boolean);
}

function normalizeType(value: string | null | undefined) {
  return clean(value) || "Album";
}

function toRating(rating: v.InferOutput<typeof ratingSchema>) {
  return rating?.Value != null ? { count: rating.Count ?? 0, value: rating.Value } : null;
}

function toNormalizedArtistImage(image: BrainzmashImage) {
  const url = clean(image.Url);
  if (!url) return null;
  return { kind: clean(image.CoverType) || "Cover", url };
}

function toNormalizedArtistLink(link: v.InferOutput<typeof linkSchema>) {
  const target = clean(link.target);
  if (!target) return null;
  return { type: clean(link.type) || "external", target };
}

function toNormalizedImages(images: BrainzmashImage[] | null | undefined) {
  return (images ?? []).map(toNormalizedArtistImage).filter((entry) => entry !== null);
}

function toNormalizedLinks(links: v.InferOutput<typeof linkSchema>[] | null | undefined) {
  return (links ?? []).map(toNormalizedArtistLink).filter((entry) => entry !== null);
}

const LINKED_ARTIST_PROVIDERS = {
  "deezer.com": "deezer",
  "discogs.com": "discogs",
};

export function getLinkedArtistProviderIds(links: { target: string }[] = []) {
  const providerIds = [];
  for (const link of links) {
    try {
      const url = new URL(link.target);
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

export function getLinkedDeezerArtistId(links: { target: string }[] = []) {
  const providerId = getLinkedArtistProviderIds(links).find((id) => id.endsWith("@deezer"));
  return providerId ? providerId.split("@")[0] : null;
}

export function toNormalizedArtist(raw: v.InferOutput<typeof artistSchema>) {
  return {
    id: raw.id,
    name: clean(raw.artistname),
    sortName: clean(raw.sortname || raw.artistname),
    type: clean(raw.type) || null,
    status: clean(raw.status) || null,
    disambiguation: clean(raw.disambiguation),
    overview: clean(raw.overview),
    genres: cleanList(raw.genres),
    aliases: cleanList(raw.artistaliases),
    images: toNormalizedImages(raw.images),
    links: toNormalizedLinks(raw.links),
    rating: toRating(raw.rating),
  };
}

export function toNormalizedTrack(raw: v.InferOutput<typeof trackSchema>) {
  return {
    id: clean(raw.id),
    recordingId: clean(raw.recordingid),
    oldRecordingIds: cleanList(raw.oldrecordingids),
    title: clean(raw.trackname),
    trackNumber: raw.trackposition ?? null,
    trackPosition: raw.trackposition ?? null,
    mediumNumber: raw.mediumnumber ?? null,
    durationMs: raw.durationms ?? null,
    artistId: clean(raw.artistid) || null,
  };
}

export function toNormalizedRelease(raw: v.InferOutput<typeof releaseSchema>) {
  return {
    id: raw.id,
    title: clean(raw.title),
    status: clean(raw.status) || null,
    country: cleanList(raw.country),
    label: cleanList(raw.label),
    media: (raw.media ?? []).map((entry) => ({
      format: clean(entry.Format),
      name: clean(entry.Name),
      position: entry.Position ?? null,
    })),
    trackCount: raw.track_count ?? null,
    tracks: (raw.tracks ?? []).map(toNormalizedTrack),
    releaseDate: clean(raw.releasedate) || null,
    disambiguation: clean(raw.disambiguation),
  };
}

export function toNormalizedAlbum(raw: v.InferOutput<typeof albumSchema>) {
  const artists = (raw.artists ?? []).map(toNormalizedArtist);
  return {
    id: raw.id,
    title: clean(raw.title),
    artistId: clean(raw.artistid) || artists[0]?.id || null,
    artists,
    type: normalizeType(raw.type),
    secondaryTypes: cleanList(raw.secondarytypes),
    releaseDate: clean(raw.releasedate) || null,
    genres: cleanList(raw.genres),
    aliases: cleanList(raw.aliases),
    overview: clean(raw.overview),
    images: toNormalizedImages(raw.images),
    links: toNormalizedLinks(raw.links),
    releases: (raw.releases ?? []).map(toNormalizedRelease),
    rating: toRating(raw.rating),
  };
}

export function toNormalizedArtistAlbum(raw: v.InferOutput<typeof artistAlbumSchema>) {
  return {
    id: raw.Id,
    title: clean(raw.Title),
    type: normalizeType(raw.Type),
    secondaryTypes: cleanList(raw.SecondaryTypes),
    releaseStatuses: cleanList(raw.ReleaseStatuses),
    firstReleaseDate: null as string | null,
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
    releases: (album.releases ?? []).map((release) => ({
      id: release.id,
      status: release.status || null,
      date: release.releaseDate || null,
      title: release.title || album.title,
    })),
  };
}

export type LegacyReleaseGroupSummary = ReturnType<typeof toLegacyReleaseGroupSummary>;
