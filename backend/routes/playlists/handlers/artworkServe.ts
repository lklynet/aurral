import path from "path";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.ts";
import { canAccessPlaylistType } from "./utils.ts";
import type { Router } from "express";

export function registerArtworkServe(router: Router) {
  router.get<"/artwork/:playlistId">("/artwork/:playlistId", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
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
      await import("../../../services/playlistArtworkGenerator.ts");
    res.type(getArtworkContentTypeForExtension(artwork.extension));
    res.set("Cache-Control", "private, no-cache, must-revalidate");
    res.sendFile(path.basename(artwork.safePath), {
      root: path.dirname(artwork.safePath),
      dotfiles: "allow",
    });
  });
}
