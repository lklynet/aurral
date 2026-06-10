import { UUID_REGEX } from "../../../config/constants.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import { youtubeFindTopSongVideo } from "../../../services/apiClients.js";

export default function registerVideo(router) {
  router.get("/:mbid/video", cacheMiddleware(3600), async (req, res) => {
    try {
      const { mbid } = req.params;
      const artistName = String(req.query.artistName || "").trim();
      const trackTitle = String(req.query.trackTitle || "").trim();

      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }
      if (!artistName || !trackTitle) {
        return res.json({ video: null });
      }

      const video = await youtubeFindTopSongVideo(artistName, trackTitle);
      return res.json({ video });
    } catch (error) {
      return res.json({ video: null });
    }
  });
}
