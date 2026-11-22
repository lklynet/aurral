import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";

const text = v.nullish(v.string());
const texts = v.nullish(v.array(v.string()));

const v1ImageSchema = v.looseObject({ kind: text, url: text });

const linkSchema = v.looseObject({ type: text, target: text });

const v1RatingSchema = v.nullish(
  v.looseObject({ count: v.nullish(v.number()), value: v.nullish(v.number()) }),
);

export const artistAlbumSchema = v.looseObject({
  id: v.string(),
  title: text,
  type: text,
  secondaryTypes: texts,
  releaseStatuses: texts,
  firstReleaseDate: text,
  rating: v1RatingSchema,
  cover: text,
  trackCount: v.nullish(v.number()),
  listeners: v.nullish(v.number()),
});

const appearsOnAlbumSchema = v.looseObject({
  ...artistAlbumSchema.entries,
  artistId: text,
  artistName: text,
});

const topTrackSchema = v.looseObject({
  recordingId: v.string(),
  title: text,
  albumId: text,
  durationMs: v.nullish(v.number()),
  listeners: v.nullish(v.number()),
});

const similarArtistSchema = v.looseObject({
  id: v.string(),
  name: text,
  score: v.nullish(v.number()),
  image: text,
  genres: texts,
});

export const artistSchema = v.looseObject({
  id: v.string(),
  name: text,
  sortName: text,
  type: text,
  status: text,
  disambiguation: text,
  overview: text,
  genres: texts,
  aliases: texts,
  images: v.nullish(v.array(v1ImageSchema)),
  links: v.nullish(v.array(linkSchema)),
  rating: v1RatingSchema,
  listeners: v.nullish(v.number()),
});

export const artistDetailSchema = v.looseObject({
  ...artistSchema.entries,
  albums: v.nullish(v.array(artistAlbumSchema)),
  appearsOn: v.nullish(v.array(appearsOnAlbumSchema)),
  topTracks: v.nullish(v.array(topTrackSchema)),
  similar: v.nullish(v.array(similarArtistSchema)),
});

const trackCreditSchema = v.looseObject({
  id: text,
  name: text,
  joinPhrase: text,
});

const trackSchema = v.looseObject({
  id: text,
  recordingId: text,
  oldRecordingIds: texts,
  title: text,
  trackNumber: v.nullish(v.number()),
  trackPosition: v.nullish(v.number()),
  mediumNumber: v.nullish(v.number()),
  durationMs: v.nullish(v.number()),
  artistId: text,
  credits: v.nullish(v.array(trackCreditSchema)),
  popular: v.nullish(v.boolean()),
});

const releaseSchema = v.looseObject({
  id: v.string(),
  title: text,
  status: text,
  country: texts,
  label: texts,
  media: v.nullish(
    v.array(v.looseObject({ format: text, name: text, position: v.nullish(v.number()) })),
  ),
  trackCount: v.nullish(v.number()),
  tracks: v.nullish(v.array(trackSchema)),
  releaseDate: text,
  disambiguation: text,
});

export const albumSchema = v.looseObject({
  id: v.string(),
  title: text,
  artistId: text,
  artists: v.nullish(v.array(artistSchema)),
  type: text,
  secondaryTypes: texts,
  releaseDate: text,
  disambiguation: text,
  genres: texts,
  aliases: texts,
  overview: text,
  images: v.nullish(v.array(v1ImageSchema)),
  cover: text,
  links: v.nullish(v.array(linkSchema)),
  releases: v.nullish(v.array(releaseSchema)),
  rating: v1RatingSchema,
  listeners: v.nullish(v.number()),
});

const genreArtistSchema = v.looseObject({
  id: v.string(),
  name: text,
  image: text,
  listeners: v.nullish(v.number()),
});

export const genreSchema = v.looseObject({
  name: text,
  artists: v.nullish(v.array(genreArtistSchema)),
});

export const searchArtistItemSchema = v.looseObject({
  id: v.string(),
  name: text,
  sortName: text,
  type: text,
  disambiguation: text,
  genres: texts,
  aliases: texts,
  image: text,
  listeners: v.nullish(v.number()),
});

export const searchAlbumItemSchema = v.looseObject({
  id: v.string(),
  title: text,
  artistId: text,
  artistName: text,
  type: text,
  secondaryTypes: texts,
  releaseDate: text,
  cover: text,
  listeners: v.nullish(v.number()),
});

export const searchTrackItemSchema = v.looseObject({
  recordingId: v.string(),
  title: text,
  artistId: text,
  artistName: text,
  albumId: text,
  albumTitle: text,
  cover: text,
  durationMs: v.nullish(v.number()),
  listeners: v.nullish(v.number()),
});

export const artistSearchResponseSchema = v.looseObject({
  artists: v.nullish(v.array(v.unknown())),
});

export const albumSearchResponseSchema = v.looseObject({
  albums: v.nullish(v.array(v.unknown())),
});

export const trackSearchResponseSchema = v.looseObject({
  tracks: v.nullish(v.array(v.unknown())),
});

export const unifiedSearchResponseSchema = v.looseObject({
  artists: v.nullish(v.array(v.unknown())),
  albums: v.nullish(v.array(v.unknown())),
  tracks: v.nullish(v.array(v.unknown())),
});

export type MetadataImage = { kind: string; url: string };
export type NormalizedArtistAlbum = ReturnType<typeof toNormalizedArtistAlbum>;
export type NormalizedAppearsOnAlbum = ReturnType<typeof toNormalizedAppearsOnAlbum>;
export type NormalizedTopTrack = ReturnType<typeof toNormalizedTopTrack>;
export type NormalizedSimilarArtist = ReturnType<typeof toNormalizedSimilarArtist>;
export type NormalizedArtist = ReturnType<typeof toNormalizedArtist>;
export type NormalizedTrack = ReturnType<typeof toNormalizedTrack>;
export type NormalizedRelease = ReturnType<typeof toNormalizedRelease>;
export type NormalizedAlbum = ReturnType<typeof toNormalizedAlbum>;
export type NormalizedGenre = ReturnType<typeof toNormalizedGenre>;
export type NormalizedSearchTrack = ReturnType<typeof toNormalizedSearchTrack>;

function clean(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function cleanList(values: string[] | null | undefined) {
  return (values ?? []).map(clean).filter(Boolean);
}

function normalizeType(value: string | null | undefined) {
  return clean(value) || "Album";
}

function toCount(value: number | null | undefined) {
  return Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0;
}

function toRating(rating: v.InferOutput<typeof v1RatingSchema>) {
  const value = rating?.value;
  const count = rating?.count ?? 0;
  return value != null ? { count, value } : null;
}

function toNormalizedImage(image: { kind?: string | null; url?: string | null }) {
  const url = clean(image.url);
  if (!url) return null;
  return { kind: clean(image.kind) || "Cover", url };
}

function toNormalizedLink(link: v.InferOutput<typeof linkSchema>) {
  const target = clean(link.target);
  if (!target) return null;
  return { type: clean(link.type) || "external", target };
}

function toNormalizedImages(
  images: { kind?: string | null; url?: string | null }[] | null | undefined,
) {
  return (images ?? [])
    .map(toNormalizedImage)
    .filter((entry): entry is MetadataImage => entry !== null);
}

function toNormalizedLinks(links: v.InferOutput<typeof linkSchema>[] | null | undefined) {
  return (links ?? []).map(toNormalizedLink).filter((entry) => entry !== null);
}

export function genreSlug(name: string) {
  return String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function similarScoreToMatch(score: number | null | undefined) {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return 1 / (1 + Math.exp(-score));
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

// An artist can link more than one Deezer page. Deezer numbers pages in the
// order it makes them, so the lowest is the oldest. The later ones tend to be
// empty copies: Radiohead links 399, with its albums, and 323887691, with none.
export function getLinkedDeezerArtistId(links: { target: string }[] = []) {
  const [original = null] = getLinkedArtistProviderIds(links)
    .filter((id) => id.endsWith("@deezer"))
    .map((id) => id.slice(0, id.indexOf("@")))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return original;
}

export function toNormalizedArtistAlbum(raw: v.InferOutput<typeof artistAlbumSchema>) {
  return {
    id: raw.id,
    title: clean(raw.title),
    type: normalizeType(raw.type),
    secondaryTypes: cleanList(raw.secondaryTypes),
    releaseStatuses: cleanList(raw.releaseStatuses),
    firstReleaseDate: clean(raw.firstReleaseDate) || null,
    rating: toRating(raw.rating),
    cover: clean(raw.cover) || null,
    trackCount: raw.trackCount ?? null,
    listeners: toCount(raw.listeners),
  };
}

export function toNormalizedAppearsOnAlbum(raw: v.InferOutput<typeof appearsOnAlbumSchema>) {
  return {
    ...toNormalizedArtistAlbum(raw),
    artistId: clean(raw.artistId) || null,
    artistName: clean(raw.artistName),
  };
}

export function toNormalizedTopTrack(raw: v.InferOutput<typeof topTrackSchema>) {
  return {
    recordingId: clean(raw.recordingId),
    title: clean(raw.title),
    albumId: clean(raw.albumId) || null,
    durationMs: raw.durationMs ?? null,
    listeners: toCount(raw.listeners),
  };
}

export function toNormalizedSimilarArtist(raw: v.InferOutput<typeof similarArtistSchema>) {
  return {
    id: clean(raw.id),
    name: clean(raw.name),
    score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : 0,
    image: clean(raw.image) || null,
    genres: raw.genres ? cleanList(raw.genres) : null,
  };
}

export function toNormalizedArtist(raw: v.InferOutput<typeof artistDetailSchema>) {
  return {
    id: raw.id,
    name: clean(raw.name),
    sortName: clean(raw.sortName || raw.name),
    type: clean(raw.type) || null,
    status: clean(raw.status) || null,
    disambiguation: clean(raw.disambiguation),
    overview: clean(raw.overview),
    genres: cleanList(raw.genres),
    aliases: cleanList(raw.aliases),
    images: toNormalizedImages(raw.images),
    links: toNormalizedLinks(raw.links),
    rating: toRating(raw.rating),
    listeners: toCount(raw.listeners),
    albums: (raw.albums ?? []).map(toNormalizedArtistAlbum),
    appearsOn: (raw.appearsOn ?? []).map(toNormalizedAppearsOnAlbum),
    topTracks: (raw.topTracks ?? []).map(toNormalizedTopTrack),
    similar: (raw.similar ?? []).map(toNormalizedSimilarArtist),
  };
}

export function toNormalizedSearchArtist(raw: v.InferOutput<typeof searchArtistItemSchema>) {
  const name = clean(raw.name);
  const image = clean(raw.image);
  return {
    id: raw.id,
    name,
    sortName: clean(raw.sortName) || name,
    type: clean(raw.type) || null,
    status: null,
    disambiguation: clean(raw.disambiguation),
    overview: "",
    genres: cleanList(raw.genres),
    aliases: cleanList(raw.aliases),
    images: image ? [{ kind: "Poster", url: image }] : ([] as MetadataImage[]),
    links: [] as { type: string; target: string }[],
    rating: null,
    listeners: toCount(raw.listeners),
    albums: [] as NormalizedArtistAlbum[],
    appearsOn: [] as NormalizedAppearsOnAlbum[],
    topTracks: [] as NormalizedTopTrack[],
    similar: [] as NormalizedSimilarArtist[],
  } satisfies NormalizedArtist;
}

export function toNormalizedSearchTrack(raw: v.InferOutput<typeof searchTrackItemSchema>) {
  return {
    recordingId: clean(raw.recordingId),
    title: clean(raw.title),
    artistId: clean(raw.artistId) || null,
    artistName: clean(raw.artistName) || "Unknown Artist",
    albumId: clean(raw.albumId) || null,
    albumTitle: clean(raw.albumTitle) || null,
    cover: clean(raw.cover) || null,
    durationMs: raw.durationMs ?? null,
    listeners: toCount(raw.listeners),
  };
}

export function toNormalizedTrack(raw: v.InferOutput<typeof trackSchema>) {
  const trackPosition = raw.trackPosition ?? raw.trackNumber ?? null;
  const credits = (raw.credits ?? []).flatMap((credit) => {
    const name = clean(credit.name);
    return name
      ? [{ name, mbid: clean(credit.id) || null, joinPhrase: credit.joinPhrase ?? "" }]
      : [];
  });
  return {
    id: clean(raw.id),
    recordingId: clean(raw.recordingId),
    oldRecordingIds: cleanList(raw.oldRecordingIds),
    title: clean(raw.title),
    trackNumber: raw.trackNumber ?? trackPosition,
    trackPosition,
    mediumNumber: raw.mediumNumber ?? null,
    durationMs: raw.durationMs ?? null,
    artistId: clean(raw.artistId) || null,
    ...(raw.popular && { popular: true }),
    ...(credits.length > 0 && { credits }),
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
      format: clean(entry.format),
      name: clean(entry.name),
      position: entry.position ?? null,
    })),
    trackCount: raw.trackCount ?? null,
    tracks: (raw.tracks ?? []).map(toNormalizedTrack),
    releaseDate: clean(raw.releaseDate) || null,
    disambiguation: clean(raw.disambiguation),
  };
}

export function toNormalizedAlbum(raw: v.InferOutput<typeof albumSchema>) {
  const artists = (raw.artists ?? []).map((artist) => toNormalizedArtist(artist));
  const images = toNormalizedImages(raw.images);
  return {
    id: raw.id,
    title: clean(raw.title),
    artistId: clean(raw.artistId) || artists[0]?.id || null,
    artists,
    type: normalizeType(raw.type),
    secondaryTypes: cleanList(raw.secondaryTypes),
    releaseDate: clean(raw.releaseDate) || null,
    disambiguation: clean(raw.disambiguation),
    genres: cleanList(raw.genres),
    aliases: cleanList(raw.aliases),
    overview: clean(raw.overview),
    images,
    cover: clean(raw.cover) || null,
    links: toNormalizedLinks(raw.links),
    releases: (raw.releases ?? []).map(toNormalizedRelease),
    rating: toRating(raw.rating),
    listeners: toCount(raw.listeners),
  };
}

export function toNormalizedGenre(raw: v.InferOutput<typeof genreSchema>) {
  return {
    name: clean(raw.name),
    artists: (raw.artists ?? [])
      .map((artist) => ({
        id: clean(artist.id),
        name: clean(artist.name),
        image: clean(artist.image) || null,
        listeners: toCount(artist.listeners),
      }))
      .filter((artist) => artist.id && artist.name),
  };
}

export function toLegacyReleaseGroupSummary(
  album: Pick<NormalizedAlbum, "id" | "title" | "type" | "secondaryTypes" | "rating"> &
    Partial<Pick<NormalizedAlbum, "releaseDate" | "releases" | "artistId" | "listeners">> & {
      artistName?: string | null;
      firstReleaseDate?: string | null;
    },
  artist: { id?: string | null; name?: string | null } | null = null,
  { score = 0 }: { score?: number } = {},
) {
  const artistName = artist?.name || album?.artistName || "";
  const artistId = artist?.id || album?.artistId || null;
  const listeners = toCount(album.listeners);
  return {
    id: album.id,
    title: album.title,
    "primary-type": album.type || "Album",
    "secondary-types": album.secondaryTypes || [],
    "first-release-date": album.releaseDate || album.firstReleaseDate || null,
    rating: album.rating || null,
    ...(listeners > 0 && { listenerCount: listeners }),
    score,
    "artist-credit": artistName
      ? [
          {
            name: artistName,
            artist: { ...(artistId && { id: artistId }), name: artistName },
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
