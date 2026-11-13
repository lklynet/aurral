import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  DISCOVERY_MODES,
  getDiscoveryMode,
  setDiscoveryMode,
} from "../../../services/discovery/index.ts";
import { asAppError } from "../../../../lib/errors.ts";

const preferencesInput = v.object({
  discoveryMode: v.nullish(v.string()),
});

export default new Hono<AppEnv>()
  .get("/preferences", requireAuth, (c) =>
    c.json({ discoveryMode: getDiscoveryMode(c.var.user.id) }, 200),
  )
  .post("/preferences", requireAuth, validate("json", preferencesInput), (c) => {
    try {
      const updates = c.req.valid("json");
      const userId = c.var.user.id;
      if (updates.discoveryMode != null) {
        setDiscoveryMode(
          userId,
          DISCOVERY_MODES.find((mode) => mode === updates.discoveryMode) ?? "balanced",
        );
      }
      return c.json(
        { success: true, preferences: { discoveryMode: getDiscoveryMode(userId) } },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to update preferences", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/preferences/reset", requireAuth, (c) => {
    setDiscoveryMode(c.var.user.id, "balanced");
    return c.json({ success: true, preferences: { discoveryMode: "balanced" } }, 200);
  });
