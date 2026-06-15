import NodeCache from "node-cache";
import { getDiscoveryCache } from "./discoveryService.js";
import { getLastfmApiKey, lastfmRequest } from "./apiClients.js";
import { buildImageProxyUrl } from "./imageProxyService.js";
import { selectBestArtistImage } from "./imageService.js";
import { lidarrClient } from "./lidarrClient.js";
import {
  searchAlbums as providerSearchAlbums,
  searchArtists as providerSearchArtists,
} from "./metadataProvider.js";
import {
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  searchFallbackGenreArtists,
} from "./listenbrainzDiscoveryFallback.js";

const PRIMARY_RELEASE_TYPES = new Set(["Album", "EP", "Single"]);
const SECONDARY_RELEASE_TYPES = new Set([
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
]);
const ALL_RELEASE_TYPES = new Set([
  ...PRIMARY_RELEASE_TYPES,
  ...SECONDARY_RELEASE_TYPES,
]);
const albumLibraryLookupCache = new NodeCache({
  stdTTL: 60,
  checkperiod: 60,
  maxKeys: 10,
});

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePercentOfTracks(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw > 1 && raw <= 100) return Math.round(raw);
  if (raw <= 1) return Math.round(raw * 100);
  return Math.min(100, Math.round(raw / 10));
}

async function getAlbumLibraryLookup(albumMbids) {
  const lookup = new Map();
  if (!lidarrClient.isConfigured() || albumMbids.length === 0) {
    return lookup;
  }

  try {
    const lidarrAlbums = albumLibraryLookupCache.get("lidarrAlbums");
    if (!lidarrAlbums) {
      return lookup;
    }
    const wanted = new Set(albumMbids);
    for (const album of Array.isArray(lidarrAlbums) ? lidarrAlbums : []) {
      const foreignAlbumId = album?.foreignAlbumId;
      if (!foreignAlbumId || !wanted.has(foreignAlbumId)) continue;
      const percentOfTracks = normalizePercentOfTracks(
        album?.statistics?.percentOfTracks,
      );
      const sizeOnDisk = Number(album?.statistics?.sizeOnDisk || 0);
      lookup.set(foreignAlbumId, {
        inLibrary: true,
        libraryAlbumId:
          album.id !== undefined && album.id !== null ? String(album.id) : null,
        libraryArtistId:
          album.artistId !== undefined && album.artistId !== null
            ? String(album.artistId)
            : null,
        status:
          percentOfTracks >= 100 || sizeOnDisk > 0 ? "available" : "inLibrary",
      });
    }
  } catch (error) {
    console.warn("Album search enrichment failed:", error.message);
  }

  return lookup;
}

export function normalizeAlbumReleaseTypesFilter(releaseTypes) {
  const values = Array.isArray(releaseTypes)
    ? releaseTypes
    : String(releaseTypes || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return [...new Set(values.filter((value) => ALL_RELEASE_TYPES.has(value)))];
}

export function normalizeAlbumSearchSort(value) {
  const normalized = String(value || "").trim();
  return ["relevance", "dateDesc", "artistAsc", "titleAsc"].includes(normalized)
    ? normalized
    : "relevance";
}

function normalizeArtistItem(item) {
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
    score: item.score || 0,
  };
}

export function normalizeArtistSearchItem(item, imageCache = {}) {
  const normalized = normalizeArtistItem({
    id: item?.id,
    name: item?.name,
    sortName: item?.sortName || item?.["sort-name"] || item?.name,
    type: item?.type || null,
    disambiguation: item?.disambiguation || null,
    genres: item?.genres || item?.tags || [],
    images: imageCache?.[item?.id]?.imageUrl
      ? [{ url: imageCache[item.id].imageUrl }]
      : item?.imageUrl || item?.image
        ? [{ url: item.imageUrl || item.image }]
        : [],
    score: item?.score || 0,
  });
  return normalized;
}

function normalizeAlbumItem(item, lookup = null) {
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
    inLibrary: !!lookup,
    libraryAlbumId: lookup?.libraryAlbumId || null,
    libraryArtistId: lookup?.libraryArtistId || null,
    status: lookup?.status || "missing",
    score: item.score || 0,
  };
}

export function normalizeAlbumSearchItem(item, lookup = {}) {
  const artistCredit = Array.isArray(item?.["artist-credit"])
    ? item["artist-credit"]
    : [];
  const primaryCredit = artistCredit[0] || {};
  const artist = primaryCredit.artist || {};
  const normalized = normalizeAlbumItem(
    {
      id: item?.id,
      title: item?.title,
      artistName: primaryCredit.name || artist.name || item?.artistName,
      artistId: artist.id || item?.artistMbid || item?.artistId || null,
      type: item?.type || item?.["primary-type"] || null,
      secondaryTypes:
        item?.secondaryTypes || item?.["secondary-types"] || [],
      releaseDate: item?.releaseDate || item?.["first-release-date"] || null,
      coverUrl: item?.coverUrl || null,
      score: item?.score || 0,
    },
    lookup?.inLibrary || lookup?.libraryAlbumId || lookup?.libraryArtistId
      ? lookup
      : null,
  );
  delete normalized.score;
  return normalized;
}

export function matchesAlbumReleaseTypeFilter(item, selectedReleaseTypes = []) {
  const selected = normalizeAlbumReleaseTypesFilter(selectedReleaseTypes);
  if (selected.length === 0) return true;

  const primaryType = String(item?.primaryType || item?.["primary-type"] || "").trim();
  const secondaryTypes = Array.isArray(
    item?.secondaryTypes || item?.["secondary-types"],
  )
    ? item.secondaryTypes || item["secondary-types"]
    : [];

  const primaryMatches = selected.filter((value) => PRIMARY_RELEASE_TYPES.has(value));
  const secondaryMatches = selected.filter((value) =>
    SECONDARY_RELEASE_TYPES.has(value),
  );

  if (primaryMatches.length > 0 && !primaryMatches.includes(primaryType)) {
    return false;
  }

  if (!secondaryMatches.every((value) => secondaryTypes.includes(value))) {
    return false;
  }

  if (secondaryMatches.length > 0 && secondaryTypes.length !== secondaryMatches.length) {
    return false;
  }

  return true;
}

export async function searchArtists(query, limit = 24, offset = 0) {
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(offset, 10) || 0);
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
  query,
  limit = 24,
  offset = 0,
  releaseTypes = [],
  sort = "relevance",
) {
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(offset, 10) || 0);
  const normalizedSort = normalizeAlbumSearchSort(sort);
  const selectedReleaseTypes = normalizeAlbumReleaseTypesFilter(releaseTypes);
  const result = await providerSearchAlbums(String(query || "").trim(), {
    limit: limitInt,
    offset: offsetInt,
    releaseTypes: selectedReleaseTypes,
    sort: normalizedSort,
  });
  const albumLookup = await getAlbumLibraryLookup(result.items.map((item) => item.id));
  return {
    scope: "album",
    query,
    sort: normalizedSort,
    count: result.count,
    offset: result.offset,
    hasMore: result.offset + result.items.length < result.count,
    items: result.items.map((item) =>
      normalizeAlbumItem(item, albumLookup.get(item.id)),
    ),
  };
}

function normalizeTagArtistItem(artist, tag) {
  return {
    ...artist,
    tags: [tag],
  };
}

function getTagArtistKey(artist) {
  const artistId = String(artist?.id || artist?.mbid || "").trim().toLowerCase();
  if (artistId) return `id:${artistId}`;
  const artistName = String(artist?.name || "").trim().toLowerCase();
  return artistName ? `name:${artistName}` : null;
}

function matchesTagSearch(artist, normalizedTag) {
  const tags = Array.isArray(artist?.tags) ? artist.tags : [];
  const genres = Array.isArray(artist?.genres) ? artist.genres : [];
  return [...tags, ...genres].some(
    (entry) => normalizeSearchText(entry) === normalizedTag,
  );
}

function dedupeTagArtists(artists) {
  const seen = new Set();
  const output = [];
  for (const artist of Array.isArray(artists) ? artists : []) {
    const key = getTagArtistKey(artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(artist);
  }
  return output;
}

function getTagSourceMap(artists) {
  const sourceMap = new Map();
  for (const artist of Array.isArray(artists) ? artists : []) {
    const key = getTagArtistKey(artist);
    if (!key || sourceMap.has(key)) continue;
    sourceMap.set(key, artist?.tagResultSource || "all");
  }
  return sourceMap;
}

function normalizeLastfmTagArtist(artist, tag) {
  let imageUrl = null;
  if (Array.isArray(artist?.image)) {
    const img =
      artist.image.find((entry) => entry.size === "extralarge") ||
      artist.image.find((entry) => entry.size === "large") ||
      artist.image.slice(-1)[0];
    if (
      img?.["#text"] &&
      !String(img["#text"]).includes("2a96cbd8b46e442fc41c2b86b821562f")
    ) {
      imageUrl = img["#text"];
    }
  }

  return normalizeTagArtistItem(
    {
      type: "artist",
      id: artist?.mbid || null,
      name: artist?.name || "Unknown Artist",
      sortName: artist?.name || "Unknown Artist",
      image: buildImageProxyUrl(imageUrl) || imageUrl,
      imageUrl: buildImageProxyUrl(imageUrl) || imageUrl,
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
      tagResultSource: "all",
    },
    tag,
  );
}

async function fetchMergedLastfmTagArtists(tag, limitInt, offsetInt, recommendedItems) {
  const pageSize = 50;
  const requiredCount = offsetInt + limitInt;
  const supplementalItems = [];
  const seen = new Set(recommendedItems.map((artist) => getTagArtistKey(artist)).filter(Boolean));
  let page = 1;
  let exhausted = false;

  while (!exhausted && recommendedItems.length + supplementalItems.length < requiredCount) {
    const data = await lastfmRequest("tag.getTopArtists", {
      tag,
      limit: pageSize,
      page,
    });
    const artists = Array.isArray(data?.topartists?.artist)
      ? data.topartists.artist
      : data?.topartists?.artist
        ? [data.topartists.artist]
        : [];

    if (artists.length === 0) {
      exhausted = true;
      break;
    }

    for (const artist of artists) {
      const normalized = normalizeLastfmTagArtist(artist, tag);
      const key = getTagArtistKey(normalized);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      supplementalItems.push(normalized);
    }

    const reportedTotal = Number.parseInt(data?.topartists?.["@attr"]?.total, 10);
    const totalPages = Number.isFinite(reportedTotal)
      ? Math.ceil(reportedTotal / pageSize)
      : null;
    exhausted =
      artists.length < pageSize ||
      (Number.isFinite(totalPages) && page >= totalPages);
    page += 1;
  }

  return {
    items: [...recommendedItems, ...supplementalItems],
    exhausted,
  };
}

export async function searchTags(
  query,
  limit = 24,
  offset = 0,
) {
  const tag = String(query || "").trim().replace(/^#/, "");
  const limitInt = parsePositiveInt(limit, 24);
  const offsetInt = Math.max(0, Number.parseInt(offset, 10) || 0);

  if (!tag) {
    return {
      scope: "tag",
      query: "",
      count: 0,
      offset: offsetInt,
      items: [],
    };
  }

  const discoveryCache = getDiscoveryCache();
  const tagLower = normalizeSearchText(tag);
  const recommendedMatches = dedupeTagArtists(
    (discoveryCache.recommendations || [])
      .filter((artist) => matchesTagSearch(artist, tagLower))
      .map((artist) =>
        normalizeTagArtistItem(
          {
            ...artist,
            tagResultSource: "recommended",
          },
          tag,
        ),
      ),
  );

  if (getLastfmApiKey()) {
    const merged = await fetchMergedLastfmTagArtists(
      tag,
      limitInt,
      offsetInt,
      recommendedMatches,
    );
    const items = merged.items.slice(offsetInt, offsetInt + limitInt);
    return {
      scope: "tag",
      query: tag,
      count: merged.exhausted
        ? merged.items.length
        : offsetInt + items.length + (merged.items.length > offsetInt + items.length ? 1 : 0),
      offset: offsetInt,
      hasMore: !merged.exhausted || offsetInt + items.length < merged.items.length,
      items,
    };
  }

  const fallbackResult = await searchFallbackGenreArtists({
    tag,
    limit: offsetInt + limitInt,
    offset: 0,
    precomputedGenrePools:
      discoveryCache?.fallbackGenrePools &&
      Object.keys(discoveryCache.fallbackGenrePools).length > 0
        ? discoveryCache.fallbackGenrePools
        : null,
  });
  if (fallbackResult) {
    const sourceMap = getTagSourceMap(recommendedMatches);
    const fallbackItems = fallbackResult.artists.map((artist) =>
      normalizeTagArtistItem(
        {
          type: "artist",
          id: artist.id || artist.mbid || null,
          name: artist.name || "Unknown Artist",
          sortName: artist.sortName || artist.name || "Unknown Artist",
          image: artist.image || artist.imageUrl || null,
          imageUrl: artist.image || artist.imageUrl || null,
          artistType: null,
          country: null,
          area: null,
          begin: null,
          end: null,
          disambiguation: null,
          tags: artist.tags || [tag],
          genres: artist.genres || [tag],
          inLibrary: false,
          score: 0,
          tagResultSource: sourceMap.get(getTagArtistKey(artist)) || "all",
        },
        tag,
      ),
    );
    const mergedItems = dedupeTagArtists([...recommendedMatches, ...fallbackItems]);
    const items = mergedItems.slice(offsetInt, offsetInt + limitInt);
    return {
      scope: "tag",
      query: tag,
      count: Math.max(mergedItems.length, fallbackResult.total),
      offset: offsetInt,
      provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
      fallbackLimited: true,
      hasMore:
        offsetInt + items.length < mergedItems.length ||
        offsetInt + limitInt < fallbackResult.total,
      items,
    };
  }

  const mergedItems = dedupeTagArtists([
    ...recommendedMatches,
    ...(Array.isArray(discoveryCache.globalTop) ? discoveryCache.globalTop : []),
    ...(Array.isArray(discoveryCache.basedOn) ? discoveryCache.basedOn : []),
  ])
    .filter((artist) => matchesTagSearch(artist, tagLower))
    .map((artist) =>
      normalizeTagArtistItem(
        {
          ...artist,
          tagResultSource:
            artist.tagResultSource === "recommended" ? "recommended" : "all",
        },
        tag,
      ),
    );

  return {
    scope: "tag",
    query: tag,
    count: mergedItems.length,
    offset: offsetInt,
    hasMore: offsetInt + limitInt < mergedItems.length,
    items: mergedItems.slice(offsetInt, offsetInt + limitInt),
  };
}
