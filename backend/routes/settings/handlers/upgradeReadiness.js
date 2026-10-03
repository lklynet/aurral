import { noCache } from "../../../middleware/cache.js";
import { logger } from "../../../services/logger.js";
import {
  checkUpgradeReadiness,
  queueUpgradeReadinessRecheck,
} from "../../../services/upgradeReadiness.js";

export function registerUpgradeReadiness(router) {
  router.get("/upgrade-readiness", noCache, (_req, res) => {
    try {
      res.json(checkUpgradeReadiness());
    } catch (error) {
      logger.error("settings", "Could not check Aurral 3.0 readiness", { reason: error.message });
      res.status(500).json({ error: "Failed to check Aurral 3.0 readiness" });
    }
  });

  router.post("/upgrade-readiness/recheck", noCache, (_req, res) => {
    try {
      res.status(202).json({ queued: queueUpgradeReadinessRecheck() });
    } catch (error) {
      logger.error("settings", "Could not queue the Aurral 3.0 readiness check", { reason: error.message });
      res.status(500).json({ error: "Failed to queue the Aurral 3.0 readiness check" });
    }
  });
}
