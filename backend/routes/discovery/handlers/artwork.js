import path from "node:path";
import { verifyTokenAuth } from "../../../middleware/auth.js";
import { ensureDiscoverArtworkForPreset } from "../../../services/discovery/playlistArtworkBuilder.js";

export function registerArtwork(router) {
  router.get("/artwork/:presetId", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    }

    try {
      const artwork = await ensureDiscoverArtworkForPreset(req.params.presetId, { user: req.user });
      if (!artwork) {
        return res.status(404).json({ error: "Artwork not found" });
      }
      res.type(artwork.contentType);
      res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.sendFile(path.basename(artwork.safePath), {
        root: path.dirname(artwork.safePath),
        dotfiles: "allow",
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to load artwork", message: error.message });
    }
  });
}
