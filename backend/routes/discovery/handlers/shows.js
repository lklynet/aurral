import { createHash } from "node:crypto";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { db } from "../../../config/db-sqlite.js";
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

const libraryArtistNamesStmt = db.prepare(
  "SELECT name FROM library_artists ORDER BY id",
);

const fingerprintArtists = (artists) => {
  const names = [
    ...new Set(
      (Array.isArray(artists) ? artists : [])
        .map((artist) => String(artist?.artistName || artist?.name || "").trim())
        .filter(Boolean),
    ),
  ].sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
};

export const buildShowsResponseCacheKey = ({
  userId,
  libraryArtists,
  recommendedArtists,
  trendingArtists,
}) =>
  JSON.stringify([
    userId,
    fingerprintArtists(libraryArtists),
    fingerprintArtists(recommendedArtists),
    fingerprintArtists(trendingArtists),
  ]);

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
      const country = String(req.query.country || "").trim();
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
      const libraryArtistNames = libraryArtistNamesStmt.all();
      const nearbyShows = await getNearbyShows({
        req,
        zipCode,
        country,
        libraryArtists: () => [...iterateCanonicalArtistProjection({ pageSize: 100 })],
        recommendedArtists,
        trendingArtists,
        limit: req.query.limit,
        radiusMiles,
        responseCacheKey: buildShowsResponseCacheKey({
          userId: req.user.id,
          libraryArtists: libraryArtistNames,
          recommendedArtists,
          trendingArtists,
        }),
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
