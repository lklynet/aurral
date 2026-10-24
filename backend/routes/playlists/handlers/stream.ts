import { Hono } from "hono";
import { sendAudioFile } from "../../../services/audioFileStream.ts";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import { noCache } from "../../../middleware/noCache.ts";
import { resolveExistingTrackPath } from "../../../services/downloadPaths.ts";
import { canAccessPlaylistType } from "./utils.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import type { DownloadJob } from "../../../services/downloadJobs/downloadTracker.ts";
import type { AppEnv, RequestUser } from "../../../middleware/requestUser.ts";

const canAccessJob = (user: RequestUser | undefined, job: DownloadJob) =>
  canAccessPlaylistType(user, job.playlistType) ||
  flowPlaylistConfig
    .getStaticPlaylistsForUser(user)
    .some((playlist) =>
      playlist.tracks?.some(
        (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
      ),
    );

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .use(noCache, requireStreamAuth)
  .use(async (c, next) => {
    const user = c.get("user");
    if (user && !hasPermission(user, "accessFlow")) {
      return c.json({ error: "Forbidden", message: "Permission required: accessFlow" }, 403);
    }
    await next();
  })
  .get("/stream/:jobId", async (c) => {
    const job = downloadTracker.getJob(c.req.param("jobId"));
    if (!job || !canAccessJob(c.get("user"), job)) {
      return c.json({ error: "Track not found" }, 404);
    }
    if (job.status !== "done" || !job.finalPath) {
      return c.json({ error: "Track is not ready to stream" }, 400);
    }
    const resolved = await resolveExistingTrackPath(job.finalPath, downloadWorker.downloadRoot);
    const sent = resolved && (await sendViaNode(c, sendAudioFile, resolved.path));
    return sent || c.json({ error: "Track file missing" }, 404);
  })
  .get("/staging-stream/:jobId", async (c) => {
    const job = downloadTracker.getJob(c.req.param("jobId"));
    if (!job || job.status !== "blocked" || !job.stagingPath) {
      return c.json({ error: "Staging file not found" }, 404);
    }
    const sent = await sendViaNode(c, sendAudioFile, job.stagingPath);
    return sent || c.json({ error: "Staging file no longer exists" }, 404);
  });
