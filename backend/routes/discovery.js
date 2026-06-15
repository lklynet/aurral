import express from "express";
import {
  getDiscoveryCache,
  getDiscoveryUpdateStatus,
  getDiscoveryPlaylistBuildStatus,
  requestUserDiscoveryRefresh,
  getUserDiscoveryCacheStaleness,
  isGlobalDiscoveryRefreshInProgress,
  getDiscoveryAutoRefreshHours,
  getDiscoveryMode,
  getDiscoveryFeedback,
  addDiscoveryFeedback,
  removeDiscoveryFeedback,
  resetDiscoveryFeedback,
  rerankCachedRecommendations,
  getLocalDiscoveryPreferences,
} from "../services/discoveryService.js";
import {
  lastfmRequest,
  getLastfmApiKey,
  getTicketmasterApiKey,
  clearApiCaches,
} from "../services/apiClients.js";
import { libraryManager } from "../services/libraryManager.js";
import { dbOps, userOps } from "../config/db-helpers.js";
import { imagePrefetchService } from "../services/imagePrefetchService.js";
import { hydrateArtistImages } from "../services/artistImageHydration.js";
import {
  buildImageProxyUrl,
  clearImageProxyCache,
} from "../services/imageProxyService.js";
import { defaultDiscoveryPreferences } from "../config/constants.js";
import {
  requireAuth,
  requireAdmin,
  requirePermission,
} from "../middleware/requirePermission.js";
import { verifyTokenAuth } from "../middleware/auth.js";
import { noCache } from "../middleware/cache.js";
import { getNearbyShows } from "../services/nearbyShowsService.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
  hasListenHistoryProfile,
} from "../services/listeningHistory.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  buildListenbrainzFallbackDiscovery,
  getDiscoveryCapabilities,
  getFallbackTagNames,
  searchFallbackGenreArtists,
} from "../services/listenbrainzDiscoveryFallback.js";
import { requestDiscoveryRefresh } from "../services/discoveryRefreshScheduler.js";

const router = express.Router();

const pendingTagRequests = new Map();
const pendingTagSuggestRequest = { promise: null, expiry: 0 };
const DISCOVERY_REVALIDATE_COOLDOWN_MS = 60 * 1000;
let lastDiscoveryRevalidateAt = 0;

let discoveryPreferences = { ...defaultDiscoveryPreferences };

const getDiscoveryStaleMs = () =>
  getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;

const buildArtistKeySet = (artists) => {
  const set = new Set();
  for (const artist of Array.isArray(artists) ? artists : []) {
    [
      artist?.id,
      artist?.mbid,
      artist?.foreignArtistId,
      artist?.name,
      artist?.artistName,
    ].forEach((value) => {
      const key = String(value || "")
        .trim()
        .toLowerCase();
      if (key) set.add(key);
    });
  }
  return set;
};

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

router.post("/refresh", requireAuth, requireAdmin, (req, res) => {
  const result = requestDiscoveryRefresh({
    reason: "manual",
    force: true,
  });
  if (!result.enqueued) {
    return res.status(409).json({
      message: "Discovery update already in progress",
      isUpdating: true,
      reason: result.reason,
    });
  }
  res.json({
    message: "Discovery update started",
    isUpdating: true,
  });
});

router.post("/clear", requireAuth, requireAdmin, async (req, res) => {
  dbOps.clearImages();
  clearImageProxyCache();
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
    fallbackGenres: [],
    provider: DISCOVERY_PROVIDER_LASTFM,
    lastUpdated: null,
  });
  const discoveryCache = getDiscoveryCache();
  Object.assign(discoveryCache, {
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
    fallbackGenres: [],
    provider: DISCOVERY_PROVIDER_LASTFM,
    capabilities: getDiscoveryCapabilities(true),
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
  const libraryArtists = await libraryManager.getAllArtists();

  const reqUser = userOps.getUserById(req.user.id);
  const listenHistoryProfile = getListenHistoryProfile(reqUser || {});
  const userCacheNamespace =
    getListenHistoryCacheNamespace(listenHistoryProfile);
  const effectiveCacheNamespace = hasLastfmKey ? userCacheNamespace : null;

  if (
    hasListenHistoryProfile(listenHistoryProfile) &&
    hasLastfmKey &&
    !isGlobalDiscoveryRefreshInProgress()
  ) {
    const staleness = getUserDiscoveryCacheStaleness(userCacheNamespace);
    if (staleness > getDiscoveryStaleMs()) {
      requestUserDiscoveryRefresh(listenHistoryProfile).catch((err) => {
        console.error(
          `[Discover] On-demand refresh for ${listenHistoryProfile.listenHistoryProvider}:${listenHistoryProfile.listenHistoryUsername} failed:`,
          err.message,
        );
      });
    }
  }

  let discoveryCache = getDiscoveryCache(effectiveCacheNamespace);

  const hasData =
    discoveryCache.recommendations?.length > 0 ||
    discoveryCache.globalTop?.length > 0 ||
    discoveryCache.topGenres?.length > 0 ||
    discoveryCache.fallbackGenres?.length > 0;
  const hasCompletedRefresh =
    !!discoveryCache.lastUpdated &&
    (discoveryCache.recommendations?.length > 0 ||
      discoveryCache.globalTop?.length > 0 ||
      discoveryCache.topGenres?.length > 0 ||
      discoveryCache.fallbackGenres?.length > 0);

  let isUpdating = discoveryCache.isUpdating || false;

  if (
    !hasLastfmKey &&
    (!hasData ||
      discoveryCache.provider !== DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK)
  ) {
    const fallbackData = await buildListenbrainzFallbackDiscovery({
      existingArtistKeys: buildArtistKeySet(libraryArtists),
    });
    dbOps.updateDiscoveryCache(fallbackData);
    Object.assign(getDiscoveryCache(), fallbackData, { isUpdating: false });
    discoveryCache = getDiscoveryCache(effectiveCacheNamespace);
    isUpdating = false;
  } else if (!hasData && !hasCompletedRefresh && !isUpdating) {
    lastDiscoveryRevalidateAt = Date.now();
    const lazyRefresh = requestDiscoveryRefresh({ reason: "lazy" });
    if (lazyRefresh.enqueued) {
      isUpdating = true;
    }
  }

  let {
    recommendations,
    globalTop,
    basedOn,
    topTags,
    topGenres,
    fallbackGenres = [],
    discoverPlaylists = [],
    lastUpdated,
    provider,
    capabilities,
  } = discoveryCache;
  provider = hasLastfmKey
    ? DISCOVERY_PROVIDER_LASTFM
    : provider || DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK;
  capabilities = capabilities || getDiscoveryCapabilities(hasLastfmKey);
  const feedback = getDiscoveryFeedback(req.user?.id || "global");
  const discoveryMode = getDiscoveryMode();

  const existingArtistIds = new Set(
    libraryArtists
      .map((a) => a.mbid || a.foreignArtistId || a.id)
      .filter(Boolean),
  );

  recommendations = recommendations.filter(
    (artist) => !existingArtistIds.has(artist.id),
  );
  globalTop = globalTop.filter((artist) => !existingArtistIds.has(artist.id));
  recommendations = await hydrateArtistImages(recommendations, {
    limit: Math.min(recommendations.length, 36),
    batchSize: 8,
    delayMs: 10,
  });
  globalTop = await hydrateArtistImages(globalTop, {
    limit: Math.min(globalTop.length, 36),
    batchSize: 8,
    delayMs: 10,
  });
  basedOn = await hydrateArtistImages(basedOn, {
    limit: Math.min(basedOn.length, 24),
    batchSize: 6,
    delayMs: 10,
  });
  if (Array.isArray(fallbackGenres) && fallbackGenres.length > 0) {
    for (const section of fallbackGenres) {
      if (!Array.isArray(section?.artists) || section.artists.length === 0) {
        continue;
      }
      section.artists = await hydrateArtistImages(section.artists, {
        limit: Math.min(section.artists.length, 24),
        batchSize: 6,
        delayMs: 10,
      });
    }
  }

  recommendations = rerankCachedRecommendations({
    recommendations,
    feedback,
    discoveryMode,
  });

  const parsedLastUpdated = lastUpdated ? new Date(lastUpdated).getTime() : 0;
  const isStale =
    Number.isFinite(parsedLastUpdated) &&
    parsedLastUpdated > 0 &&
    Date.now() - parsedLastUpdated > getDiscoveryStaleMs();

  if (
    isStale &&
    !isUpdating &&
    !hasListenHistoryProfile(listenHistoryProfile) &&
    Date.now() - lastDiscoveryRevalidateAt > DISCOVERY_REVALIDATE_COOLDOWN_MS
  ) {
    lastDiscoveryRevalidateAt = Date.now();
    const staleRefresh = requestDiscoveryRefresh({ reason: "stale" });
    if (staleRefresh.enqueued) {
      isUpdating = true;
    }
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
    res.set(
      "Cache-Control",
      "private, max-age=120, stale-while-revalidate=300",
    );
  } else if (isUpdating) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  } else {
    res.set("Cache-Control", "private, max-age=30, stale-while-revalidate=120");
  }

  const { annotateDiscoverPlaylistsForUser } =
    await import("../services/discoverPlaylistService.js");
  const playlists = annotateDiscoverPlaylistsForUser(
    discoverPlaylists,
    req.user,
  ).filter((playlist) => playlist.trackCount > 0);

  const playlistBuildStatus =
    getDiscoveryPlaylistBuildStatus(effectiveCacheNamespace);

  res.json({
    recommendations,
    globalTop,
    basedOn,
    topTags,
    topGenres,
    fallbackGenres,
    discoverPlaylists: playlists,
    lastUpdated,
    isUpdating,
    ...(isUpdating ? getDiscoveryUpdateStatus() : {}),
    playlistsUpdating: playlistBuildStatus.playlistsUpdating,
    ...(playlistBuildStatus.playlistsUpdating
      ? {
          playlistsUpdateMessage: playlistBuildStatus.playlistsUpdateMessage,
        }
      : {}),
    stale: isStale,
    configured: true,
    provider,
    capabilities,
    discoveryMode,
  });
});

router.get("/artwork/:presetId", noCache, async (req, res) => {
  if (!verifyTokenAuth(req)) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication required",
    });
  }

  try {
    const { ensureDiscoverArtworkForPreset } =
      await import("../services/discoverPlaylistArtworkService.js");
    const artwork = await ensureDiscoverArtworkForPreset(req.params.presetId, {
      user: req.user,
    });
    if (!artwork) {
      return res.status(404).json({ error: "Artwork not found" });
    }
    res.type(artwork.contentType);
    res.sendFile(artwork.safePath);
  } catch (error) {
    res.status(500).json({
      error: "Failed to load artwork",
      message: error.message,
    });
  }
});

const handleDiscoverAdoptError = (res, error, fallbackError) => {
  if (error?.statusCode === 400) {
    return res.status(400).json({
      error: error.error || "Bad Request",
      message: error.message,
    });
  }
  if (error?.statusCode === 404) {
    return res.status(404).json({
      error: error.error || "Playlist preview not available",
      message: error.message,
    });
  }
  if (error?.code === "FLOW_NAME_CONFLICT") {
    return res.status(400).json({
      error: "Flow name already exists",
      message: error.message,
    });
  }
  if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
    return res.status(400).json({
      error: "Shared playlist name already exists",
      message: error.message,
    });
  }
  return res.status(500).json({
    error: fallbackError,
    message: error.message,
  });
};

router.post(
  "/playlists/adopt",
  requireAuth,
  requirePermission("accessFlow"),
  async (req, res) => {
    try {
      const presetId = String(req.body?.presetId || "").trim();
      if (!presetId) {
        return res.status(400).json({ error: "presetId is required" });
      }

      const { slskdClient } = await import("../services/slskdClient.js");
      if (!slskdClient.isConfigured()) {
        return res.status(400).json({ error: "slskd not configured" });
      }

      const { adoptDiscoverPresetAsFlow } =
        await import("../services/discoverPlaylistAdoptService.js");
      const result = await adoptDiscoverPresetAsFlow(req.user, presetId);
      res.json(result);
    } catch (error) {
      handleDiscoverAdoptError(
        res,
        error,
        "Failed to adopt discover playlist",
      );
    }
  },
);

router.post(
  "/playlists/adopt-playlist",
  requireAuth,
  requirePermission("accessFlow"),
  async (req, res) => {
    try {
      const presetId = String(req.body?.presetId || "").trim();
      if (!presetId) {
        return res.status(400).json({ error: "presetId is required" });
      }

      const { slskdClient } = await import("../services/slskdClient.js");
      if (!slskdClient.isConfigured()) {
        return res.status(400).json({ error: "slskd not configured" });
      }

      const { adoptDiscoverPresetAsPlaylist } =
        await import("../services/discoverPlaylistAdoptService.js");
      const result = await adoptDiscoverPresetAsPlaylist(req.user, presetId);
      res.json(result);
    } catch (error) {
      handleDiscoverAdoptError(
        res,
        error,
        "Failed to adopt discover playlist",
      );
    }
  },
);

router.get("/related", requireAuth, (req, res) => {
  const discoveryCache = getDiscoveryCache();
  res.json({
    recommendations: discoveryCache.recommendations,
    basedOn: discoveryCache.basedOn,
    total: discoveryCache.recommendations.length,
  });
});

router.get("/similar", requireAuth, (req, res) => {
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
        ...(!getLastfmApiKey() ? getFallbackTagNames() : []),
        ...(discoveryCache.topTags || []),
        ...(discoveryCache.topGenres || []),
      ]
        .map((t) => (t != null ? String(t).trim() : ""))
        .filter(Boolean);
      tagNames = [...new Set(cached)];
    }
    const seen = new Set();
    const filtered = tagNames.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
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
                  image: buildImageProxyUrl(imageUrl) || imageUrl,
                };
              })
              .filter((a) => a.id);
          }
        } catch (err) {
          console.error("Last.fm tag search failed:", err.message);
        }
      } else {
        const fallbackResult = await searchFallbackGenreArtists({
          tag,
          limit: limitInt,
          offset: offsetInt,
          existingArtistKeys: includeLibraryFlag
            ? new Set()
            : buildArtistKeySet(await libraryManager.getAllArtists()),
        });
        if (fallbackResult) {
          return res.json({
            recommendations: fallbackResult.artists,
            tag,
            total: fallbackResult.total,
            offset: offsetInt,
            provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
            fallbackLimited: true,
          });
        }

        const discoveryCache = getDiscoveryCache();
        const tagLower = String(tag).trim().toLowerCase();
        const pool = [
          ...(discoveryCache.recommendations || []),
          ...(discoveryCache.globalTop || []),
          ...(discoveryCache.fallbackGenres || []).flatMap((section) =>
            Array.isArray(section?.artists) ? section.artists : [],
          ),
        ];
        const seen = new Set();
        const matches = pool.filter((artist) => {
          const key = String(artist?.id || artist?.mbid || artist?.name || "")
            .trim()
            .toLowerCase();
          if (!key || seen.has(key)) return false;
          const artistTags = [
            ...(Array.isArray(artist?.tags) ? artist.tags : []),
            ...(Array.isArray(artist?.genres) ? artist.genres : []),
          ];
          const matched = artistTags.some(
            (entry) =>
              String(entry || "")
                .trim()
                .toLowerCase() === tagLower,
          );
          if (!matched) return false;
          seen.add(key);
          return true;
        });
        recommendations = matches.slice(offsetInt, offsetInt + limitInt);
        return res.json({
          recommendations,
          tag,
          total: matches.length,
          offset: offsetInt,
          provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
          fallbackLimited: true,
          message: "Tag search is limited without Last.fm",
        });
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
      recommendations = matches.slice(offsetInt, offsetInt + limitInt);
      return res.json({
        recommendations,
        tag,
        total: matches.length,
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

router.get("/nearby-shows", requireAuth, async (req, res) => {
  try {
    const apiKey = getTicketmasterApiKey();
    if (!apiKey) {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.json({
        configured: false,
        location: null,
        shows: [],
        total: 0,
        counts: {
          libraryArtists: 0,
          matchedLibraryShows: 0,
          matchedRecommendedShows: 0,
        },
      });
    }

    const zipCode = String(req.query.zip || "").trim();
    const limit = req.query.limit;
    const settings = dbOps.getSettings();
    const configuredRadius = Number(
      settings.integrations?.ticketmaster?.searchRadiusMiles,
    );
    const localDiscoveryPreferences = getLocalDiscoveryPreferences();
    const radiusMiles = Number.isFinite(configuredRadius)
      ? Math.max(5, Math.min(250, Math.floor(configuredRadius)))
      : undefined;
    const libraryArtists = await libraryManager.getAllArtists();
    const reqUser = userOps.getUserById(req.user.id);
    const userCacheNamespace = getLastfmApiKey()
      ? getListenHistoryCacheNamespace(getListenHistoryProfile(reqUser || {}))
      : null;
    const discoveryCache = getDiscoveryCache(userCacheNamespace);
    const feedback = getDiscoveryFeedback(req.user?.id || "global");
    const recommendedArtists = localDiscoveryPreferences.includeRecommendations
      ? rerankCachedRecommendations({
          recommendations: discoveryCache.recommendations || [],
          feedback,
          discoveryMode: getDiscoveryMode(),
          limit: 24,
        })
      : [];
    const trendingArtists = localDiscoveryPreferences.includeTrending
      ? (discoveryCache.globalTop || []).slice(0, 18)
      : [];
    const nearbyShows = await getNearbyShows({
      req,
      zipCode,
      libraryArtists,
      recommendedArtists,
      trendingArtists,
      limit,
      radiusMiles,
    });

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.json({
      configured: true,
      ...nearbyShows,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load nearby shows",
      message: error.message,
    });
  }
});

router.get("/preferences", requireAuth, (req, res) => {
  const localDiscoveryPreferences = getLocalDiscoveryPreferences();
  res.json({
    minPopularity: 0,
    maxRecommendations: 50,
    includeFromLastfm: true,
    includeFromLibrary: true,
    includeTrending: true,
    discoveryMode: getDiscoveryMode(),
    localDiscoveryIncludeRecommendations:
      localDiscoveryPreferences.includeRecommendations,
    localDiscoveryIncludeTrending: localDiscoveryPreferences.includeTrending,
  });
});

router.post("/preferences", requireAuth, (req, res) => {
  try {
    const updates = req.body || {};
    const currentSettings = dbOps.getSettings();
    const nextSettings = {
      ...currentSettings,
      integrations: {
        ...(currentSettings.integrations || {}),
        lastfm: {
          ...(currentSettings.integrations?.lastfm || {}),
          discoveryMode:
            updates.discoveryMode === "safer" ||
            updates.discoveryMode === "deeper"
              ? updates.discoveryMode
              : "balanced",
        },
        ticketmaster: {
          ...(currentSettings.integrations?.ticketmaster || {}),
          localDiscoveryIncludeRecommendations:
            updates.localDiscoveryIncludeRecommendations !== false,
          localDiscoveryIncludeTrending:
            updates.localDiscoveryIncludeTrending !== false,
        },
      },
    };
    dbOps.updateSettings(nextSettings);

    res.json({
      success: true,
      preferences: {
        discoveryMode:
          nextSettings.integrations?.lastfm?.discoveryMode || "balanced",
        localDiscoveryIncludeRecommendations:
          nextSettings.integrations?.ticketmaster
            ?.localDiscoveryIncludeRecommendations !== false,
        localDiscoveryIncludeTrending:
          nextSettings.integrations?.ticketmaster
            ?.localDiscoveryIncludeTrending !== false,
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
  const currentSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...currentSettings,
    integrations: {
      ...(currentSettings.integrations || {}),
      lastfm: {
        ...(currentSettings.integrations?.lastfm || {}),
        discoveryMode: "balanced",
      },
      ticketmaster: {
        ...(currentSettings.integrations?.ticketmaster || {}),
        localDiscoveryIncludeRecommendations: true,
        localDiscoveryIncludeTrending: true,
      },
    },
  });
  res.json({
    success: true,
    preferences: {
      discoveryMode: "balanced",
      localDiscoveryIncludeRecommendations: true,
      localDiscoveryIncludeTrending: true,
    },
  });
});

router.get("/feedback", requireAuth, (req, res) => {
  res.json({
    feedback: getDiscoveryFeedback(req.user?.id || "global"),
  });
});

router.post("/feedback", requireAuth, (req, res) => {
  try {
    const feedback = addDiscoveryFeedback(
      req.user?.id || "global",
      req.body || {},
    );
    res.json({
      success: true,
      feedback,
      feedbackList: getDiscoveryFeedback(req.user?.id || "global"),
    });
  } catch (error) {
    res.status(400).json({
      error: "Failed to save discovery feedback",
      message: error.message,
    });
  }
});

router.delete("/feedback/:id", requireAuth, (req, res) => {
  const feedbackList = removeDiscoveryFeedback(
    req.user?.id || "global",
    req.params.id,
  );
  res.json({
    success: true,
    feedbackList,
  });
});

router.post("/feedback/reset", requireAuth, (req, res) => {
  const feedbackList = resetDiscoveryFeedback(req.user?.id || "global");
  res.json({
    success: true,
    feedbackList,
  });
});

router.get("/filtered", requireAuth, async (req, res) => {
  try {
    const discoveryCache = getDiscoveryCache();
    const feedback = getDiscoveryFeedback(req.user?.id || "global");
    const discoveryMode = getDiscoveryMode();
    let recommendations = discoveryCache.recommendations || [];
    let globalTop = discoveryCache.globalTop || [];

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
    recommendations = rerankCachedRecommendations({
      recommendations,
      feedback,
      discoveryMode,
    });

    res.json({
      recommendations,
      globalTop,
      topTags: discoveryCache.topTags || [],
      topGenres: discoveryCache.topGenres || [],
      basedOn: discoveryCache.basedOn || [],
      lastUpdated: discoveryCache.lastUpdated,
      preferencesApplied: true,
      discoveryMode,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get filtered discovery",
      message: error.message,
    });
  }
});

export default router;
