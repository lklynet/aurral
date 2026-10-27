import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import {
  buildFlowLidarrImportList,
  verifyFlowLidarrFeedToken,
} from "../services/lidarrImportListFeed.ts";

const feedQuery = v.object({ token: v.optional(v.union([v.string(), v.array(v.string())])) });

export default new Hono<AppEnv>()
  .basePath("/feeds")
  .get("/lidarr/flows/:file", validate("query", feedQuery), (c) => {
    const flowId = /^(.+)\.json$/i.exec(c.req.param("file"))?.[1].trim();
    const token = String(c.req.valid("query").token || "").trim();
    const items =
      flowId && verifyFlowLidarrFeedToken(flowId, token) ? buildFlowLidarrImportList(flowId) : null;
    if (!items) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "public, max-age=300");
    return c.json(items, 200);
  });
