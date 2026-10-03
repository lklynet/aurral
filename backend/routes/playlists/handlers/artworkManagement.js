import express from "express";
import { playlistManager } from "../../../services/playlists/playlistManager.js";
import { canAccessPlaylistType } from "./utils.js";

const artworkUploadParser = express.raw({
  limit: "8mb",
  type: (req) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    return contentType.startsWith("image/");
  },
});

export function registerArtworkManagement(router) {
  router.put("/artwork/:playlistId", artworkUploadParser, async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Image body is required",
      });
    }
    try {
      await playlistManager.saveArtworkUpload(playlistId, req.body);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: error?.message || "Failed to save artwork",
      });
    }
  });

  router.delete("/artwork/:playlistId", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    try {
      await playlistManager.removeArtwork(playlistId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: error?.message || "Failed to remove artwork",
      });
    }
  });

  router.post("/artwork/:playlistId/generate", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    try {
      await playlistManager.generateArtwork(playlistId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: error?.message || "Failed to generate artwork",
      });
    }
  });
}
