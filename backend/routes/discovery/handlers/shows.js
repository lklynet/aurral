import { requireAuth } from "../../../middleware/requirePermission.js";
import { dbOps, userOps } from "../../../db/helpers/index.js";
import { getTicketmasterApiKey, getLastfmApiKey } from "../../../services/apiClients/index.js";
import { iterateCanonicalArtistProjection } from "../../../services/libraryQueryService.js";
import {
  getDiscoveryCache,
  getDiscoveryFeedback,
  getLocalDiscoveryPreferences,
  serveCachedRecommendations,
} from "../../../services/discovery/index.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
} from "../../../services/listeningHistory.js";
import { getNearbyShows } from "../../../services/nearbyShowsService.js";

export function registerShows(router) {
  router.get("/nearby-shows", requireAuth, async (req, res) => {
    try {
      const apiKey = getTicketmasterApiKey();
      if (!apiKey) {
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return res.json({
          configured: false,
          location: null,
          shows: [],
          libraryShows: [],
          recommendedShows: [],
          total: 0,
        });
      }

      const zipCode = String(req.query.zip || "").trim();
      const settings = dbOps.getSettings();
      const configuredRadius = Number(
        settings.integrations?.ticketmaster?.searchRadiusMiles,
      );
      const localDiscoveryPreferences = getLocalDiscoveryPreferences();
      const radiusMiles = Number.isFinite(configuredRadius)
        ? Math.max(5, Math.min(250, Math.floor(configuredRadius)))
        : undefined;
      const reqUser = userOps.getUserById(req.user.id);
      const userCacheNamespace = getLastfmApiKey()
        ? getListenHistoryCacheNamespace(getListenHistoryProfile(reqUser || {}))
        : null;
      const discoveryCache = getDiscoveryCache(userCacheNamespace);
      const feedback = getDiscoveryFeedback(req.user?.id || "global");
      const recommendedArtists = localDiscoveryPreferences.includeRecommendations
        ? serveCachedRecommendations({
            recommendations: discoveryCache.recommendations || [],
            feedback,
          }).slice(0, 24)
        : [];
      const trendingArtists = localDiscoveryPreferences.includeTrending
        ? serveCachedRecommendations({
            recommendations: discoveryCache.globalTop || [],
            feedback,
          }).slice(0, 18)
        : [];
      const nearbyShows = await getNearbyShows({
        req,
        zipCode,
        libraryArtists: () => [...iterateCanonicalArtistProjection({ pageSize: 100 })],
        recommendedArtists,
        trendingArtists,
        limit: req.query.limit,
        radiusMiles,
        responseCacheKey: req.user.id,
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
}
