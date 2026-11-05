import { create as contentDisposition } from "content-disposition";
import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { LOG_LEVELS, recordLog } from "../services/logger.ts";
import {
  exportLogs,
  getFreshSince,
  isDebugLoggingOn,
  listLogProblems,
  queryLogs,
  setDebugLogging,
  setFreshSince,
} from "../services/logs.ts";

const HOUR_MS = 60 * 60 * 1000;
const text = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)));
const whole = (max: number) =>
  v.pipe(
    v.string(),
    v.regex(/^\d+$/),
    v.transform(Number),
    v.check((value) => Number.isSafeInteger(value) && value <= max),
  );
const positive = (max: number) =>
  v.pipe(
    whole(max),
    v.check((value) => value > 0),
  );
const hours = v.optional(positive(24 * 30), "24");
const level = v.optional(v.picklist(LOG_LEVELS));

const listQuery = v.object({
  level,
  cat: text,
  q: text,
  fp: text,
  req: text,
  job: text,
  before: v.optional(whole(Number.MAX_SAFE_INTEGER)),
  after: v.optional(whole(Number.MAX_SAFE_INTEGER)),
  hours: v.optional(positive(24 * 30)),
  limit: v.optional(positive(1000), "200"),
});

const clientError = v.object({
  source: v.picklist(["error", "rejection", "react"]),
  name: v.optional(v.pipe(v.string(), v.maxLength(200))),
  message: v.pipe(v.string(), v.maxLength(2000)),
  stack: v.optional(v.pipe(v.string(), v.maxLength(8000))),
  page: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

const since = (value: number) => Date.now() - value * HOUR_MS;
const freshSince = (start = 0) => {
  const value = getFreshSince();
  return value === null || value <= start ? null : new Date(value).toISOString();
};

export default new Hono<AppEnv>()
  .basePath("/logs")
  .use(requireAuth)
  .post(
    "/client",
    rateLimit({ windowMs: 60_000, limit: 30 }),
    validate("json", clientError),
    (c) => {
      const report = c.req.valid("json");
      const error = Object.assign(new Error(report.message), {
        name: report.name || "Error",
        stack: report.stack,
      });
      recordLog(
        "error",
        "browser",
        report.message || "Unknown error",
        {
          source: report.source,
          page: report.page,
          user: c.var.user.username,
        },
        { error },
      );
      return c.body(null, 204);
    },
  )
  .use(requireAdmin)
  .get("/", noCache, validate("query", listQuery), async (c) => {
    const { hours: window, ...query } = c.req.valid("query");
    const entries = await queryLogs({
      ...query,
      ...(window ? { since: since(window) } : {}),
    });
    return c.json({ entries, debug: isDebugLoggingOn() }, 200);
  })
  .get("/problems", noCache, validate("query", v.object({ hours })), async (c) => {
    const start = since(c.req.valid("query").hours);
    return c.json(
      {
        problems: await listLogProblems(start),
        since: new Date(start).toISOString(),
        freshSince: freshSince(start),
        debug: isDebugLoggingOn(),
      },
      200,
    );
  })
  .get(
    "/export",
    noCache,
    validate("query", v.object({ hours, level: v.optional(v.picklist(LOG_LEVELS), "info") })),
    async (c) => {
      const query = c.req.valid("query");
      const body = await exportLogs({ since: since(query.hours), level: query.level });
      c.header("Content-Type", "text/plain; charset=utf-8");
      c.header(
        "Content-Disposition",
        contentDisposition(`aurral-logs-${new Date().toISOString().slice(0, 10)}.txt`),
      );
      return c.body(body, 200);
    },
  )
  .post("/fresh", (c) => {
    setFreshSince(Date.now());
    return c.json({ freshSince: freshSince() }, 200);
  })
  .delete("/fresh", (c) => {
    setFreshSince(null);
    return c.json({ freshSince: freshSince() }, 200);
  })
  .put("/debug", validate("json", v.object({ enabled: v.boolean() })), (c) => {
    setDebugLogging(c.req.valid("json").enabled);
    return c.json({ debug: isDebugLoggingOn() }, 200);
  });
