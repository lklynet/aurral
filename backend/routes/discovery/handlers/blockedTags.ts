import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { blockTag, getBlockedTags, unblockTag } from "../../../services/discovery/blockedTags.ts";
import { isKnownGenre } from "../../../services/musicGenres.ts";

const tagInput = v.object({
  tag: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
});

export default new Hono<AppEnv>()
  .get("/blocked-tags", requireAuth, (c) => c.json({ tags: getBlockedTags(c.var.user.id) }, 200))
  .post("/blocked-tags", requireAuth, validate("json", tagInput), (c) => {
    const { tag } = c.req.valid("json");
    if (!isKnownGenre(tag)) {
      return c.json(
        { error: "Not a genre", message: `Only genres can be blocked, and "${tag}" isn't one.` },
        400,
      );
    }
    return c.json({ tags: blockTag(c.var.user.id, tag) }, 200);
  })
  .delete("/blocked-tags", requireAuth, validate("query", tagInput), (c) =>
    c.json({ tags: unblockTag(c.var.user.id, c.req.valid("query").tag) }, 200),
  );
