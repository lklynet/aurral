import express from "express";
import { requireAuth, requireUserAccount } from "../middleware/requirePermission.ts";
import { getPlayHistory, recordPlayEvent } from "../services/playEventService.ts";
import { asAppError } from "../../lib/errors.ts";

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ events: getPlayHistory(req.user!.id, req.query) });
});

router.post("/", requireUserAccount, (req, res) => {
  try {
    res.status(201).json({ event: recordPlayEvent(req.user!.id, req.body) });
  } catch (error) {
    const failure = asAppError(error);
    res.status(400).json({ error: failure?.message || "Could not record play event" });
  }
});

export default router;
