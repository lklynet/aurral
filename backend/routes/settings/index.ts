import { Hono } from "hono";
import { noCache } from "../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { appSettingsPatch, readAppSettings, saveAppSettings } from "../../services/appSettings.ts";
import { logger } from "../../services/logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { playlistManager } from "../../services/playlists/playlistManager.ts";

export default new Hono<AppEnv>()
  .basePath("/settings")
  .get("/", requireAuth, requireAdmin, noCache, (c) => {
    try {
      return c.json(readAppSettings(), 200);
    } catch (error) {
      logger.error("settings", "Settings GET error:", error ?? undefined);
      return c.json(
        { error: "Failed to fetch settings", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/", requireAuth, requireAdmin, validate("json", appSettingsPatch), async (c) => {
    try {
      const result = await saveAppSettings(c.req.valid("json"));
      if ("error" in result) return c.json({ error: result.error }, 400);
      return c.json(result.settings, 200);
    } catch (error) {
      logger.error("settings", "Settings POST error:", error ?? undefined);
      return c.json({ error: "Failed to save settings", message: asAppError(error)?.message }, 500);
    }
  })
  .get("/playlist-files", requireAuth, requireAdmin, (c) =>
    c.json({ folder: playlistManager.libraryRoot }, 200),
  )
  .get("/tasks", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { getTaskStatus } = await import("../../services/jobs/status.ts");
      return c.json(await getTaskStatus(), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to get task status", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/tasks/clear-stale", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { clearStaleJobs, getTaskStatus } = await import("../../services/jobs/status.ts");
      return c.json({ ...clearStaleJobs(), tasks: await getTaskStatus() }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to clear stuck jobs", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/storage-health", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { getStorageHealthSnapshot } = await import("../../services/storageHealthService.ts");
      const result = getStorageHealthSnapshot() || {
        ok: null,
        partial: false,
        checkedAt: null,
        sections: [],
        unavailable: true,
      };
      return c.json({ success: result.ok === true, ...result }, 200);
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      return c.json(
        { error: "Storage health check failed", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/storage-health/check", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { runStorageHealthCheck } = await import("../../services/storageHealthService.ts");
      const result = await runStorageHealthCheck({ force: true });
      return c.json({ success: result.ok, ...result }, 200);
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      return c.json(
        { error: "Storage health check failed", message: asAppError(error)?.message },
        500,
      );
    }
  });
