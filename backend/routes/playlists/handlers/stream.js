import fsp from "fs/promises";
import path from "path";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import { noCache } from "../../../middleware/cache.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import {
  resolveExistingTrackPath,
} from "../../../services/downloadPaths.js";
import { canAccessPlaylist } from "./utils.js";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.js";

const canAccessJob = (user, job) =>
  canAccessPlaylist(user, job.ownerId) ||
  flowPlaylistConfig.getStaticPlaylistsForUser(user).some((playlist) =>
    playlist.tracks?.some(
      (track) => String(track?.jobId || "") === String(job.id || ""),
    ),
  );

export function registerStream(router) {
  router.get("/stream/:jobId", noCache, async (req, res) => {
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
    const { jobId } = req.params;
    const job = downloadTracker.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Track not found" });
    }
    if (!canAccessJob(req.user, job)) {
      return res.status(404).json({ error: "Track not found" });
    }
    if (job.status !== "done" || !job.finalPath) {
      return res.status(400).json({ error: "Track is not ready to stream" });
    }
    const safePath = await resolveExistingTrackPath(job.finalPath);
    if (!safePath) {
      return res.status(404).json({ error: "Track file missing" });
    }
    res.sendFile(path.basename(safePath), {
      root: path.dirname(safePath),
      dotfiles: "allow",
    });
  });

  router.get("/staging-stream/:jobId", noCache, async (req, res) => {
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
    const { jobId } = req.params;
    const job = downloadTracker.getJob(jobId);
    if (!job || job.status !== "blocked" || !job.stagingPath) {
      return res.status(404).json({ error: "Staging file not found" });
    }
    try {
      await fsp.access(job.stagingPath);
    } catch {
      return res.status(404).json({ error: "Staging file no longer exists" });
    }
    res.sendFile(path.basename(job.stagingPath), {
      root: path.dirname(job.stagingPath),
      dotfiles: "allow",
    });
  });
}
