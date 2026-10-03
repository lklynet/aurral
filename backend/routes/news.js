import express from "express";
import { requireAdmin, requireAuth } from "../middleware/requirePermission.js";
import { disableNewsFeed, getNewsForUser } from "../services/newsService.js";

const router = express.Router();

router.post("/feeds/disable", requireAuth, requireAdmin, (req, res) => {
  const sourceUrl = String(req.body?.sourceUrl || "").trim();
  if (!sourceUrl) {
    return res.status(400).json({ error: "sourceUrl is required" });
  }
  return res.json(disableNewsFeed(sourceUrl));
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await getNewsForUser({
      userId: req.user.id,
      mode: req.query.mode === "top" ? "top" : "matched",
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return res.json(result);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: "Failed to load artist news", message: error.message });
  }
});

export default router;
