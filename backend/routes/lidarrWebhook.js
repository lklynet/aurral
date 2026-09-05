import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { recordAlbumImportCompleted } from "../services/aurralHistoryService.js";
import { scheduleLibraryScan } from "../services/libraryScanWorker.js";

// Events after which one artist's files changed in Lidarr: re-index that
// artist only. Deletions fall back to a full scan.
const ARTIST_SCOPED_EVENTS = new Set(["download", "rename", "retag", "trackretag"]);
const FULL_SCAN_EVENTS = new Set(["artistdelete", "albumdelete"]);

const webhookArtistId = (body) => {
  const album = body?.album || body?.Album || {};
  const artist = body?.artist || body?.Artist || album.artist || album.Artist || {};
  const artistId = Number(artist.id ?? artist.Id);
  return Number.isSafeInteger(artistId) && artistId > 0 ? artistId : null;
};

const scheduleWebhookScan = (eventType, body) => {
  try {
    if (FULL_SCAN_EVENTS.has(eventType)) return scheduleLibraryScan({ includeLidarr: true });
    if (!ARTIST_SCOPED_EVENTS.has(eventType)) return null;
    const artistId = webhookArtistId(body);
    return artistId ? scheduleLibraryScan({ artistIds: [artistId] }) : null;
  } catch {
    return null;
  }
};

export const handleLidarrWebhook = (req, res) => {
  const eventType = String(req.body?.eventType || req.body?.EventType || "")
    .trim()
    .toLowerCase();
  const scanJobId = scheduleWebhookScan(eventType, req.body);
  if (eventType !== "download") {
    return scanJobId ? res.json({ handled: true, scanJobId }) : res.status(204).end();
  }

  const album = req.body?.album || req.body?.Album || {};
  const artist = album.artist || album.Artist || {};
  const entry = recordAlbumImportCompleted({
    albumId: album.id ?? album.Id,
    albumName: album.title ?? album.Title,
    artistName: artist.artistName ?? artist.ArtistName,
    artistMbid: artist.foreignArtistId ?? artist.ForeignArtistId,
  });

  return res.json(scanJobId ? { handled: Boolean(entry), scanJobId } : { handled: Boolean(entry) });
};

const router = express.Router();
router.post("/", requireAuth, handleLidarrWebhook);

export default router;
