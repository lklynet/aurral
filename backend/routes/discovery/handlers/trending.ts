import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  getTrendingCharts,
  getTrendingGenreChart,
} from "../../../services/discovery/trendingCharts.ts";

const genreParams = v.object({ genreId: v.pipe(v.string(), v.regex(/^\d{1,6}$/)) });

export default new Hono<AppEnv>()
  .get("/trending", requireAuth, (c) => c.json(getTrendingCharts(c.var.user.id), 200))
  .get("/trending/genres/:genreId", requireAuth, validate("param", genreParams), (c) => {
    const chart = getTrendingGenreChart(Number(c.req.valid("param").genreId));
    if (!chart) return c.json({ error: "This genre chart isn't available yet" }, 404);
    return c.json(chart, 200);
  });
