import { Hono } from "hono";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { getAvailableUpdate } from "../services/updates.ts";

export default new Hono<AppEnv>()
  .basePath("/updates")
  .get("/", requireAuth, noCache, (c) => c.json({ update: getAvailableUpdate() }, 200));
