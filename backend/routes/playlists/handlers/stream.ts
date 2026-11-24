import { Hono } from "hono";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { validate } from "../../../middleware/validate.ts";
import { streamQuery, streamSubsonicAudio } from "../../../services/subsonicTranscodeService.ts";
import { canAccessJob, requirePlaylistAccessIfSignedIn } from "./utils.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { deezerPreviewLinkFor } from "../../../services/apiClients/deezer.ts";

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get(
    "/stream/:jobId",
    noCache,
    requireStreamAuth,
    requirePlaylistAccessIfSignedIn,
    validate("query", streamQuery),
    async (c) => {
      const job = downloadTracker.getJob(c.req.param("jobId"));
      if (!job || !canAccessJob(c.get("user"), job)) {
        return c.json({ error: "Track not found" }, 404);
      }
      if (job.status === "saved") {
        const link = await deezerPreviewLinkFor(job).catch(() => null);
        return link ? c.redirect(link, 302) : c.json({ error: "No preview for this track" }, 404);
      }
      if (job.status !== "done") {
        return c.json({ error: "Track is not ready to stream" }, 400);
      }
      const sent = await sendViaNode(c, streamSubsonicAudio, job.finalPath, c.req.valid("query"));
      return sent || c.json({ error: "Track file missing" }, 404);
    },
  )
  .get(
    "/staging-stream/:jobId",
    noCache,
    requireStreamAuth,
    requirePlaylistAccessIfSignedIn,
    validate("query", streamQuery),
    async (c) => {
      const job = downloadTracker.getJob(c.req.param("jobId"));
      if (!job || job.status !== "blocked" || !job.stagingPath) {
        return c.json({ error: "Staging file not found" }, 404);
      }
      const sent = await sendViaNode(c, streamSubsonicAudio, job.stagingPath, c.req.valid("query"));
      return sent || c.json({ error: "Staging file no longer exists" }, 404);
    },
  );
