import fsp from "fs/promises";
import path from "path";
import { downloadTracker } from "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../../../services/weeklyFlow/weeklyFlowWorker.js";
import { noCache } from "../../../middleware/cache.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import {
  resolveExistingTrackPath as resolveExistingWeeklyFlowTrackPath,
} from "../../../services/playlistPaths.js";
import {
  AUDIO_CONTENT_TYPES,
  canAccessPlaylistType,
} from "./utils.js";
import { flowPlaylistConfig } from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";

const canAccessJob = (user, job) =>
  canAccessPlaylistType(user, job.playlistType) ||
  flowPlaylistConfig.getSharedPlaylistsForUser(user).some((playlist) =>
    playlist.tracks?.some(
      (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
    ),
  );

export function registerStream(router) {
  router.get("/stream/:jobId", noCache, async (req, res) => {
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
    const resolved = await resolveExistingWeeklyFlowTrackPath(
      job.finalPath,
      weeklyFlowWorker.weeklyFlowRoot,
    );
    if (!resolved) {
      return res.status(404).json({ error: "Track file missing" });
    }
    if (resolved.migratedFrom) {
      downloadTracker.setDone(job.id, resolved.path, job.albumName || null);
    }
    const safePath = resolved.path;
    try {
      await fsp.access(safePath);
    } catch {
      return res.status(404).json({ error: "Track file missing" });
    }
    const ext = path.extname(safePath).toLowerCase();
    res.type(AUDIO_CONTENT_TYPES[ext] || "application/octet-stream");
    res.sendFile(safePath);
  });

  router.get("/staging-stream/:jobId", noCache, async (req, res) => {
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
    const ext = path.extname(job.stagingPath).toLowerCase();
    res.type(AUDIO_CONTENT_TYPES[ext] || "application/octet-stream");
    res.sendFile(job.stagingPath);
  });
}
