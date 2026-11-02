import { Hono } from "hono";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { claimStarPrompt } from "../services/starPrompt.ts";

export default new Hono<AppEnv>()
  .basePath("/star-prompt")
  .use(requireAuth, requireUserAccount)
  .post("/", (c) => c.json({ show: claimStarPrompt(c.var.user.id) }, 200));
