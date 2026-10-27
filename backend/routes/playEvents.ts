import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { getPlayHistory, recordPlayEvent } from "../services/playEventService.ts";
import { asAppError } from "../../lib/errors.ts";

const value = v.nullish(v.union([v.string(), v.number()]));

const historyQuery = v.object({ limit: v.optional(v.string()), offset: v.optional(v.string()) });

const playEventInput = v.object({
  trackId: value,
  title: value,
  artist: value,
  album: value,
  albumKey: value,
  albumId: value,
  albumMbid: value,
  artistMbid: value,
  trackMbid: value,
  durationMs: value,
  playedAt: value,
  source: value,
});

export default new Hono<AppEnv>()
  .basePath("/play-events")
  .use(requireAuth)
  .get("/", validate("query", historyQuery), (c) =>
    c.json({ events: getPlayHistory(c.var.user.id, c.req.valid("query")) }, 200),
  )
  .post("/", requireUserAccount, validate("json", playEventInput), (c) => {
    try {
      return c.json({ event: recordPlayEvent(c.var.user.id, c.req.valid("json")) }, 201);
    } catch (error) {
      return c.json({ error: asAppError(error)?.message || "Could not record play event" }, 400);
    }
  });
