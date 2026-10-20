import express from "express";
import path from "node:path";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import {
  getCustomArtwork,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} from "../../../services/customArtworkService.js";
import { canAccessJobThroughPlaylist } from "./jobs.js";

const artworkUploadParser = express.raw({
  limit: "8mb",
  type: (req) => String(req.headers["content-type"] || "").toLowerCase().startsWith("image/"),
});

function getAccessibleJob(req) {
  const job = downloadTracker.getJob(req.params.jobId);
  return job && canAccessJobThroughPlaylist(req.user, job, req.query?.playlistId)
    ? job
    : null;
}

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

function requireAccessibleJob(req, res, next) {
  if (!getAccessibleJob(req)) return res.status(404).json({ error: "Track not found" });
  return next();
}

export function registerTrackArtworkServe(router) {
  router.get("/track-artwork/:jobId", (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!getAccessibleJob(req)) return res.status(404).json({ error: "Artwork not found" });
    const artwork = getCustomArtwork("playlist-track", req.params.jobId);
    if (!artwork) return res.status(404).json({ error: "Artwork not found" });
    res.type(artwork.contentType);
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    return res.sendFile(path.basename(artwork.filePath), {
      root: path.dirname(artwork.filePath),
      dotfiles: "deny",
    });
  });
}

export function registerTrackArtworkManagement(router) {
  router.put(
    "/track-artwork/:jobId",
    canEditArtwork,
    requireAccessibleJob,
    artworkUploadParser,
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: "Image body is required" });
      }
      try {
        const artwork = await saveCustomArtworkUpload(
          "playlist-track",
          req.params.jobId,
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
    "/track-artwork/:jobId/url",
    canEditArtwork,
    requireAccessibleJob,
    async (req, res) => {
      try {
        const artwork = await saveCustomArtworkUrl(
          "playlist-track",
          req.params.jobId,
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
    "/track-artwork/:jobId",
    canEditArtwork,
    requireAccessibleJob,
    async (req, res) => {
      await removeCustomArtwork("playlist-track", req.params.jobId);
      return res.json({ ok: true });
    },
  );
}
