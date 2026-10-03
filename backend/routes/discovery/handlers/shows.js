import { createHash } from "node:crypto";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { dbOps } from "../../../db/helpers/index.js";
import { getTicketmasterApiKey } from "../../../services/apiClients/index.js";
import { getLibraryArtistNames } from "../../../services/libraryQueryService.js";
import { getLocalDiscoveryPreferences } from "../../../services/discovery/index.js";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.js";
import { getNearbyShows } from "../../../services/nearbyShowsService.js";

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
        });
      }

      const zipCode = String(req.query.zip || "").trim();
      const countryCode = String(req.query.country || "").trim();
      const settings = dbOps.getSettings();
      const configuredRadius = Number(
        settings.integrations?.ticketmaster?.searchRadiusMiles,
      );
      const localDiscoveryPreferences = getLocalDiscoveryPreferences();
      const radiusMiles = Number.isFinite(configuredRadius)
        ? Math.max(5, Math.min(250, Math.floor(configuredRadius)))
        : undefined;
      const { body: discovery } = await getUserDiscovery(req.user.id, 24);
      const recommendedArtists = localDiscoveryPreferences.includeRecommendations
        ? discovery.recommendations
        : [];
      const trendingArtists = localDiscoveryPreferences.includeTrending
        ? discovery.globalTop.slice(0, 18)
        : [];
      const libraryArtists = getLibraryArtistNames();
      const nearbyShows = await getNearbyShows({
        req,
        zipCode,
        countryCode,
        libraryArtists,
        recommendedArtists,
        trendingArtists,
        radiusMiles,
        responseCacheKey: buildShowsResponseCacheKey({
          userId: req.user.id,
          libraryArtists,
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
