import { Hono } from "hono";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { forgetHubLink, HubLinkError, hubLinkStatus, startHubLink } from "../services/hubLink.ts";

export default new Hono<AppEnv>()
  .basePath("/hub-link")
  .use(requireAuth, requireUserAccount)
  .get("/", async (c) => c.json(await hubLinkStatus(c.var.user.id)))
  .post("/", async (c) => {
    try {
      return c.json(await startHubLink(c.var.user));
    } catch (error) {
      if (error instanceof HubLinkError) return c.json({ error: error.message }, 502);
      throw error;
    }
  })
  .delete("/", async (c) => {
    forgetHubLink(c.var.user.id);
    return c.json(await hubLinkStatus(c.var.user.id));
  });
