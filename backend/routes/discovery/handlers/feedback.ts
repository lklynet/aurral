import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  getDiscoveryFeedback,
  addDiscoveryFeedback,
  removeDiscoveryFeedback,
  restoreDiscoveryFeedback,
  resetDiscoveryFeedback,
} from "../../../services/discovery/index.ts";
import { asAppError } from "../../../../lib/errors.ts";

const text = v.nullish(v.string());
const textList = v.nullish(v.array(v.string()));
const timestamp = v.nullish(v.union([v.string(), v.number()]));

const feedbackInput = v.object({
  id: text,
  action: text,
  artistId: v.nullish(v.union([v.string(), v.number()])),
  artistName: text,
  sourceContext: text,
  tagContext: textList,
  seedContext: textList,
});

const restoreInput = v.object({
  removeIds: v.optional(v.array(v.string()), []),
  entries: v.optional(
    v.array(v.object({ ...feedbackInput.entries, createdAt: timestamp, expiresAt: timestamp })),
    [],
  ),
});

export default new Hono<AppEnv>()
  .get("/feedback", requireAuth, (c) =>
    c.json({ feedback: getDiscoveryFeedback(c.var.user.id) }, 200),
  )
  .post("/feedback", requireAuth, validate("json", feedbackInput), (c) => {
    const userId = c.var.user.id;
    try {
      const feedback = addDiscoveryFeedback(userId, c.req.valid("json"));
      return c.json({ success: true, feedback, feedbackList: getDiscoveryFeedback(userId) }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to save discovery feedback", message: asAppError(error)?.message },
        400,
      );
    }
  })
  .delete("/feedback/:id", requireAuth, (c) =>
    c.json(
      {
        success: true,
        feedbackList: removeDiscoveryFeedback(c.var.user.id, c.req.param("id")),
      },
      200,
    ),
  )
  .post("/feedback/restore", requireAuth, validate("json", restoreInput), (c) => {
    const { removeIds, entries } = c.req.valid("json");
    if (removeIds.length + entries.length === 0) {
      return c.json(
        {
          error: "Failed to restore discovery feedback",
          message: "removeIds or entries is required",
        },
        400,
      );
    }
    return c.json(
      {
        success: true,
        feedbackList: restoreDiscoveryFeedback(c.var.user.id, { removeIds, entries }),
      },
      200,
    );
  })
  .post("/feedback/reset", requireAuth, (c) =>
    c.json({ success: true, feedbackList: resetDiscoveryFeedback(c.var.user.id) }, 200),
  );
