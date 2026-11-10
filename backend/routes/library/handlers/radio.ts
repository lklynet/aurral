import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { buildRadio } from "../../../services/radio.ts";
import { toQueueTracks } from "../../../services/queueTracks.ts";

const refs = v.optional(v.pipe(v.array(v.string()), v.maxLength(500)));

const radioInput = v.object({
  trackIds: refs,
  albumIds: refs,
  artists: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.nullish(v.string()),
          mbid: v.nullish(v.string()),
          name: v.nullish(v.string()),
        }),
      ),
      v.maxLength(50),
    ),
  ),
  exclude: v.optional(v.pipe(v.array(v.string()), v.maxLength(2000))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .post("/radio", requireAuth, noCache, validate("json", radioInput), async (c) => {
    const { exclude, limit, ...seed } = c.req.valid("json");
    const userId = c.var.user.id > 0 ? c.var.user.id : null;
    const trackIds = await buildRadio({ userId, seed, exclude, limit });
    return c.json({ tracks: toQueueTracks(trackIds) }, 200);
  });
