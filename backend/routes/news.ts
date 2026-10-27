import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { disableNewsFeed, getNewsForUser } from "../services/newsService.ts";
import { errorStatus } from "./shared/errorStatus.ts";
import { asAppError } from "../../lib/errors.ts";

const newsQuery = v.object({
  mode: v.optional(v.string()),
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/news")
  .post(
    "/feeds/disable",
    requireAuth,
    requireAdmin,
    validate("json", v.object({ sourceUrl: v.nullish(v.string()) })),
    (c) => {
      const sourceUrl = c.req.valid("json").sourceUrl?.trim();
      if (!sourceUrl) return c.json({ error: "sourceUrl is required" }, 400);
      return c.json(disableNewsFeed(sourceUrl), 200);
    },
  )
  .get("/", requireAuth, validate("query", newsQuery), async (c) => {
    const { mode, limit, offset } = c.req.valid("query");
    try {
      const result = await getNewsForUser({
        userId: c.var.user.id,
        mode: mode === "top" ? "top" : "matched",
        limit,
        offset,
      });
      c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
      return c.json(result, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Failed to load artist news", message: failure?.message },
        errorStatus(failure),
      );
    }
  });
