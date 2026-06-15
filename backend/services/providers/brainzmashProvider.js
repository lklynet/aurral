import axios from "axios";
import NodeCache from "node-cache";
import { dbOps } from "../../config/db-helpers.js";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_METADATA_BASE_URL,
  LEGACY_METADATA_BASE_URL,
  MUSICBRAINZ_API,
} from "../../config/constants.js";
import {
  rankAlbumCandidates,
  rankArtistCandidates,
} from "./brainzmashRanking.js";
import {
  matchesGenreQuery,
  toLegacyArtist,
  toLegacyRelease,
  toLegacyReleaseGroupSummary,
  toLegacySearchAlbumResult,
  toLegacySearchArtistResult,
  toNormalizedAlbum,
  toNormalizedArtist,
  toNormalizedArtistAlbum,
} from "./brainzmashMappers.js";
import { selectBestAlbumImage } from "../imageService.js";

const providerCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 2000,
});
const releaseCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 5000,
});

const healthState = {
  configuredProvider: "brainzmash",
  activeBaseUrl: null,
  failoverActive: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: "",
};

function nowIso() {
  return new Date().toISOString();
}

function getSettingsMetadata() {
  const settings = dbOps.getSettings();
  return settings.integrations?.metadata || {};
}

function isNarrowFallbacksEnabled() {
  const metadata = getSettingsMetadata();
  return metadata.enableNarrowFallbacks !== false;
}

export function getMetadataBaseUrl() {
  const metadata = getSettingsMetadata();
  const raw = String(
    metadata.baseUrl ||
      process.env.BRAINZMASH_BASE_URL ||
      DEFAULT_METADATA_BASE_URL,
  ).trim();
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    const normalized = parsed.toString().replace(/\/+$/, "");
    if (normalized === LEGACY_METADATA_BASE_URL) {
      return DEFAULT_METADATA_BASE_URL;
    }
    return normalized;
  } catch {
    return DEFAULT_METADATA_BASE_URL;
  }
}

export function getMetadataProvider() {
  return "brainzmash";
}

function getUserAgent() {
  return `${APP_NAME}/${APP_VERSION}`;
}

async function request(path, params = {}) {
  const baseUrl = getMetadataBaseUrl();
  const cacheKey = `${path}:${JSON.stringify(params)}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  healthState.activeBaseUrl = baseUrl;
  healthState.lastCheckedAt = nowIso();

  try {
    const response = await axios.get(`${baseUrl}${path}`, {
      params,
      timeout: 8000,
      headers: {
        "User-Agent": getUserAgent(),
      },
    });
    providerCache.set(cacheKey, response.data);
    healthState.lastSuccessAt = healthState.lastCheckedAt;
    healthState.lastFailureReason = "";
    return response.data;
  } catch (error) {
    healthState.lastFailureAt = healthState.lastCheckedAt;
    healthState.lastFailureReason =
      error?.response?.status != null
        ? `HTTP ${error.response.status}`
        : error?.code || error?.message || "Unknown error";
    throw error;
  }
}

function applyReleaseTypeFilter(albums, releaseTypes = []) {
  const normalizedSet = new Set(
    (Array.isArray(releaseTypes)
      ? releaseTypes
      : String(releaseTypes || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
    ).map((value) => String(value)),
  );
  if (normalizedSet.size === 0) return albums;
  return albums.filter((album) => {
    if (normalizedSet.has(album.type)) return true;
    return (album.secondaryTypes || []).some((entry) => normalizedSet.has(entry));
  });
}

function selectedReleaseForAlbum(album) {
  const releases = Array.isArray(album?.releases) ? album.releases : [];
  return (
    releases.find(
      (release) =>
        String(release?.status || "").toLowerCase() === "official" &&
        Array.isArray(release?.tracks) &&
        release.tracks.length > 0,
    ) ||
    releases.find(
      (release) => Array.isArray(release?.tracks) && release.tracks.length > 0,
    ) ||
    releases[0] ||
    null
  );
}

function storeAlbumReleaseMappings(album) {
  for (const release of album?.releases || []) {
    releaseCache.set(
      release.id,
      JSON.parse(JSON.stringify({ albumId: album.id, release })),
    );
  }
}

export async function getArtistByMbid(mbid) {
  const data = await request(`/artist/${mbid}`);
  return toNormalizedArtist(data);
}

export async function getAlbumByMbid(albumMbid) {
  const data = await request(`/album/${albumMbid}`);
  const normalized = toNormalizedAlbum(data);
  storeAlbumReleaseMappings(normalized);
  return normalized;
}

export async function getAlbumTracksByAlbumMbid(albumMbid) {
  const album = await getAlbumByMbid(albumMbid);
  const release = selectedReleaseForAlbum(album);
  return Array.isArray(release?.tracks) ? release.tracks : [];
}

export async function searchArtists(query, { limit = 24, offset = 0 } = {}) {
  const data = await request("/search/artist", {
    query,
    limit,
  });
  const source = Array.isArray(data) ? data : [];
  const items = source.map((entry, index) => ({
    ...toNormalizedArtist(entry),
    score: Math.max(0, 100 - index),
  }));
  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function searchAlbums(
  query,
  { artistName = "", limit = 24, offset = 0, releaseTypes = [], sort = "relevance" } = {},
) {
  const requestedLimit = Math.max(limit + offset, limit);
  let items = [];

  try {
    const data = await request("/search/album", {
      query,
      limit: requestedLimit,
      ...(artistName ? { artist: artistName } : {}),
    });
    const source = Array.isArray(data) ? data : [];
    items = source.map((entry, index) => {
      const artists = Array.isArray(entry?.artists) ? entry.artists : [];
      const primaryArtist = artists[0] ? toNormalizedArtist(artists[0]) : null;
      const coverImage = selectBestAlbumImage(entry?.images);
      return {
        id: entry?.id,
        title: entry?.title || "Untitled Release",
        artistName: primaryArtist?.name || artistName || "Unknown Artist",
        artistId: entry?.artistid || primaryArtist?.id || null,
        type: entry?.type || "Album",
        secondaryTypes: Array.isArray(entry?.secondarytypes) ? entry.secondarytypes : [],
        releaseDate: entry?.releasedate || null,
        coverUrl: coverImage?.Url ? String(coverImage.Url).trim() : null,
        images: Array.isArray(entry?.images) ? entry.images : [],
        inLibrary: false,
        score: Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  } catch {}

  if (items.length === 0 && isNarrowFallbacksEnabled()) {
    const mbQuery = artistName
      ? `artist:"${artistName.replace(/"/g, '\\"')}" AND releasegroup:"${String(query || "").replace(/"/g, '\\"')}"`
      : String(query || "").trim();
    const response = await axios.get(`${MUSICBRAINZ_API}/release-group`, {
      params: {
        fmt: "json",
        query: mbQuery,
        limit: requestedLimit,
        offset: 0,
      },
      timeout: 8000,
      headers: {
        "User-Agent": `${APP_NAME}/${APP_VERSION} (metadata album fallback)`,
      },
    });
    const source = Array.isArray(response?.data?.["release-groups"])
      ? response.data["release-groups"]
      : [];
    items = source.map((entry, index) => {
      const artistCredit = Array.isArray(entry?.["artist-credit"])
        ? entry["artist-credit"]
        : [];
      const primaryArtist = artistCredit[0]?.artist || {};
      return {
        id: entry?.id,
        title: entry?.title || "Untitled Release",
        artistName:
          artistCredit[0]?.name || primaryArtist?.name || artistName || "Unknown Artist",
        artistId: primaryArtist?.id || null,
        type: entry?.["primary-type"] || "Album",
        secondaryTypes: Array.isArray(entry?.["secondary-types"])
          ? entry["secondary-types"]
          : [],
        releaseDate: entry?.["first-release-date"] || null,
        coverUrl: null,
        images: [],
        inLibrary: false,
        score: Number(entry?.score || entry?.["ext:score"] || Math.max(0, 100 - index)) || 0,
        releaseStatuses: [],
      };
    });
  }

  items = applyReleaseTypeFilter(items, releaseTypes);

  if (sort === "relevance") {
    items = rankAlbumCandidates(query, items, { artistName });
  } else if (sort === "artistAsc") {
    items.sort((left, right) =>
      String(left.artistName || "").localeCompare(String(right.artistName || "")) ||
      String(left.title || "").localeCompare(String(right.title || "")),
    );
  } else if (sort === "titleAsc") {
    items.sort((left, right) =>
      String(left.title || "").localeCompare(String(right.title || "")) ||
      String(left.artistName || "").localeCompare(String(right.artistName || "")),
    );
  } else if (sort === "dateDesc") {
    items.sort(
      (left, right) =>
        String(right.releaseDate || "").localeCompare(String(left.releaseDate || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  }

  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function resolveArtistByName(name) {
  const result = await searchArtists(name, { limit: 10, offset: 0 });
  const ranked = rankArtistCandidates(name, result.items);
  return ranked[0]?.id || null;
}

export async function resolveAlbumByArtistAndTitle({
  artistName = "",
  albumTitle = "",
  releaseYear = null,
}) {
  const firstPass = await searchAlbums(albumTitle, {
    artistName,
    limit: 10,
    offset: 0,
  });
  let ranked = rankAlbumCandidates(albumTitle, firstPass.items, {
    artistName,
    releaseYear,
  });
  if (ranked[0]?.id) return ranked[0].id;

  const secondPass = await searchAlbums(albumTitle, {
    artistName: "",
    limit: 10,
    offset: 0,
  });
  ranked = rankAlbumCandidates(albumTitle, secondPass.items, {
    artistName,
    releaseYear,
  });
  return ranked[0]?.id || null;
}

export async function listArtistAlbums(
  artistMbid,
  { releaseTypes = [], includeTrackCounts = false, hydrateLimit = 30 } = {},
) {
  const rawArtist = await request(`/artist/${artistMbid}`);
  const artist = toNormalizedArtist(rawArtist);
  let albums = (Array.isArray(rawArtist?.Albums) ? rawArtist.Albums : []).map((entry) =>
    toNormalizedArtistAlbum(entry),
  );
  albums = applyReleaseTypeFilter(albums, releaseTypes);
  albums.sort((left, right) => {
    const leftBootleg = (left.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    const rightBootleg = (right.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;
    const typeOrder = { Album: 0, EP: 1, Single: 2 };
    const leftType = typeOrder[left.type] ?? 9;
    const rightType = typeOrder[right.type] ?? 9;
    if (leftType !== rightType) return leftType - rightType;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });

  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) > 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : 30;
  await Promise.all(
    albums.slice(0, safeHydrateLimit).map(async (album) => {
      try {
        const needsDate = !album.firstReleaseDate;
        const needsRating = includeTrackCounts;
        if (!needsDate && !needsRating) return;

        const hydrated = await getAlbumByMbid(album.id);
        if (needsDate) {
          album.firstReleaseDate = hydrated.releaseDate || album.firstReleaseDate;
        }
        if (needsRating) {
          album.rating = hydrated.rating || null;
        }
      } catch {}
    }),
  );

  return albums.map((album) => ({
    ...album,
    artistName: artist.name,
    artistId: artist.id,
  }));
}

export async function getArtistGenres(artistMbid) {
  const artist = await getArtistByMbid(artistMbid);
  return artist.genres || [];
}

export async function getArtistNameByMbid(artistMbid) {
  const artist = await getArtistByMbid(artistMbid);
  return artist.name || null;
}

export function getMetadataProviderHealthSnapshot() {
  return {
    brainzmash: {
      configuredProvider: healthState.configuredProvider,
      activeBaseUrl: getMetadataBaseUrl(),
      failoverActive: healthState.failoverActive,
      lastCheckedAt: healthState.lastCheckedAt,
      lastSuccessAt: healthState.lastSuccessAt,
      lastFailureAt: healthState.lastFailureAt,
      lastFailureReason: healthState.lastFailureReason,
    },
  };
}

export async function legacyMusicbrainzRequest(endpoint, params = {}) {
  const normalizedEndpoint = String(endpoint || "").trim();
  if (normalizedEndpoint.startsWith("/artist/")) {
    const mbid = normalizedEndpoint.replace(/^\/artist\//, "").trim();
    const artist = await getArtistByMbid(mbid);
    return toLegacyArtist(artist);
  }

  if (normalizedEndpoint === "/artist") {
    const result = await searchArtists(String(params.query || "").trim(), {
      limit: params.limit || 24,
      offset: params.offset || 0,
    });
    return {
      count: result.count,
      offset: result.offset,
      artists: result.items.map((item) => toLegacySearchArtistResult(item, item.score)),
    };
  }

  if (normalizedEndpoint.startsWith("/release-group/")) {
    const mbid = normalizedEndpoint.replace(/^\/release-group\//, "").trim();
    const album = await getAlbumByMbid(mbid);
    return toLegacyReleaseGroupSummary(album, album.artists[0], { score: 100 });
  }

  if (normalizedEndpoint === "/release-group") {
    if (params.artist) {
      const items = await listArtistAlbums(String(params.artist).trim(), {
        releaseTypes: [],
      });
      const offset = Number.parseInt(params.offset, 10) || 0;
      const limit = Number.parseInt(params.limit, 10) || items.length;
      const paged = items.slice(offset, offset + limit);
      return {
        "release-group-count": items.length,
        "release-groups": paged.map((item) =>
          toLegacyReleaseGroupSummary(item, {
            id: item.artistId,
            name: item.artistName,
          }),
        ),
      };
    }
    const result = await searchAlbums(String(params.query || "").trim(), {
      artistName: "",
      limit: params.limit || 24,
      offset: params.offset || 0,
      releaseTypes: [],
    });
    return {
      count: result.count,
      "release-group-count": result.count,
      "release-groups": result.items.map((item) => toLegacySearchAlbumResult(item)),
    };
  }

  if (normalizedEndpoint.startsWith("/release/")) {
    const releaseId = normalizedEndpoint.replace(/^\/release\//, "").trim();
    const cached = releaseCache.get(releaseId);
    if (!cached?.release) {
      throw new Error(`Release ${releaseId} not found in BrainzMash cache`);
    }
    return toLegacyRelease(cached.release);
  }

  throw new Error(`Unsupported legacy metadata endpoint: ${normalizedEndpoint}`);
}

export async function findArtistsByGenre(query, { limit = 24, offset = 0 } = {}) {
  const result = await searchArtists(query, { limit: Math.max(limit * 3, 60), offset: 0 });
  const filtered = result.items.filter((artist) => matchesGenreQuery(artist, query));
  return {
    query,
    count: filtered.length,
    offset,
    items: filtered.slice(offset, offset + limit),
  };
}
