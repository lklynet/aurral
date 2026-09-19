import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { findLyrics } from "../services/lyrics/lyricsProviders.js";
import { logger } from "../services/logger.js";

const router = express.Router();

// duration only narrows which LRCLIB entry matches, so an unusable one is
// ignored rather than failing a lookup that works without it. Express turns
// ?duration=1&duration=2 into an array, which parseInt would read as the first.
export function durationSeconds(value) {
  if (Array.isArray(value)) return 0;
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  return Math.min(86400, Number.parseInt(raw, 10));
}

router.get("/", requireAuth, async (req, res) => {
  const artist = String(req.query.artist || "").trim();
  const title = String(req.query.title || "").trim();
  if (!artist || !title) {
    return res.status(400).json({ error: "artist and title are required" });
  }
  try {
    const lyrics = await findLyrics({
      artist,
      title,
      album: String(req.query.album || "").trim(),
      durationSec: durationSeconds(req.query.duration),
    });
    if (!lyrics) {
      return res.status(404).json({ error: "No lyrics found" });
    }
    res.set("Cache-Control", "private, max-age=3600");
    return res.json(lyrics);
  } catch (error) {
    // A provider failure names the server it could not reach, which any signed-in
    // listener would otherwise get to read. Keep that to the log.
    logger.error("lyrics", "Lyrics lookup failed:", error);
    return res.status(502).json({ error: "Lyrics lookup failed" });
  }
});

export default router;
