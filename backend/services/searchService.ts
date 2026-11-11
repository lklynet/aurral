import { getTagArtists } from "./musicDataSource/index.ts";
import { buildImageProxyUrl } from "./imageProxyService.ts";
import { selectBestArtistImage } from "./imageRanking.ts";
import {
  searchAlbums as providerSearchAlbums,
  searchArtists as providerSearchArtists,
} from "./providers/brainzmashProvider.ts";
import {
  PRIMARY_RELEASE_TYPES as PRIMARY_RELEASE_TYPE_LIST,
  SECONDARY_RELEASE_TYPES as SECONDARY_RELEASE_TYPE_LIST,
} from "./apiClients/musicbrainz.ts";

export function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type TagArtist = Awaited<ReturnType<typeof getTagArtists>>["artists"][number];
type ProviderArtist = Awaited<ReturnType<typeof providerSearchArtists>>["items"][number];
type ProviderAlbum = Awaited<ReturnType<typeof providerSearchAlbums>>["items"][number];

const ALL_RELEASE_TYPES = new Set([...PRIMARY_RELEASE_TYPE_LIST, ...SECONDARY_RELEASE_TYPE_LIST]);

export function normalizeAlbumReleaseTypesFilter(releaseTypes: unknown) {
  const values: unknown[] = Array.isArray(releaseTypes)
    ? releaseTypes
    : String(releaseTypes || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && ALL_RELEASE_TYPES.has(value),
      ),
    ),
  ];
}

export function normalizeAlbumSearchSort(value: unknown) {
  const normalized = String(value || "").trim();
  return ["relevance", "dateDesc", "artistAsc", "titleAsc"].includes(normalized)
    ? normalized
    : "relevance";
}

function normalizeArtistItem(item: ProviderArtist) {
  const image = selectBestArtistImage(item.images);
  return {
    type: "artist",
    id: item.id,
    name: item.name,
    sortName: item.sortName || item.name,
    image: image?.url || null,
    imageUrl: image?.url || null,
    artistType: item.type || null,
    country: null,
    area: null,
    begin: null,
    end: null,
    disambiguation: item.disambiguation || null,
    tags: Array.isArray(item.genres) ? item.genres : [],
    genres: Array.isArray(item.genres) ? item.genres : [],
    inLibrary: false,
    score: 0,
  };
}

function normalizeAlbumItem(item: ProviderAlbum) {
  return {
    type: "album",
    id: item.id,
    title: item.title || "Untitled Release",
    artistName: item.artistName || "Unknown Artist",
    artistMbid: item.artistId || null,
    releaseDate: item.releaseDate || null,
    primaryType: item.type || null,
    secondaryTypes: Array.isArray(item.secondaryTypes) ? item.secondaryTypes : [],
    coverUrl: item.coverUrl || null,
    inLibrary: false,
    providerAlbumId: null,
    providerArtistId: null,
    status: "missing",
    score: item.score || 0,
  };
}

export async function searchArtists(query: unknown, limit: unknown = 24, offset: unknown = 0) {
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const result = await providerSearchArtists(String(query || "").trim(), {
    limit: limitInt,
    offset: offsetInt,
  });
  return {
    scope: "artist",
    query,
    count: result.count,
    offset: result.offset,
    items: result.items.map(normalizeArtistItem),
  };
}

export async function searchAlbums(
  query: unknown,
  limit: unknown = 24,
  offset: unknown = 0,
  releaseTypes: unknown = [],
  sort: unknown = "relevance",
) {
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const normalizedSort = normalizeAlbumSearchSort(sort);
  const selectedReleaseTypes = normalizeAlbumReleaseTypesFilter(releaseTypes);
  const result = await providerSearchAlbums(String(query || "").trim(), {
    limit: limitInt,
    offset: offsetInt,
    releaseTypes: selectedReleaseTypes,
    sort: normalizedSort,
  });
  return {
    scope: "album",
    query,
    sort: normalizedSort,
    count: result.count,
    offset: result.offset,
    hasMore: result.offset + result.items.length < result.count,
    items: result.items.map(normalizeAlbumItem),
  };
}

function toTagArtistItem(artist: TagArtist, tag: string) {
  const image = buildImageProxyUrl(artist.image);
  return {
    type: "artist",
    id: artist.mbid || null,
    name: artist.name || "Unknown Artist",
    sortName: artist.name || "Unknown Artist",
    image,
    imageUrl: image,
    artistType: null,
    country: null,
    area: null,
    begin: null,
    end: null,
    disambiguation: null,
    tags: [tag],
    genres: [tag],
    inLibrary: false,
    score: 0,
  };
}

export async function searchTags(query: unknown, limit: unknown = 24, offset: unknown = 0) {
  const tag = String(query || "")
    .trim()
    .replace(/^#/, "");
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(String(offset), 10) || 0);

  if (!tag) {
    return {
      scope: "tag",
      query: "",
      count: 0,
      offset: offsetInt,
      items: [],
    };
  }

  const { artists, hasMore } = await getTagArtists(tag, { limit: limitInt, offset: offsetInt });
  const items = artists.map((artist) => toTagArtistItem(artist, tag));
  return {
    scope: "tag",
    query: tag,
    count: offsetInt + items.length + (hasMore ? 1 : 0),
    offset: offsetInt,
    hasMore,
    items,
  };
}
