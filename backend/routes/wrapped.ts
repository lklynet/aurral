import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import type { WrappedSeason } from "../../lib/wrapped.ts";
import { requireAuth, requirePermission, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import {
  currentWrappedSeason,
  getWrapped,
  hideWrappedBanner,
  rebuildWrapped,
  saveWrappedPlaylist,
} from "../services/wrapped/reports.ts";

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const timeZone = v.pipe(v.string(), v.maxLength(100), v.check(isTimeZone, "Unknown timezone"));

const requireSeason = createMiddleware<{ Variables: { season: WrappedSeason } }>(
  async (c, next) => {
    const season = currentWrappedSeason();
    if (!season) return c.notFound();
    c.set("season", season);
    await next();
  },
);

export default new Hono<AppEnv>()
  .basePath("/wrapped")
  .use(requireSeason, requireAuth, requireUserAccount)
  .get("/", validate("query", v.object({ timeZone })), (c) =>
    c.json(getWrapped(c.var.season, c.var.user.id, c.req.valid("query").timeZone), 200),
  )
  .post("/", validate("json", v.object({ timeZone })), (c) =>
    c.json(rebuildWrapped(c.var.season, c.var.user.id, c.req.valid("json").timeZone), 202),
  )
  .put("/banner", validate("json", v.object({ timeZone, hidden: v.boolean() })), (c) => {
    const { timeZone, hidden } = c.req.valid("json");
    return c.json(hideWrappedBanner(c.var.season, c.var.user.id, timeZone, hidden), 200);
  })
  .post(
    "/playlist",
    requirePermission("accessFlow"),
    validate("json", v.object({ timeZone })),
    async (c) => {
      const result = await saveWrappedPlaylist(
        c.var.season,
        c.var.user,
        c.req.valid("json").timeZone,
      );
      return "error" in result ? c.json(result, 409) : c.json(result, 201);
    },
  );
