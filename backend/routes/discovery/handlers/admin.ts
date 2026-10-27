import { Hono } from "hono";
import { dbOps } from "../../../db/helpers/index.ts";
import { requireAdmin, requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { clearImageProxyCache } from "../../../services/imageProxyService.ts";
import { clearApiCaches } from "../../../services/apiClients/index.ts";
import { getDiscoveryCache } from "../../../services/discovery/index.ts";
import { enqueueDiscoveryRefresh } from "../../../services/discovery/refreshScheduler.ts";
import { asAppError } from "../../../../lib/errors.ts";

const emptyDiscovery = () => ({
  recommendations: [],
  globalTop: [],
  basedOn: [],
  topTags: [],
  topGenres: [],
  recommendationQuality: null,
  isEnriching: false,
  discoveryRunId: null,
  enrichmentStartedAt: null,
  enrichmentCompletedAt: null,
  enrichmentProgressMessage: null,
  lastUpdated: null,
});

export default new Hono<AppEnv>()
  .post("/refresh", requireAuth, requireAdmin, (c) => {
    const result = enqueueDiscoveryRefresh({ reason: "manual", force: true });
    if (!result.enqueued || result.reason === "already_updating") {
      return c.json(
        {
          message: "Discovery update already in progress",
          isUpdating: true,
          reason: result.reason,
        },
        409,
      );
    }
    return c.json({ message: "Discovery update started", isUpdating: true }, 200);
  })
  .post("/clear", requireAuth, requireAdmin, async (c) => {
    try {
      dbOps.clearImages();
      await clearImageProxyCache();
      clearApiCaches();
      return c.json({ message: "Artwork cache cleared" }, 200);
    } catch (err) {
      const failure = asAppError(err);
      return c.json(
        { message: `Failed to clear cache: ${failure?.message || "Internal server error"}` },
        500,
      );
    }
  })
  .post("/clear-discovery", requireAuth, requireAdmin, (c) => {
    dbOps.updateDiscoveryCache(emptyDiscovery());
    dbOps.deleteDiscoveryCacheByPrefix("user:");
    Object.assign(getDiscoveryCache(), emptyDiscovery());
    return c.json({ message: "Discovery cache cleared" }, 200);
  });
