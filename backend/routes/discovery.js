import express from "express";
import {
  getDiscoveryCache,
  updateDiscoveryCache,
} from "../services/discoveryService.js";
import {
  lastfmRequest,
  getLastfmApiKey,
  clearApiCaches,
} from "../services/apiClients.js";
import { libraryManager } from "../services/libraryManager.js";
import { dbOps } from "../config/db-helpers.js";
import { imagePrefetchService } from "../services/imagePrefetchService.js";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";

const router = express.Router();

const pendingTagRequests = new Map();
const pendingTagSuggestRequest = { promise: null, expiry: 0 };
const DISCOVERY_STALE_MS = 6 * 60 * 60 * 1000;
const DISCOVERY_REVALIDATE_COOLDOWN_MS = 60 * 1000;
let lastDiscoveryRevalidateAt = 0;
const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeTextList = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const normalized = String(entry || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const normalizeBlocklist = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const rawArtists = Array.isArray(source.artists) ? source.artists : [];
  const seenArtistKeys = new Set();
  const artists = [];
  for (const entry of rawArtists) {
    if (entry == null) continue;
    let mbid = null;
    let name = null;
    if (typeof entry === "string") {
      const normalized = entry.trim();
      if (!normalized) continue;
      if (MBID_REGEX.test(normalized)) {
        mbid = normalized.toLowerCase();
      } else {
        name = normalized;
      }
    } else if (typeof entry === "object") {
      const rawMbid = String(
        entry.mbid || entry.artistId || entry.id || "",
      ).trim();
      if (rawMbid && MBID_REGEX.test(rawMbid)) {
        mbid = rawMbid.toLowerCase();
      }
      const rawName = String(entry.name || entry.artistName || "").trim();
      if (rawName) {
        name = rawName;
      }
    }
    if (!mbid && !name) continue;
    const key = mbid
      ? `mbid:${mbid}`
      : `name:${String(name).trim().toLowerCase()}`;
    if (seenArtistKeys.has(key)) continue;
    seenArtistKeys.add(key);
    artists.push({ mbid, name: name || null });
  }
  return {
    artists,
    tags: normalizeTextList(source.tags),
  };
};

const getStoredBlocklist = () => {
  const settings = dbOps.getSettings();
  return normalizeBlocklist(settings.blocklist);
};

const updateStoredBlocklist = (updates) => {
  const currentSettings = dbOps.getSettings();
  const nextBlocklist = normalizeBlocklist({
    ...normalizeBlocklist(currentSettings.blocklist),
    ...(updates && typeof updates === "object" ? updates : {}),
  });
  dbOps.updateSettings({
    ...currentSettings,
    blocklist: nextBlocklist,
  });
  return nextBlocklist;
};

const isArtistBlocked = (artist, artistBlockSet) => {
  if (!artist || !artistBlockSet) return false;
  const mbids = [artist?.id, artist?.mbid, artist?.foreignArtistId]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter((value) => MBID_REGEX.test(value));
  if (mbids.some((mbid) => artistBlockSet.mbids.has(mbid))) return true;
  const names = [artist?.name, artist?.artistName]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  return names.some((name) => artistBlockSet.names.has(name));
};

const hasBlockedTag = (artist, tagBlockSet) => {
  if (!artist || !tagBlockSet || tagBlockSet.size === 0) return false;
  const tags = Array.isArray(artist.tags) ? artist.tags : [];
  return tags.some((tag) =>
    tagBlockSet.has(
      String(tag || "")
        .trim()
        .toLowerCase(),
    ),
  );
};

const applyBlocklistToArtistCollection = (artists, blocklist) => {
  const list = Array.isArray(artists) ? artists : [];
  if (list.length === 0) return [];
  const artistEntries = Array.isArray(blocklist.artists)
    ? blocklist.artists
    : [];
  const artistBlockSet = {
    mbids: new Set(
      artistEntries
        .map((entry) =>
          String(entry?.mbid || "")
            .trim()
            .toLowerCase(),
        )
        .filter((value) => MBID_REGEX.test(value)),
    ),
    names: new Set(
      artistEntries
        .map((entry) =>
          String(entry?.name || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  };
  const tagBlockSet = new Set(blocklist.tags || []);
  return list.filter(
    (artist) =>
      !isArtistBlocked(artist, artistBlockSet) &&
      !hasBlockedTag(artist, tagBlockSet),
  );
};

const applyBlocklistToTagList = (tags, blocklist) => {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return [];
  const blockedTags = new Set(blocklist.tags || []);
  if (blockedTags.size === 0) return list;
  return list.filter(
    (tag) =>
      !blockedTags.has(
        String(tag || "")
          .trim()
          .toLowerCase(),
      ),
  );
};

router.post("/refresh", requireAuth, requireAdmin, (req, res) => {
  const discoveryCache = getDiscoveryCache();
  if (discoveryCache.isUpdating) {
    return res.status(409).json({
      message: "Discovery update already in progress",
      isUpdating: true,
    });
  }
  updateDiscoveryCache();
  res.json({
    message: "Discovery update started",
    isUpdating: true,
  });
});

router.post("/clear", requireAuth, requireAdmin, async (req, res) => {
  dbOps.clearImages();
  clearApiCaches();
  res.json({ message: "Image cache cleared" });
});

router.post("/clear-discovery", requireAuth, requireAdmin, async (req, res) => {
  dbOps.updateDiscoveryCache({
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
    lastUpdated: null,
  });
  const discoveryCache = getDiscoveryCache();
  Object.assign(discoveryCache, {
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
    lastUpdated: null,
    isUpdating: false,
  });
  pendingTagRequests.clear();
  pendingTagSuggestRequest.promise = null;
  pendingTagSuggestRequest.expiry = 0;
  res.json({ message: "Discovery cache cleared" });
});

router.get("/", requireAuth, async (req, res) => {
  const hasLastfmKey = !!getLastfmApiKey();
  const settings = dbOps.getSettings();
  const lastfmUsername = settings.integrations?.lastfm?.username || null;
  const hasLastfmUser = hasLastfmKey && lastfmUsername;
  const libraryArtists = await libraryManager.getAllArtists();
  const hasArtists = libraryArtists.length > 0;

  if (!hasLastfmKey && !hasArtists) {
    const dbData = dbOps.getDiscoveryCache();
    if (
      dbData.recommendations?.length > 0 ||
      dbData.globalTop?.length > 0 ||
      dbData.topGenres?.length > 0 ||
      dbData.basedOn?.length > 0
    ) {
      dbOps.updateDiscoveryCache({
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
      });
    }

    const discoveryCache = getDiscoveryCache();
    Object.assign(discoveryCache, {
      recommendations: [],
      globalTop: [],
      basedOn: [],
      topTags: [],
      topGenres: [],
      lastUpdated: null,
      isUpdating: false,
    });

    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      recommendations: [],
      globalTop: [],
      basedOn: [],
      topTags: [],
      topGenres: [],
      lastUpdated: null,
      isUpdating: false,
      configured: false,
    });
  }

  const discoveryCache = getDiscoveryCache();
  const dbData = dbOps.getDiscoveryCache();

  const hasData =
    dbData.recommendations?.length > 0 ||
    dbData.globalTop?.length > 0 ||
    dbData.topGenres?.length > 0 ||
    discoveryCache.recommendations?.length > 0 ||
    discoveryCache.globalTop?.length > 0 ||
    discoveryCache.topGenres?.length > 0;

  let isUpdating = discoveryCache.isUpdating || false;

  if (!hasData && !isUpdating) {
    lastDiscoveryRevalidateAt = Date.now();
    updateDiscoveryCache().catch((err) => {
      console.error("[Discover] Lazy discovery refresh failed:", err.message);
    });
    isUpdating = true;
  }

  const dbHasData =
    dbData.recommendations?.length > 0 ||
    dbData.globalTop?.length > 0 ||
    dbData.topGenres?.length > 0;
  const cacheHasData =
    discoveryCache.recommendations?.length > 0 ||
    discoveryCache.globalTop?.length > 0 ||
    discoveryCache.topGenres?.length > 0;

  let recommendations, globalTop, basedOn, topTags, topGenres, lastUpdated;

  if (dbHasData) {
    recommendations = dbData.recommendations || [];
    globalTop = dbData.globalTop || [];
    basedOn = dbData.basedOn || [];
    topTags = dbData.topTags || [];
    topGenres = dbData.topGenres || [];
    lastUpdated = dbData.lastUpdated || null;
  } else if (cacheHasData) {
    recommendations = discoveryCache.recommendations || [];
    globalTop = discoveryCache.globalTop || [];
    basedOn = discoveryCache.basedOn || [];
    topTags = discoveryCache.topTags || [];
    topGenres = discoveryCache.topGenres || [];
    lastUpdated = discoveryCache.lastUpdated || null;
  } else {
    recommendations = [];
    globalTop = [];
    basedOn = [];
    topTags = [];
    topGenres = [];
    lastUpdated = null;
  }

  const existingArtistIds = new Set(
    libraryArtists
      .map((a) => a.mbid || a.foreignArtistId || a.id)
      .filter(Boolean),
  );

  recommendations = recommendations.filter(
    (artist) => !existingArtistIds.has(artist.id),
  );
  globalTop = globalTop.filter((artist) => !existingArtistIds.has(artist.id));
  const blocklist = getStoredBlocklist();
  recommendations = applyBlocklistToArtistCollection(
    recommendations,
    blocklist,
  );
  globalTop = applyBlocklistToArtistCollection(globalTop, blocklist);
  topTags = applyBlocklistToTagList(topTags, blocklist);
  topGenres = applyBlocklistToTagList(topGenres, blocklist);

  if (
    recommendations.length > 0 ||
    globalTop.length > 0 ||
    topGenres.length > 0
  ) {
    Object.assign(discoveryCache, {
      recommendations,
      globalTop,
      basedOn,
      topTags,
      topGenres,
      lastUpdated,
      isUpdating: false,
    });
  }

  const parsedLastUpdated = lastUpdated ? new Date(lastUpdated).getTime() : 0;
  const isStale =
    Number.isFinite(parsedLastUpdated) &&
    parsedLastUpdated > 0 &&
    Date.now() - parsedLastUpdated > DISCOVERY_STALE_MS;

  if (
    isStale &&
    !isUpdating &&
    Date.now() - lastDiscoveryRevalidateAt > DISCOVERY_REVALIDATE_COOLDOWN_MS
  ) {
    lastDiscoveryRevalidateAt = Date.now();
    updateDiscoveryCache().catch((err) => {
      console.error("[Discover] SWR revalidation failed:", err.message);
    });
    isUpdating = true;
  }

  if (recommendations.length > 0 || globalTop.length > 0) {
    imagePrefetchService
      .prefetchDiscoveryImages({
        recommendations,
        globalTop,
      })
      .catch(() => {});
  }

  if (recommendations.length > 0 || globalTop.length > 0) {
    res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
  } else if (isUpdating) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  } else {
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  }

  res.json({
    recommendations,
    globalTop,
    basedOn,
    topTags,
    topGenres,
    lastUpdated,
    isUpdating,
    stale: isStale,
    configured: true,
  });
});

router.get("/related", (req, res) => {
  const discoveryCache = getDiscoveryCache();
  res.json({
    recommendations: discoveryCache.recommendations,
    basedOn: discoveryCache.basedOn,
    total: discoveryCache.recommendations.length,
  });
});

router.get("/similar", (req, res) => {
  const discoveryCache = getDiscoveryCache();
  res.json({
    topTags: discoveryCache.topTags,
    topGenres: discoveryCache.topGenres,
    basedOn: discoveryCache.basedOn,
    message: "Served from cache",
  });
});

router.get("/tags", async (req, res) => {
  try {
    const { q = "", limit = 10 } = req.query;
    const limitInt = Math.min(parseInt(limit) || 10, 20);
    const prefix = String(q).trim().toLowerCase();
    let tagNames = [];
    if (getLastfmApiKey()) {
      let data;
      const now = Date.now();
      if (
        pendingTagSuggestRequest.promise &&
        pendingTagSuggestRequest.expiry > now
      ) {
        data = await pendingTagSuggestRequest.promise;
      } else {
        const fetchPromise = lastfmRequest("chart.getTopTags", { limit: 100 });
        pendingTagSuggestRequest.promise = fetchPromise;
        pendingTagSuggestRequest.expiry = now + 60000;
        data = await fetchPromise;
      }
      if (data?.tags?.tag) {
        const tags = Array.isArray(data.tags.tag)
          ? data.tags.tag
          : [data.tags.tag];
        tagNames = tags
          .map((t) => (t.name != null ? String(t.name).trim() : ""))
          .filter(Boolean);
      }
    }
    if (tagNames.length === 0) {
      const discoveryCache = getDiscoveryCache();
      const cached = [
        ...(discoveryCache.topTags || []),
        ...(discoveryCache.topGenres || []),
      ]
        .map((t) => (t != null ? String(t).trim() : ""))
        .filter(Boolean);
      tagNames = [...new Set(cached)];
    }
    const blocklist = getStoredBlocklist();
    const blockedTags = new Set(blocklist.tags || []);
    const seen = new Set();
    const filtered = tagNames.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      if (blockedTags.has(key)) return false;
      if (prefix && !key.startsWith(prefix)) return false;
      seen.add(key);
      return true;
    });
    res.json({ tags: filtered.slice(0, limitInt) });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch tag suggestions",
      message: error.message,
    });
  }
});

router.get("/by-tag", async (req, res) => {
  try {
    const { tag, limit = 24, offset = 0, includeLibrary, scope } = req.query;

    if (!tag) {
      return res.status(400).json({ error: "Tag parameter is required" });
    }

    const limitInt = Math.min(parseInt(limit) || 24, 50);
    const offsetInt = parseInt(offset) || 0;
    const page = Math.floor(offsetInt / limitInt) + 1;
    const includeLibraryFlag =
      includeLibrary === "true" || includeLibrary === "1";
    const scopeValue =
      scope === "all" || includeLibraryFlag ? "all" : "recommended";
    const cacheKey = `tag:${tag.toLowerCase()}:${limitInt}:${page}:${scopeValue}`;
    const blocklist = getStoredBlocklist();
    const blockedTags = new Set(blocklist.tags || []);
    if (blockedTags.has(String(tag).trim().toLowerCase())) {
      return res.json({
        recommendations: [],
        tag,
        total: 0,
        offset: offsetInt,
      });
    }

    let recommendations = [];
    if (scopeValue === "all") {
      if (getLastfmApiKey()) {
        try {
          let data;
          if (pendingTagRequests.has(cacheKey)) {
            data = await pendingTagRequests.get(cacheKey);
          } else {
            const fetchPromise = lastfmRequest("tag.getTopArtists", {
              tag,
              limit: limitInt,
              page,
            });
            pendingTagRequests.set(cacheKey, fetchPromise);
            try {
              data = await fetchPromise;
            } finally {
              pendingTagRequests.delete(cacheKey);
            }
          }

          if (data?.topartists?.artist) {
            const artists = Array.isArray(data.topartists.artist)
              ? data.topartists.artist
              : [data.topartists.artist];

            recommendations = artists
              .map((artist) => {
                let imageUrl = null;
                if (artist.image && Array.isArray(artist.image)) {
                  const img =
                    artist.image.find((i) => i.size === "extralarge") ||
                    artist.image.find((i) => i.size === "large") ||
                    artist.image.slice(-1)[0];
                  if (
                    img &&
                    img["#text"] &&
                    !img["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
                  ) {
                    imageUrl = img["#text"];
                  }
                }

                return {
                  id: artist.mbid,
                  name: artist.name,
                  sortName: artist.name,
                  type: "Artist",
                  tags: [tag],
                  image: imageUrl,
                };
              })
              .filter((a) => a.id);
            recommendations = applyBlocklistToArtistCollection(
              recommendations,
              blocklist,
            );
          }
        } catch (err) {
          console.error("Last.fm tag search failed:", err.message);
        }
      }
    } else {
      const discoveryCache = getDiscoveryCache();
      const tagLower = String(tag).trim().toLowerCase();
      const matches = (discoveryCache.recommendations || []).filter(
        (artist) => {
          const tags = Array.isArray(artist.tags) ? artist.tags : [];
          return tags.some((t) => String(t).toLowerCase() === tagLower);
        },
      );
      const filteredMatches = applyBlocklistToArtistCollection(
        matches,
        blocklist,
      );
      recommendations = filteredMatches.slice(offsetInt, offsetInt + limitInt);
      return res.json({
        recommendations,
        tag,
        total: filteredMatches.length,
        offset: offsetInt,
      });
    }

    res.json({
      recommendations,
      tag,
      total: recommendations.length,
      offset: offsetInt,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to search by tag",
      message: error.message,
    });
  }
});

router.get("/blocklist", requireAuth, (req, res) => {
  res.json(getStoredBlocklist());
});

router.put("/blocklist", requireAuth, (req, res) => {
  try {
    const updates = req.body || {};
    const blocklist = updateStoredBlocklist({
      artists: updates.artists,
      tags: updates.tags,
    });
    res.json({
      success: true,
      blocklist,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update blocklist",
      message: error.message,
    });
  }
});

router.post("/blocklist/reset", requireAuth, (req, res) => {
  const blocklist = updateStoredBlocklist({
    artists: [],
    tags: [],
  });
  res.json({
    success: true,
    blocklist,
  });
});

router.get("/preferences", requireAuth, (req, res) => {
  const blocklist = getStoredBlocklist();
  res.json({
    excludedGenres: blocklist.tags,
    excludedTags: blocklist.tags,
    excludedArtists: blocklist.artists.map((artist) => ({
      artistId: artist.mbid || artist.name,
      artistName: artist.name || artist.mbid || "",
    })),
    minPopularity: 0,
    maxRecommendations: 50,
    includeFromLastfm: true,
    includeFromLibrary: true,
    includeTrending: true,
  });
});

router.post("/preferences", requireAuth, (req, res) => {
  try {
    const updates = req.body || {};
    const artists = Array.isArray(updates.excludedArtists)
      ? updates.excludedArtists.map(
          (entry) => entry?.artistName || entry?.artistId || entry,
        )
      : undefined;
    const tags = [
      ...(Array.isArray(updates.excludedGenres) ? updates.excludedGenres : []),
      ...(Array.isArray(updates.excludedTags) ? updates.excludedTags : []),
    ];
    const blocklist = updateStoredBlocklist({
      artists,
      tags: tags.length > 0 ? tags : undefined,
    });
    res.json({
      success: true,
      preferences: {
        excludedGenres: blocklist.tags,
        excludedTags: blocklist.tags,
        excludedArtists: blocklist.artists.map((artist) => ({
          artistId: artist.mbid || artist.name,
          artistName: artist.name || artist.mbid || "",
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update preferences",
      message: error.message,
    });
  }
});

router.post("/preferences/reset", requireAuth, (req, res) => {
  const blocklist = updateStoredBlocklist({
    artists: [],
    tags: [],
  });
  res.json({
    success: true,
    preferences: {
      excludedGenres: blocklist.tags,
      excludedTags: blocklist.tags,
      excludedArtists: [],
    },
  });
});

router.post("/preferences/exclude-genre", requireAuth, (req, res) => {
  try {
    const { genre } = req.body;
    if (!genre) {
      return res.status(400).json({ error: "genre is required" });
    }
    const blocklist = updateStoredBlocklist({
      tags: [...getStoredBlocklist().tags, genre],
    });

    res.json({
      success: true,
      excludedGenres: blocklist.tags,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to exclude genre",
      message: error.message,
    });
  }
});

router.delete("/preferences/exclude-genre/:genre", requireAuth, (req, res) => {
  try {
    const { genre } = req.params;
    const current = getStoredBlocklist();
    const blocklist = updateStoredBlocklist({
      tags: current.tags.filter((g) => g !== String(genre).toLowerCase()),
    });

    res.json({
      success: true,
      excludedGenres: blocklist.tags,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to remove excluded genre",
      message: error.message,
    });
  }
});

router.post("/preferences/exclude-artist", requireAuth, (req, res) => {
  try {
    const { artistId, artistName } = req.body;
    const target = String(artistName || artistId || "").trim();
    if (!target) {
      return res.status(400).json({ error: "artistId is required" });
    }
    const blocklist = updateStoredBlocklist({
      artists: [...getStoredBlocklist().artists, target],
    });

    res.json({
      success: true,
      excludedArtists: blocklist.artists.map((artist) => ({
        artistId: artist.mbid || artist.name,
        artistName: artist.name || artist.mbid || "",
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to exclude artist",
      message: error.message,
    });
  }
});

router.delete(
  "/preferences/exclude-artist/:artistId",
  requireAuth,
  (req, res) => {
    try {
      const { artistId } = req.params;
      const current = getStoredBlocklist();
      const target = String(artistId || "")
        .trim()
        .toLowerCase();
      const blocklist = updateStoredBlocklist({
        artists: current.artists.filter((artist) => {
          const artistMbid = String(artist?.mbid || "")
            .trim()
            .toLowerCase();
          const artistName = String(artist?.name || "")
            .trim()
            .toLowerCase();
          return artistMbid !== target && artistName !== target;
        }),
      });

      res.json({
        success: true,
        excludedArtists: blocklist.artists.map((artist) => ({
          artistId: artist.mbid || artist.name,
          artistName: artist.name || artist.mbid || "",
        })),
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to remove excluded artist",
        message: error.message,
      });
    }
  },
);

router.get("/filtered", async (req, res) => {
  try {
    const discoveryCache = getDiscoveryCache();
    let recommendations = discoveryCache.recommendations || [];
    let globalTop = discoveryCache.globalTop || [];
    const blocklist = getStoredBlocklist();

    const libraryArtists = await libraryManager.getAllArtists();
    const existingArtistIds = new Set(
      libraryArtists
        .map((a) => a.mbid || a.foreignArtistId || a.id)
        .filter(Boolean),
    );

    recommendations = recommendations.filter(
      (artist) => !existingArtistIds.has(artist.id),
    );
    globalTop = globalTop.filter((artist) => !existingArtistIds.has(artist.id));

    recommendations = applyBlocklistToArtistCollection(
      recommendations,
      blocklist,
    );
    globalTop = applyBlocklistToArtistCollection(globalTop, blocklist);

    res.json({
      recommendations,
      globalTop,
      topTags: applyBlocklistToTagList(discoveryCache.topTags || [], blocklist),
      topGenres: applyBlocklistToTagList(
        discoveryCache.topGenres || [],
        blocklist,
      ),
      basedOn: discoveryCache.basedOn || [],
      lastUpdated: discoveryCache.lastUpdated,
      preferencesApplied: true,
      excludedCount: {
        genres: blocklist.tags.length,
        artists: blocklist.artists.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get filtered discovery",
      message: error.message,
    });
  }
});

export default router;
