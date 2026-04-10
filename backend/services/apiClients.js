import axios from "axios";
import Bottleneck from "bottleneck";
import NodeCache from "node-cache";
import { dbOps } from "../config/db-helpers.js";
import {
  MUSICBRAINZ_API,
  LASTFM_API,
  APP_NAME,
  APP_VERSION,
} from "../config/constants.js";

const mbCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 500 });
const lastfmCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 500,
});
const deezerArtistCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});

export const getLastfmApiKey = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.lastfm?.apiKey || process.env.LASTFM_API_KEY;
};

export const getTicketmasterApiKey = () => {
  const settings = dbOps.getSettings();
  const configuredValue = settings.integrations?.ticketmaster?.apiKey;
  if (configuredValue !== undefined && configuredValue !== null) {
    return String(configuredValue).trim();
  }
  return String(process.env.TICKETMASTER_API_KEY || "").trim();
};

export const getMusicBrainzContact = () => {
  const settings = dbOps.getSettings();
  return (
    settings.integrations?.musicbrainz?.email ||
    process.env.CONTACT_EMAIL ||
    "user@example.com"
  );
};

const mbLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000,
});

const lastfmLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 200,
});

let musicbrainzLast503Log = 0;
const lastfmInflightRequests = new Map();
const lastfmErrorLogAt = new Map();

const LASTFM_TIMEOUT_MS = 6000;
const LASTFM_MAX_RETRIES = 2;

const musicbrainzRequestWithRetry = async (
  endpoint,
  params = {},
  retryCount = 0,
  forceIpv4 = false,
) => {
  const cacheKey = `mb:${endpoint}:${JSON.stringify(params)}`;
  const cached = mbCache.get(cacheKey);
  if (cached) return cached;

  const MAX_RETRIES = 3;
  const queryParams = new URLSearchParams({
    fmt: "json",
    ...params,
  });

  const isConnectionError = (error) => {
    const connectionErrors = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ERR_BAD_RESPONSE",
      "ERR_NETWORK",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_TIMED_OUT",
      "ERR_INTERNET_DISCONNECTED",
    ];
    return (
      connectionErrors.some(
        (err) => error.code === err || error.message.includes(err),
      ) ||
      (error.code &&
        (error.code.startsWith("E") || error.code.startsWith("ERR_")))
    );
  };

  const isServerUnavailable = (error) =>
    error.response && [502, 503, 504].includes(error.response.status);

  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
  try {
    const response = await axios.get(
      `${MUSICBRAINZ_API}${endpoint}?${queryParams}`,
      {
        headers: { "User-Agent": userAgent },
        timeout: 5000,
        ...(forceIpv4 ? { family: 4 } : {}),
      },
    );
    mbCache.set(cacheKey, response.data);
    return response.data;
  } catch (error) {
    const connectionError = isConnectionError(error);
    const shouldRetry =
      retryCount < MAX_RETRIES &&
      (connectionError ||
        (error.response &&
          [429, 500, 502, 503, 504].includes(error.response.status)));

    if (shouldRetry) {
      const delay = 300 * Math.pow(2, retryCount);
      const errorType = error.response
        ? `HTTP ${error.response.status}`
        : error.code || error.message;
      console.warn(
        `MusicBrainz error (${errorType}), retrying in ${delay}ms... (attempt ${
          retryCount + 1
        }/${MAX_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return musicbrainzRequestWithRetry(
        endpoint,
        params,
        retryCount + 1,
        forceIpv4 || connectionError,
      );
    }

    if (error.response && error.response.status === 404) {
      console.warn(`MusicBrainz 404 Not Found for ${endpoint}`);
      throw error;
    }

    const status = error.response?.status;
    if (status === 502 || status === 503 || status === 504) {
      if (
        !musicbrainzLast503Log ||
        Date.now() - musicbrainzLast503Log > 15000
      ) {
        musicbrainzLast503Log = Date.now();
        console.warn(
          `MusicBrainz ${status} (suppressing further logs for 15s)`,
        );
      }
    } else {
      console.error("MusicBrainz API error:", error.message);
    }
    throw error;
  }
};

export const musicbrainzRequest = mbLimiter.wrap(musicbrainzRequestWithRetry);

export const lastfmRequest = lastfmLimiter.wrap(async (method, params = {}) => {
  const apiKey = getLastfmApiKey();
  if (!apiKey) return null;

  const cacheKey = `lfm:${method}:${JSON.stringify(params)}`;
  const cached = lastfmCache.get(cacheKey);
  if (cached) return cached;
  const inflight = lastfmInflightRequests.get(cacheKey);
  if (inflight) return inflight;

  const requestPromise = (async () => {
    const isRetryable = (error) => {
      const status = error.response?.status;
      const code = error.code;
      return (
        code === "ECONNABORTED" ||
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        [408, 425, 429, 500, 502, 503, 504].includes(status)
      );
    };
    const getLogKey = (details) =>
      `${details.method}:${details.status || "none"}:${details.code || "none"}`;
    const logError = (message, details) => {
      const key = getLogKey(details);
      const now = Date.now();
      const last = lastfmErrorLogAt.get(key) || 0;
      if (now - last < 15000) return;
      lastfmErrorLogAt.set(key, now);
      console.error(message, details);
    };
    let lastError = null;
    for (let retryCount = 0; retryCount <= LASTFM_MAX_RETRIES; retryCount++) {
      try {
        const response = await axios.get(LASTFM_API, {
          params: {
            method,
            api_key: apiKey,
            format: "json",
            ...params,
          },
          timeout: LASTFM_TIMEOUT_MS,
        });
        lastfmCache.set(cacheKey, response.data);
        return response.data;
      } catch (error) {
        lastError = error;
        if (retryCount < LASTFM_MAX_RETRIES && isRetryable(error)) {
          const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }
    const status = lastError?.response?.status || null;
    const payloadError =
      lastError?.response?.data?.message ||
      lastError?.response?.data?.error ||
      null;
    const details = {
      method,
      status,
      code: lastError?.code || null,
      message: lastError?.message || "Unknown Last.fm error",
      error: payloadError,
    };
    if (details.code === "ECONNABORTED") {
      logError(`Last.fm API timeout (${method})`, details);
    } else {
      logError(`Last.fm API error (${method})`, details);
    }
    return null;
  })();
  lastfmInflightRequests.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    lastfmInflightRequests.delete(cacheKey);
  }
});

async function getDeezerArtist(artistName) {
  const normalizedName = artistName.toLowerCase().trim();
  const cached = deezerArtistCache.get(normalizedName);
  if (cached !== undefined) return cached;

  try {
    const searchRes = await axios.get("https://api.deezer.com/search/artist", {
      params: { q: artistName, limit: 5 },
      timeout: 3000,
    });
    const artists = searchRes.data?.data;
    if (!artists?.length) {
      deezerArtistCache.set(normalizedName, null);
      return null;
    }

    const searchLower = normalizedName.replace(/^the\s+/i, "");
    let bestMatch = null;

    for (const a of artists) {
      if (!a?.id) continue;
      const aNameLower = (a.name || "").toLowerCase().replace(/^the\s+/i, "");
      if (aNameLower === searchLower || aNameLower === normalizedName) {
        bestMatch = a;
        break;
      }
      if (!bestMatch && aNameLower.includes(searchLower)) {
        bestMatch = a;
      }
    }

    if (!bestMatch) {
      bestMatch = artists[0];
    }

    if (!bestMatch?.id) {
      deezerArtistCache.set(normalizedName, null);
      return null;
    }

    const result = {
      id: bestMatch.id,
      name: bestMatch.name,
      imageUrl:
        bestMatch.picture_big ||
        bestMatch.picture_medium ||
        bestMatch.picture ||
        null,
    };
    deezerArtistCache.set(normalizedName, result);
    return result;
  } catch (e) {
    return null;
  }
}

export async function getDeezerArtistById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `id:${normalizedId}`;
  const cached = deezerArtistCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}`,
      {
        timeout: 3000,
      },
    );
    const data = res.data;
    if (!data?.id) {
      deezerArtistCache.set(cacheKey, null);
      return null;
    }
    const result = {
      id: data.id,
      name: data.name || null,
      imageUrl: data.picture_big || data.picture_medium || data.picture || null,
    };
    deezerArtistCache.set(cacheKey, result);
    return result;
  } catch (e) {
    deezerArtistCache.set(cacheKey, null);
    return null;
  }
}

const deezerBioCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 500,
});

const wikiBioCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});

const wikidataTitleCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});

/**
 * Fetch artist biography from Deezer (GET /artist/{id}).
 * Returns bio string or null. Deezer's public API may not include bio for all artists.
 */
export async function deezerGetArtistBio(artistName) {
  if (!artistName || typeof artistName !== "string") return null;
  const artist = await getDeezerArtist(artistName);
  if (!artist?.id) return null;
  const cacheKey = `dz-bio:${artist.id}`;
  const cached = deezerBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(`https://api.deezer.com/artist/${artist.id}`, {
      timeout: 3000,
    });
    const data = res.data;
    const bio =
      (data && (data.biography || data.bio || data.description)) || null;
    const value = typeof bio === "string" && bio.trim() ? bio.trim() : null;
    deezerBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    deezerBioCache.set(cacheKey, null);
    return null;
  }
}

export async function deezerGetArtistBioById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `dz-bio:${normalizedId}`;
  const cached = deezerBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}`,
      {
        timeout: 3000,
      },
    );
    const data = res.data;
    const bio =
      (data && (data.biography || data.bio || data.description)) || null;
    const value = typeof bio === "string" && bio.trim() ? bio.trim() : null;
    deezerBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    deezerBioCache.set(cacheKey, null);
    return null;
  }
}

async function wikidataGetWikipediaTitleByMbid(mbid) {
  if (!mbid) return null;
  const cacheKey = `wd:v2:${mbid}`;
  const cached = wikidataTitleCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const query = [
      "PREFIX wdt: <http://www.wikidata.org/prop/direct/>",
      "PREFIX schema: <http://schema.org/>",
      `SELECT ?article WHERE { ?band wdt:P434 "${mbid}" . ?article schema:about ?band . ?article schema:isPartOf <https://en.wikipedia.org/> . } LIMIT 1`,
    ].join(" ");
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    const res = await axios.get("https://query.wikidata.org/sparql", {
      params: { query, format: "json" },
      headers: {
        "User-Agent": userAgent,
        Accept: "application/sparql-results+json",
      },
      timeout: 5000,
    });
    const bindings = res.data?.results?.bindings || [];
    const url = bindings[0]?.article?.value || null;
    if (!url) {
      wikidataTitleCache.set(cacheKey, null);
      return null;
    }
    const slug = url.split("/").pop() || "";
    const title = decodeURIComponent(slug).replace(/_/g, " ").trim();
    const value = title || null;
    wikidataTitleCache.set(cacheKey, value);
    return value;
  } catch (e) {
    wikidataTitleCache.set(cacheKey, null);
    return null;
  }
}

async function wikipediaGetBioByTitle(title) {
  if (!title) return null;
  const cacheKey = `wp:v2:${title.toLowerCase()}`;
  const cached = wikiBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const urlTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    const res = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${urlTitle}`,
      { timeout: 5000, headers: { "User-Agent": userAgent } },
    );
    const extract = res.data?.extract || null;
    const isDisambiguation =
      res.data?.type === "disambiguation" || /may refer to/.test(extract || "");
    const value =
      typeof extract === "string" && extract.trim() && !isDisambiguation
        ? extract.trim()
        : null;
    wikiBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    wikiBioCache.set(cacheKey, null);
    return null;
  }
}

export async function wikipediaGetArtistBioByMbid(mbid) {
  const title = await wikidataGetWikipediaTitleByMbid(mbid);
  if (!title) return null;
  return wikipediaGetBioByTitle(title);
}

/**
 * Strip basic HTML tags and decode entities from a string (e.g. Last.fm bio).
 */
function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetch artist biography from Last.fm (artist.getInfo). Returns summary or content (HTML stripped).
 */
export async function lastfmGetArtistBio(mbid) {
  if (!mbid) return null;
  try {
    const data = await lastfmRequest("artist.getInfo", { mbid });
    const bio = data?.artist?.bio;
    if (!bio) return null;
    const summary =
      typeof bio.summary === "string" && bio.summary.trim()
        ? stripHtml(bio.summary.trim())
        : null;
    const content =
      typeof bio.content === "string" && bio.content.trim()
        ? stripHtml(bio.content.trim())
        : null;
    return summary || content || null;
  } catch (e) {
    return null;
  }
}

/**
 * Get artist biography: try Deezer first, then Last.fm. Returns string or null.
 */
export async function getArtistBio(artistName, mbid, deezerArtistId = null) {
  if (mbid) {
    const wikiBio = await wikipediaGetArtistBioByMbid(mbid);
    if (wikiBio) return wikiBio;
  }
  const deezerBio = deezerArtistId
    ? await deezerGetArtistBioById(deezerArtistId)
    : await deezerGetArtistBio(artistName);
  if (deezerBio) return deezerBio;
  if (mbid) {
    const lastfmBio = await lastfmGetArtistBio(mbid);
    if (lastfmBio) return lastfmBio;
  }
  return null;
}

export async function deezerSearchArtist(artistName) {
  const artist = await getDeezerArtist(artistName);
  if (!artist || !artist.imageUrl) return null;
  return artist;
}

export async function deezerGetArtistTopTracks(artistName) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];

    const topRes = await axios.get(
      `https://api.deezer.com/artist/${artist.id}/top`,
      { params: { limit: 5 }, timeout: 3000 },
    );
    const tracks = topRes.data?.data || [];
    return tracks
      .filter((t) => t.preview)
      .slice(0, 5)
      .map((t) => ({
        id: String(t.id),
        title: t.title,
        album: t.album?.title ?? null,
        preview_url: t.preview,
        duration_ms: (t.duration || 0) * 1000,
      }));
  } catch (e) {
    return [];
  }
}

export async function deezerGetArtistTopTracksById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  try {
    const topRes = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}/top`,
      { params: { limit: 5 }, timeout: 3000 },
    );
    const tracks = topRes.data?.data || [];
    return tracks
      .filter((t) => t.preview)
      .slice(0, 5)
      .map((t) => ({
        id: String(t.id),
        title: t.title,
        album: t.album?.title ?? null,
        preview_url: t.preview,
        duration_ms: (t.duration || 0) * 1000,
      }));
  } catch (e) {
    return [];
  }
}

const deezerAlbumCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 500,
});

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(
      /\s*[\(\[](deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4}).*[\)\]]/gi,
      "",
    )
    .trim();
}

const ALLOWED_PRIMARY_TYPES = new Set(["album", "ep", "single"]);

/**
 * One MusicBrainz call: fetch canonical release-groups for an artist.
 * Returns array of { id, title, "first-release-date", "primary-type", "secondary-types" }.
 */
export async function musicbrainzGetArtistReleaseGroups(mbid) {
  try {
    const raw = [];
    const limit = 100;
    let offset = 0;
    let totalCount;

    // Fetch all release-groups for the artist
    do {
      const data = await musicbrainzRequest("/release-group", {
        artist: mbid,
        limit,
        offset,
      });
      totalCount = data["release-group-count"] || 0;
      const batch = data["release-groups"] || [];
      raw.push(...batch);
      offset += limit;
    } while (offset < totalCount);

    const filtered = raw
      .filter(
        (rg) =>
          rg.id &&
          ALLOWED_PRIMARY_TYPES.has((rg["primary-type"] || "").toLowerCase()),
      )
      .map((rg) => ({
        id: rg.id,
        title: rg.title || "",
        "first-release-date": rg["first-release-date"] || null,
        "primary-type":
          rg["primary-type"] === "EP"
            ? "EP"
            : rg["primary-type"] === "Single"
              ? "Single"
              : "Album",
        "secondary-types": Array.isArray(rg["secondary-types"])
          ? rg["secondary-types"]
          : [],
      }))
      .sort((a, b) => {
        const dateA = a["first-release-date"] || "";
        const dateB = b["first-release-date"] || "";
        return dateB.localeCompare(dateA);
      });
    return filtered;
  } catch (e) {
    return [];
  }
}

/**
 * Enrich MusicBrainz release-groups with Deezer data: cover URL, fans count, and Deezer album ID for tracks.
 * Mutates and returns the same array (adds _coverUrl, fans, _deezerAlbumId when matched).
 */
export async function enrichReleaseGroupsWithDeezer(
  mbReleaseGroups,
  artistName,
  deezerArtistId = null,
) {
  if (!mbReleaseGroups?.length || !artistName) return mbReleaseGroups;
  try {
    const artist = deezerArtistId
      ? await getDeezerArtistById(deezerArtistId)
      : await getDeezerArtist(artistName);
    if (!artist) return mbReleaseGroups;

    const res = await axios.get(
      `https://api.deezer.com/artist/${artist.id}/albums`,
      { params: { limit: 100 }, timeout: 3000 },
    );
    const raw = res.data?.data || [];
    const allowed = ["album", "ep", "single"];
    const byKey = new Map();
    for (const a of raw) {
      const rt = (a.record_type || a.type || "album").toLowerCase();
      if (!allowed.includes(rt)) continue;
      const primaryType =
        rt === "ep" ? "EP" : rt === "single" ? "Single" : "Album";
      const title = a.title || "";
      const key = `${primaryType}:${normalizeTitle(title)}`;
      const fans = typeof a.fans === "number" ? a.fans : 0;
      const coverUrl = a.cover_big || a.cover_medium || a.cover || null;
      const existing = byKey.get(key);
      if (
        !existing ||
        fans > existing.fans ||
        (fans === existing.fans &&
          (a.release_date || "") < (existing.release_date || ""))
      ) {
        byKey.set(key, {
          id: a.id,
          fans,
          coverUrl,
          release_date: a.release_date || "",
        });
      }
    }

    for (const rg of mbReleaseGroups) {
      const key = `${rg["primary-type"]}:${normalizeTitle(rg.title)}`;
      const match = byKey.get(key);
      if (match) {
        rg._coverUrl = match.coverUrl;
        rg.fans = match.fans;
        rg._deezerAlbumId = match.id;
      }
    }
    return mbReleaseGroups;
  } catch (e) {
    return mbReleaseGroups;
  }
}

export async function enrichReleaseGroupsWithLastfm(
  mbReleaseGroups,
  artistName,
  artistMbid = null,
) {
  if (!mbReleaseGroups?.length || !artistName || !getLastfmApiKey())
    return mbReleaseGroups;
  try {
    const params = artistMbid
      ? { mbid: artistMbid, limit: 200 }
      : { artist: artistName, limit: 200 };
    const data = await lastfmRequest("artist.getTopAlbums", params);
    const raw = data?.topalbums?.album;
    const albums = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!albums.length) return mbReleaseGroups;

    const byTitle = new Map();
    for (const album of albums) {
      const title = album?.name || album?.title || "";
      if (!title) continue;
      const listeners = parseInt(album?.listeners || album?.playcount || 0, 10);
      if (!listeners) continue;
      const key = normalizeTitle(title);
      const existing = byTitle.get(key) || 0;
      if (listeners > existing) byTitle.set(key, listeners);
    }

    for (const rg of mbReleaseGroups) {
      rg.fans = 0;
      const key = normalizeTitle(rg.title);
      const listeners = byTitle.get(key);
      if (typeof listeners === "number") {
        rg.fans = listeners;
      }
    }
    return mbReleaseGroups;
  } catch (e) {
    return mbReleaseGroups;
  }
}

export async function deezerGetArtistAlbums(artistName) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];

    const cacheKey = `dz-albums:${artist.id}`;
    const cached = deezerAlbumCache.get(cacheKey);
    if (cached) return cached;

    const res = await axios.get(
      `https://api.deezer.com/artist/${artist.id}/albums`,
      { params: { limit: 100 }, timeout: 3000 },
    );
    const raw = res.data?.data || [];
    const allowed = ["album", "ep", "single"];
    const filtered = raw.filter((a) =>
      allowed.includes((a.record_type || a.type || "").toLowerCase()),
    );
    const mapped = filtered.map((a) => {
      const rt = (a.record_type || a.type || "album").toLowerCase();
      const primaryType =
        rt === "ep" ? "EP" : rt === "single" ? "Single" : "Album";
      const title = a.title || "";
      const releaseDate = a.release_date ? a.release_date.slice(0, 4) : null;
      const fans = typeof a.fans === "number" ? a.fans : 0;
      return {
        id: `dz-${a.id}`,
        title,
        "first-release-date": releaseDate,
        "primary-type": primaryType,
        "secondary-types": [],
        _coverUrl: a.cover_big || a.cover_medium || a.cover || null,
        _fans: fans,
        _normalizedTitle: normalizeTitle(title),
        _releaseDate: a.release_date || "",
      };
    });
    const byKey = new Map();
    for (const item of mapped) {
      const key = `${item["primary-type"]}:${item._normalizedTitle}`;
      const existing = byKey.get(key);
      if (
        !existing ||
        item._fans > existing._fans ||
        (item._fans === existing._fans &&
          item._releaseDate < existing._releaseDate)
      ) {
        byKey.set(key, item);
      }
    }
    const albums = Array.from(byKey.values()).map(
      ({ _fans, _normalizedTitle, _releaseDate, ...rest }) => ({
        ...rest,
        fans: _fans,
      }),
    );
    deezerAlbumCache.set(cacheKey, albums);
    return albums;
  } catch (e) {
    return [];
  }
}

export async function deezerGetAlbumTracks(deezerAlbumId) {
  const id = String(deezerAlbumId).replace(/^dz-/, "");
  if (!id || id === "dz") return [];
  try {
    const res = await axios.get(`https://api.deezer.com/album/${id}/tracks`, {
      timeout: 3000,
    });
    const raw = res.data?.data || [];
    return raw.map((t, i) => ({
      id: String(t.id),
      mbid: String(t.id),
      title: t.title || "",
      trackName: t.title || "",
      trackNumber: t.track_position || i + 1,
      position: t.track_position || i + 1,
      length: t.duration ? t.duration * 1000 : null,
      duration_ms: t.duration ? t.duration * 1000 : null,
      preview_url: t.preview || null,
    }));
  } catch (e) {
    return [];
  }
}

export async function lastfmGetArtistNameByMbid(mbid) {
  const data = await lastfmRequest("artist.getInfo", { mbid });
  const name = data?.artist?.name;
  return name && typeof name === "string" ? name.trim() : null;
}

export async function musicbrainzGetArtistNameByMbid(mbid) {
  if (!mbid) return null;
  try {
    const data = await musicbrainzRequest(`/artist/${mbid}`);
    const name = data?.name;
    return name && typeof name === "string" ? name.trim() : null;
  } catch (e) {
    return null;
  }
}

function normalizeArtistNameKey(artistName) {
  return String(artistName || "")
    .trim()
    .toLowerCase();
}

export function musicbrainzGetCachedArtistMbidByName(artistName) {
  const normalized = normalizeArtistNameKey(artistName);
  if (!normalized) return null;
  const cached = dbOps.getMusicbrainzArtistMbidCache(normalized);
  if (!cached?.updatedAt) return null;
  const ageMs = Date.now() - cached.updatedAt;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (ageMs < 0 || ageMs >= cacheTtl) return null;
  return cached.mbid || null;
}

export async function musicbrainzResolveArtistMbidByName(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  const normalized = normalizeArtistNameKey(rawName);
  const cached = dbOps.getMusicbrainzArtistMbidCache(normalized);
  const now = Date.now();
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  if (cached?.updatedAt) {
    const ageMs = now - cached.updatedAt;
    const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (ageMs >= 0 && ageMs < cacheTtl) {
      return cached.mbid || null;
    }
  }
  const queryName = rawName.replace(/"/g, '\\"');
  try {
    const data = await musicbrainzRequest("/artist", {
      query: `artist:"${queryName}"`,
      limit: 5,
    });
    const artists = Array.isArray(data?.artists) ? data.artists : [];
    const candidates = artists
      .map((artist) => ({
        id: artist.id,
        name: artist.name || "",
        type: artist.type || "",
        disambiguation: artist.disambiguation || "",
        score: parseInt(artist.score || 0),
        normalized: String(artist.name || "").toLowerCase(),
      }))
      .filter((artist) => artist.id);
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aExact = a.normalized === normalized ? 1 : 0;
      const bExact = b.normalized === normalized ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aPerson = a.type.toLowerCase() === "person" ? 1 : 0;
      const bPerson = b.type.toLowerCase() === "person" ? 1 : 0;
      if (aPerson !== bPerson) return bPerson - aPerson;
      const aDisambig = a.disambiguation ? 1 : 0;
      const bDisambig = b.disambiguation ? 1 : 0;
      if (aDisambig !== bDisambig) return bDisambig - aDisambig;
      if (a.score !== b.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
    const resolved = candidates[0]?.id || null;
    dbOps.setMusicbrainzArtistMbidCache(normalized, resolved);
    return resolved;
  } catch (e) {
    if (cached) {
      return cached.mbid || null;
    }
    return null;
  }
}

function normalizeArtistAlbumKey(artistName, albumName) {
  const a = String(artistName || "")
    .trim()
    .toLowerCase();
  const b = String(albumName || "")
    .trim()
    .toLowerCase();
  return `aa:${a}\0${b}`;
}

export async function resolveDeezerAlbumToMbid(
  artistName,
  albumName,
  deezerAlbumId,
) {
  const dzKey = `dz:${String(deezerAlbumId || "").replace(/^dz-/, "")}`;
  const aaKey = normalizeArtistAlbumKey(artistName, albumName);
  const cached =
    dbOps.getDeezerMbidCache(dzKey) || dbOps.getDeezerMbidCache(aaKey);
  if (cached) return cached;

  const artist = String(artistName || "")
    .trim()
    .replace(/"/g, '\\"');
  const album = String(albumName || "")
    .trim()
    .replace(/"/g, '\\"');
  if (!artist || !album) return null;

  try {
    const data = await musicbrainzRequest("/release-group", {
      query: `artist:"${artist}" AND releasegroup:"${album}"`,
      limit: 1,
    });
    const id = data?.["release-groups"]?.[0]?.id;
    if (!id) return null;
    dbOps.setDeezerMbidCache(dzKey, id);
    dbOps.setDeezerMbidCache(aaKey, id);
    return id;
  } catch (e) {
    return null;
  }
}

export function clearApiCaches() {
  mbCache.flushAll();
  lastfmCache.flushAll();
  deezerArtistCache.flushAll();
  deezerAlbumCache.flushAll();
  deezerBioCache.flushAll();
}
