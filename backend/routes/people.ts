import { Hono } from "hono";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { listPeople, personProfile } from "../services/localPeople.ts";

export default new Hono<AppEnv>()
  .basePath("/people")
  .use(requireAuth, requireUserAccount)
  .get("/", (c) => c.json(listPeople(c.var.user.id)))
  .get("/:username", async (c) => {
    const person = await personProfile(c.var.user, c.req.param("username"));
    return person ? c.json(person, 200) : c.json({ error: "Person not found" }, 404);
  });
