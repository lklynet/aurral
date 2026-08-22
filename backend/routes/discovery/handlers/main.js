import {
  getDiscoveryCache,
  getDiscoveryFeedback,
  getDiscoveryMode,
  serveCachedRecommendations,
} from "../../../services/discovery/index.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { getCanonicalArtistKeyProjection } from "../../../services/libraryQueryService.js";
import {
  buildArtistKeySet,
  isLibraryArtist,
} from "./utils.js";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.js";

export function registerMain(router) {
  router.get("/", requireAuth, async (req, res) => {
    const hasExplicitLimit = typeof req.query.limit === "string" && req.query.limit.trim() !== "";
    const limit = hasExplicitLimit
      ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 0))
      : 0;
    const offset = hasExplicitLimit
      ? Math.max(0, parseInt(req.query.offset, 10) || 0)
      : 0;
    const { body, cacheStrategy } = await getUserDiscovery(req.user.id, limit, offset);

    const cacheHeaders = {
      fresh: "private, max-age=120, stale-while-revalidate=300",
      updating: "no-cache, no-store, must-revalidate",
      empty: "private, max-age=30, stale-while-revalidate=120",
    };
    res.set("Cache-Control", cacheHeaders[cacheStrategy]);
    res.json(body);
  });

  router.get("/related", requireAuth, (req, res) => {
    const discoveryCache = getDiscoveryCache();
    const feedback = getDiscoveryFeedback(req.user?.id || "global");
    res.json({
      recommendations: serveCachedRecommendations({
        recommendations: discoveryCache.recommendations,
        feedback,
      }),
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

  router.get("/filtered", requireAuth, async (req, res) => {
    try {
      const discoveryCache = getDiscoveryCache();
      const feedback = getDiscoveryFeedback(req.user?.id || "global");
      const discoveryMode = getDiscoveryMode();
      let recommendations = discoveryCache.recommendations || [];
      let globalTop = discoveryCache.globalTop || [];

      const existingArtistKeys = buildArtistKeySet(getCanonicalArtistKeyProjection());

      recommendations = recommendations.filter(
        (artist) => !isLibraryArtist(artist, existingArtistKeys),
      );
      globalTop = globalTop.filter(
        (artist) => !isLibraryArtist(artist, existingArtistKeys),
      );
      recommendations = serveCachedRecommendations({
        recommendations,
        feedback,
      });
      globalTop = serveCachedRecommendations({
        recommendations: globalTop,
        feedback,
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
}
