import type { Router } from "express";
import { noCache } from "../../../middleware/cache.ts";
import { logger } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";

export function registerStorageHealth(router: Router) {
  router.get("/storage-health", noCache, async (_req, res) => {
    try {
      const { getStorageHealthSnapshot } =
        await import("../../../services/storageHealthService.ts");
      const result = getStorageHealthSnapshot() || {
        ok: null,
        partial: false,
        checkedAt: null,
        sections: [],
        unavailable: true,
      };
      res.json({
        success: result.ok === true,
        ...result,
      });
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      res.status(500).json({
        error: "Storage health check failed",
        message: asAppError(error)?.message,
      });
    }
  });

  router.post("/storage-health/check", noCache, async (_req, res) => {
    try {
      const { runStorageHealthCheck } = await import("../../../services/storageHealthService.ts");
      const result = await runStorageHealthCheck({ force: true });
      res.json({
        success: result.ok,
        ...result,
      });
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      res.status(500).json({
        error: "Storage health check failed",
        message: asAppError(error)?.message,
      });
    }
  });
}
