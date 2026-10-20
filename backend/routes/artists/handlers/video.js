import { youtubeFindTopSongVideo } from "../../../services/apiClients/index.js";
import { UUID_REGEX } from "../../../../lib/uuid.js";
import { noCache } from "../../../middleware/cache.js";

export function registerVideo(router) {
  router.get("/:mbid/video", noCache, async (req, res) => {
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
