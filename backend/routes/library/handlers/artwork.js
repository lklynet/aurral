import express from "express";
import path from "node:path";
import { db } from "../../../config/db-sqlite.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import {
  getCustomArtwork,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} from "../../../services/customArtworkService.js";

const artworkUploadParser = express.raw({
  limit: "8mb",
  type: (req) => String(req.headers["content-type"] || "").toLowerCase().startsWith("image/"),
});

function canEditArtwork(req, res, next) {
  if (
    req.user?.role === "admin" ||
    hasPermission(req.user, "addAlbum") ||
    hasPermission(req.user, "changeMonitoring")
  ) {
    return next();
  }
  return res.status(403).json({
    error: "Forbidden",
    message: "Permission required: addAlbum or changeMonitoring",
  });
}

function entityExists(kind, id) {
  if (kind === "album") {
    return Boolean(db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(id));
  }
  if (kind === "track") {
    return Boolean(db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(id));
  }
  return false;
}

function validateTarget(req, res, next) {
  const { kind, id } = req.params;
  if (!["album", "track"].includes(kind) || !entityExists(kind, id)) {
    return res.status(404).json({ error: "Library item not found" });
  }
  return next();
}

export function registerArtwork(router) {
  router.get("/artwork/:kind/:id", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!["album", "track"].includes(req.params.kind) || !entityExists(req.params.kind, req.params.id)) {
      return res.status(404).json({ error: "Artwork not found" });
    }
    const artwork = getCustomArtwork(req.params.kind, req.params.id);
    if (!artwork) return res.status(404).json({ error: "Artwork not found" });
    res.type(artwork.contentType);
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    return res.sendFile(path.basename(artwork.filePath), {
      root: path.dirname(artwork.filePath),
      dotfiles: "deny",
    });
  });

  router.put(
    "/artwork/:kind/:id",
    requireAuth,
    canEditArtwork,
    validateTarget,
    artworkUploadParser,
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: "Image body is required" });
      }
      try {
        const artwork = await saveCustomArtworkUpload(
          req.params.kind,
          req.params.id,
          req.body,
          req.headers["content-type"],
        );
        return res.json({ ok: true, updatedAt: artwork.updatedAt });
      } catch (error) {
        return res.status(400).json({
          error: "Failed to save artwork",
          message: error?.message || "The image could not be saved",
        });
      }
    },
  );

  router.put(
    "/artwork/:kind/:id/url",
    requireAuth,
    canEditArtwork,
    validateTarget,
    async (req, res) => {
      try {
        const artwork = await saveCustomArtworkUrl(
          req.params.kind,
          req.params.id,
          req.body?.url,
        );
        return res.json({ ok: true, updatedAt: artwork.updatedAt });
      } catch (error) {
        return res.status(400).json({
          error: "Failed to save artwork",
          message: error?.message || "The image could not be downloaded",
        });
      }
    },
  );

  router.delete(
    "/artwork/:kind/:id",
    requireAuth,
    canEditArtwork,
    validateTarget,
    async (req, res) => {
      await removeCustomArtwork(req.params.kind, req.params.id);
      return res.json({ ok: true });
    },
  );
}
