import path from "path";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.ts";
import { canAccessPlaylistType } from "./utils.ts";
import {
  getArtworkContentTypeForExtension,
  parsePlaylistCoverPick,
} from "../../../services/playlistArtworkGenerator.ts";
import { asAppError } from "../../../../lib/errors.ts";
import type { Request, Response, Router } from "express";

function authorizeArtworkRead(req: Request, res: Response, playlistId: string) {
  if (!verifyTokenAuth(req)) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    return false;
  }
  if (req.user && !hasPermission(req.user, "accessFlow")) {
    res.status(403).json({ error: "Forbidden", message: "Permission required: accessFlow" });
    return false;
  }
  if (!canAccessPlaylistType(req.user, playlistId)) {
    res.status(404).json({ error: "Playlist artwork not found" });
    return false;
  }
  return true;
}

export function registerArtworkServe(router: Router) {
  router.get<"/artwork/:playlistId">("/artwork/:playlistId", async (req, res) => {
    const { playlistId } = req.params;
    if (!authorizeArtworkRead(req, res, playlistId)) return;
    const artwork = await playlistManager.resolveArtworkFile(playlistId);
    if (!artwork) {
      return res.status(404).json({ error: "Playlist artwork not found" });
    }

    res.type(getArtworkContentTypeForExtension(artwork.extension));
    res.set("Cache-Control", "private, no-cache, must-revalidate");
    res.sendFile(path.basename(artwork.safePath), {
      root: path.dirname(artwork.safePath),
      dotfiles: "allow",
    });
  });

  router.get<"/artwork/:playlistId/preview">("/artwork/:playlistId/preview", async (req, res) => {
    const { playlistId } = req.params;
    if (!authorizeArtworkRead(req, res, playlistId)) return;
    const pick = parsePlaylistCoverPick(req.query);
    const title = typeof req.query.title === "string" ? req.query.title.slice(0, 200) : "";
    if (!pick) return res.status(400).json({ error: "Invalid cover choice" });
    try {
      const image = await playlistManager.previewArtwork(playlistId, title, pick);
      res.type("image/webp");
      res.set("Cache-Control", "private, max-age=3600");
      return res.send(image);
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: asAppError(error)?.message || "Failed to preview cover",
      });
    }
  });
}
