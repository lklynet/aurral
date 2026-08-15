import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { getPlayHistory, recordPlayEvent } from "../services/playEventService.js";

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ events: getPlayHistory(req.user.id, req.query) });
});

router.post("/", (req, res) => {
  try {
    res.status(201).json({ event: recordPlayEvent(req.user.id, req.body) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not record play event" });
  }
});

export default router;
