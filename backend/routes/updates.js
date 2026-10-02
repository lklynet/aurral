import { Router } from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { noCache } from "../middleware/cache.js";
import { getLatestNightlyImage } from "../services/nightlyUpdates.js";

const router = Router();

router.get("/nightly", requireAuth, noCache, async (_req, res) => {
  try {
    res.json(await getLatestNightlyImage());
  } catch {
    res.status(503).json({ error: "Published nightly image could not be checked" });
  }
});

export default router;
