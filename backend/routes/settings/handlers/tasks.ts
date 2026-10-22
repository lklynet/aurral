import { noCache } from "../../../middleware/cache.ts";

export function registerTasks(router) {
  router.get("/tasks", noCache, async (_req, res) => {
    try {
      const { getHonkerTaskStatus } = await import("../../../services/honkerTaskStatus.ts");
      res.json(await getHonkerTaskStatus());
    } catch (error) {
      res.status(500).json({
        error: "Failed to get task status",
        message: error.message,
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
        message: error.message,
      });
    }
  });
}
