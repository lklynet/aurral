import express, { type Request, type Response } from "express";
import { requireAuth } from "../middleware/requirePermission.ts";
import { recordAlbumImportCompleted } from "../services/aurralHistoryService.ts";

export const handleLidarrWebhook = (req: Request, res: Response) => {
  const eventType = String(req.body?.eventType || req.body?.EventType || "")
    .trim()
    .toLowerCase();
  if (eventType !== "download") return res.status(204).end();

  const album = req.body?.album || req.body?.Album || {};
  const artist = album.artist || album.Artist || {};
  const entry = recordAlbumImportCompleted({
    albumId: album.id ?? album.Id,
    albumName: album.title ?? album.Title,
    artistName: artist.artistName ?? artist.ArtistName,
    artistMbid: artist.foreignArtistId ?? artist.ForeignArtistId,
  });

  return res.json({ handled: Boolean(entry) });
};

const router = express.Router();
router.post("/", requireAuth, handleLidarrWebhook);

export default router;
