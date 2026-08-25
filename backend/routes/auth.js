import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { getApiKey, rotateApiKey } from "../middleware/auth.js";

const router = express.Router();

router.get("/api-key", requireAuth, (req, res) => {
  res.json({ apiKey: getApiKey() });
});

router.post("/api-key/rotate", requireAuth, (req, res) => {
  res.json({ apiKey: rotateApiKey() });
});

export default router;
