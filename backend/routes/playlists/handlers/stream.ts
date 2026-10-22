import fsp from "fs/promises";
import { streamAudioFile } from "../../../services/audioFileStream.ts";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { noCache } from "../../../middleware/cache.ts";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.ts";
import { resolveExistingTrackPath } from "../../../services/downloadPaths.ts";
import { canAccessPlaylistType } from "./utils.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import type { DownloadJob } from "../../../services/downloadJobs/downloadTracker.ts";
import type { RequestUser } from "../../../middleware/requestUser.ts";
import type { Router } from "express";

const canAccessJob = (user: RequestUser | undefined, job: DownloadJob) =>
  canAccessPlaylistType(user, job.playlistType) ||
  flowPlaylistConfig
    .getStaticPlaylistsForUser(user)
    .some((playlist) =>
      playlist.tracks?.some(
        (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
      ),
    );

export function registerStream(router: Router) {
  router.get<"/stream/:jobId">("/stream/:jobId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
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
    const resolved = await resolveExistingTrackPath(job.finalPath, downloadWorker.downloadRoot);
    if (!resolved) {
      return res.status(404).json({ error: "Track file missing" });
    }
    const safePath = resolved.path;
    try {
      await fsp.access(safePath);
    } catch {
      return res.status(404).json({ error: "Track file missing" });
    }
    if (!(await streamAudioFile(res, safePath))) {
      res.status(404).json({ error: "Track file missing" });
    }
  });

  router.get<"/staging-stream/:jobId">("/staging-stream/:jobId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
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
    if (!(await streamAudioFile(res, job.stagingPath))) {
      res.status(404).json({ error: "Staging file no longer exists" });
    }
  });
}
