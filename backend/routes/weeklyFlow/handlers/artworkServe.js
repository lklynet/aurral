import { playlistManager } from "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import { canAccessPlaylistType } from "./utils.js";

export function registerArtworkServe(router) {
  router.get("/artwork/:playlistId", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Authentication required" });
    }
    if (req.user && !hasPermission(req.user, "accessFlow")) {
      return res
        .status(403)
        .json({ error: "Forbidden", message: "Permission required: accessFlow" });
    }

    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist artwork not found" });
    }
    const artwork = await playlistManager.resolveArtworkFile(playlistId);
    if (!artwork) {
      return res.status(404).json({ error: "Playlist artwork not found" });
    }

    const { getArtworkContentTypeForExtension } =
      await import("../../../services/playlistArtworkGenerator.js");
    res.type(getArtworkContentTypeForExtension(artwork.extension));
    res.set("Cache-Control", "private, no-cache, must-revalidate");
    res.sendFile(artwork.safePath);
  });
}
