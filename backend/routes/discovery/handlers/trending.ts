import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  getTrendingCharts,
  getTrendingGenreChart,
  setTrendingRegion,
} from "../../../services/discovery/trendingCharts.ts";
import { TRENDING_REGION_CHOICES } from "../../../../lib/trendingRegions.ts";

const genreParams = v.object({ genreId: v.pipe(v.string(), v.regex(/^\d{1,6}$/)) });
const regionInput = v.object({ region: v.picklist(TRENDING_REGION_CHOICES) });

export default new Hono<AppEnv>()
  .get("/trending", requireAuth, (c) => c.json(getTrendingCharts(c.var.user.id), 200))
  .put("/trending/region", requireAuth, requireAdmin, validate("json", regionInput), async (c) => {
    try {
      await setTrendingRegion(c.req.valid("json").region);
    } catch {
      return c.json(
        { error: "Saved, but the charts couldn't load. Aurral tries again on its next refresh." },
        502,
      );
    }
    return c.json(getTrendingCharts(c.var.user.id), 200);
  })
  .get("/trending/genres/:genreId", requireAuth, validate("param", genreParams), (c) => {
    const chart = getTrendingGenreChart(Number(c.req.valid("param").genreId));
    if (!chart) return c.json({ error: "This genre chart isn't available yet" }, 404);
    return c.json(chart, 200);
  });
