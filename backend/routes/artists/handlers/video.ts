import type { Request, Router } from "express";
import { youtubeFindTopSongVideo } from "../../../services/apiClients/index.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { noCache } from "../../../middleware/cache.ts";

type MbidRequest = Request<{ mbid: string }>;

export type ArtistVideoResponse = {
  video: { videoId: string; embedUrl: string } | null;
};

export function registerVideo(router: Router) {
  router.get("/:mbid/video", noCache, async (req: MbidRequest, res) => {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    const artistName = String(req.query.artistName || "").trim();
    const trackTitle = String(req.query.trackTitle || "").trim();

    if (!artistName || !trackTitle) {
      return res.json({ video: null });
    }

    try {
      const video = await youtubeFindTopSongVideo(artistName, trackTitle);
      return res.json({ video });
    } catch {
      return res.status(503).json({ error: "Video search is unavailable. Try again." });
    }
  });
}
