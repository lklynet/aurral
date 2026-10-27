import { Hono } from "hono";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { getLatestNightlyImage } from "../services/nightlyUpdates.ts";

export default new Hono<AppEnv>()
  .basePath("/updates")
  .get("/nightly", requireAuth, noCache, async (c) => {
    try {
      return c.json(await getLatestNightlyImage(), 200);
    } catch {
      return c.json({ error: "Published nightly image could not be checked" }, 503);
    }
  });
