import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv, RequestUser } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { hasPermission } from "../services/auth.ts";
import { downloadTracker } from "../services/downloadJobs/downloadTracker.ts";
import { entryForStreamPath } from "../services/queueEntry.ts";
import { pathPulse, trackPulse } from "../services/trackPulse.ts";
import { canAccessJob } from "./playlists/handlers/utils.ts";

const pulseQuery = v.union([
  v.object({ libraryAlbumId: v.string(), libraryTrackId: v.string() }),
  v.object({ streamPath: v.pipe(v.string(), v.maxLength(500)) }),
]);

function playlistTrackPulse(user: RequestUser | undefined, streamPath: string) {
  const entry = entryForStreamPath(streamPath);
  const job = entry && "jobId" in entry ? downloadTracker.getJob(entry.jobId) : null;
  if (job?.status !== "done" || !hasPermission(user, "accessPlaylists")) return null;
  return canAccessJob(user, job) ? pathPulse(job.finalPath) : null;
}

export default new Hono<AppEnv>()
  .basePath("/visualizer")
  .use(requireAuth)
  .get("/pulse", validate("query", pulseQuery), async (c) => {
    const query = c.req.valid("query");
    const pulse = await ("streamPath" in query
      ? playlistTrackPulse(c.var.user, query.streamPath)
      : trackPulse(query.libraryAlbumId, query.libraryTrackId));
    return c.json({ pulse }, 200);
  });
