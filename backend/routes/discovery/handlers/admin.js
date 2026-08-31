import { dbOps } from "../../../db/helpers/index.js";
import { clearImageProxyCache } from "../../../services/imageProxyService.js";
import { clearApiCaches } from "../../../services/apiClients/index.js";
import {
  getDiscoveryCache,
} from "../../../services/discovery/index.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  getDiscoveryCapabilities,
} from "../../../services/listenbrainzDiscoveryFallback.js";
import { enqueueDiscoveryRefresh } from "../../../services/discovery/refreshScheduler.js";
import { pendingTagRequests, pendingTagSuggestRequest } from "./utils.js";

export function registerAdmin(router) {
  router.post("/refresh", requireAuth, requireAdmin, (req, res) => {
    const result = enqueueDiscoveryRefresh({
      reason: "manual",
      force: true,
    });
    if (!result.enqueued || result.reason === "already_updating") {
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
    try {
      dbOps.clearImages();
      await clearImageProxyCache();
      clearApiCaches();
      res.json({ message: "Artwork cache cleared" });
    } catch (err) {
      res.status(500).json({
        message: `Failed to clear cache: ${err.message || "Internal server error"}`,
      });
    }
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
      recommendationQuality: null,
      isEnriching: false,
      discoveryRunId: null,
      enrichmentStartedAt: null,
      enrichmentCompletedAt: null,
      enrichmentProgressMessage: null,
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
      recommendationQuality: null,
      isEnriching: false,
      discoveryRunId: null,
      enrichmentStartedAt: null,
      enrichmentCompletedAt: null,
      enrichmentProgressMessage: null,
      lastUpdated: null,
      isUpdating: false,
    });
    pendingTagRequests.clear();
    pendingTagSuggestRequest.promise = null;
    pendingTagSuggestRequest.expiry = 0;
    res.json({ message: "Discovery cache cleared" });
  });
}

import { requireAuth, requireAdmin } from "../../../middleware/requirePermission.js";
