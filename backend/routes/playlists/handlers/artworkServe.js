import path from "path";
import { playlistManager } from "../../../services/playlists/playlistManager.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import { canAccessPlaylist } from "./utils.js";

export function registerArtworkServe(router) {
  router.get("/artwork/:playlistId", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Authentication required" });
    }
    if (req.user && !hasPermission(req.user, "accessPlaylists")) {
      return res
        .status(403)
        .json({ error: "Forbidden", message: "Permission required: accessPlaylists" });
    }

    const { playlistId } = req.params;
    if (!canAccessPlaylist(req.user, playlistId)) {
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
    res.sendFile(path.basename(artwork.safePath), {
      root: path.dirname(artwork.safePath),
      dotfiles: "allow",
    });
  });
}
