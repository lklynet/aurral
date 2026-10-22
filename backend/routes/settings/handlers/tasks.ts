import type { Router } from "express";
import { noCache } from "../../../middleware/cache.ts";
import { asAppError } from "../../../../lib/errors.ts";

export function registerTasks(router: Router) {
  router.get("/tasks", noCache, async (_req, res) => {
    try {
      const { getHonkerTaskStatus } = await import("../../../services/honkerTaskStatus.ts");
      res.json(await getHonkerTaskStatus());
    } catch (error) {
      res.status(500).json({
        error: "Failed to get task status",
        message: asAppError(error)?.message,
      });
    }
  });

  router.post("/tasks/clear-stale", noCache, async (_req, res) => {
    try {
      const { clearStaleHonkerJobs, getHonkerTaskStatus } =
        await import("../../../services/honkerTaskStatus.ts");
      const result = await clearStaleHonkerJobs();
      res.json({
        ...result,
        tasks: await getHonkerTaskStatus(),
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to clear stuck jobs",
        message: asAppError(error)?.message,
      });
    }
  });
}
