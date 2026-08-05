import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import {
  getLibraryNews,
  getNewsPreferences,
  updateNewsPreferences,
} from "../services/newsService.js";

const router = express.Router();

router.get("/preferences", requireAuth, (req, res) => {
  return res.json(getNewsPreferences(req.user.id));
});

router.patch("/preferences", requireAuth, (req, res) => {
  if (!Array.isArray(req.body?.blockedPublishers)) {
    return res.status(400).json({ error: "blockedPublishers must be an array" });
  }
  return res.json(updateNewsPreferences(req.user.id, req.body));
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 60));
    const result = await getLibraryNews({ limit, userId: req.user.id });
    res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return res.json(result);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: "Failed to load artist news", message: error.message });
  }
});

export default router;
