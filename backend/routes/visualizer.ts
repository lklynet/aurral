import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { trackPulse } from "../services/trackPulse.ts";

const pulseQuery = v.object({ libraryAlbumId: v.string(), libraryTrackId: v.string() });

export default new Hono<AppEnv>()
  .basePath("/visualizer")
  .use(requireAuth)
  .get("/pulse", validate("query", pulseQuery), async (c) => {
    const { libraryAlbumId, libraryTrackId } = c.req.valid("query");
    const pulse = await trackPulse(libraryAlbumId, libraryTrackId);
    return c.json({ pulse }, 200);
  });
