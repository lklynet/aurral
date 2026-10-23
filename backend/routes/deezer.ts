import express from "express";
import { getDeezerPreviewLink } from "../services/apiClients/index.ts";

const router = express.Router();

router.get("/preview/:trackId.mp3", async (req, res) => {
  const { trackId } = req.params;
  if (!/^\d{1,20}$/.test(trackId)) return res.status(404).json({ error: "Preview not found" });
  try {
    const link = await getDeezerPreviewLink(trackId);
    if (!link) return res.status(404).json({ error: "Preview not found" });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, link);
  } catch {
    return res.status(502).json({ error: "Deezer is unavailable" });
  }
});

export default router;
