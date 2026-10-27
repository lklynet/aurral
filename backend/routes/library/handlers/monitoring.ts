import { Hono, type Context } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { removeMonitoringExclusion } from "../../../services/aurralMonitoringStore.ts";
import { libraryManager } from "../../../services/libraryManager.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";

type MonitoringFailure = { error: string; statusCode?: number };

const sendFailure = <E extends AppEnv>(
  c: Context<E>,
  { error, statusCode, ...details }: MonitoringFailure,
) => c.json({ ...details, error, message: error }, isErrorStatus(statusCode) ? statusCode : 500);

const sendError = <E extends AppEnv>(c: Context<E>, error: unknown, message: string) =>
  c.json({ error: message, message: asAppError(error)?.message || message }, 500);

const previewInput = v.object({
  monitoring: v.optional(
    v.nullable(
      v.object({
        monitored: v.optional(v.boolean()),
        useDefault: v.optional(v.boolean()),
        rules: v.optional(v.unknown()),
      }),
    ),
  ),
  artistName: v.optional(v.nullable(v.string())),
});

const rulesInput = v.object({ rules: v.optional(v.unknown()) });

const exclusionsQuery = v.object({ artistMbid: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/library")
  .post(
    "/artists/:mbid/monitoring/preview",
    requireAuth,
    requirePermission("changeMonitoring"),
    validate("json", previewInput),
    async (c) => {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      try {
        const result = await libraryManager.previewAurralArtistMonitoring(
          mbid,
          c.req.valid("json"),
        );
        if (isFailure(result)) return sendFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return sendError(c, error, "Failed to preview artist monitoring");
      }
    },
  )
  .get("/monitoring/defaults", requireAuth, noCache, (c) => {
    try {
      return c.json(libraryManager.getMonitoringDefaultsState(), 200);
    } catch (error) {
      return sendError(c, error, "Failed to read monitoring defaults");
    }
  })
  .post(
    "/monitoring/defaults/preview",
    requireAuth,
    requireAdmin,
    validate("json", rulesInput),
    async (c) => {
      try {
        const result = await libraryManager.previewMonitoringDefaults(c.req.valid("json").rules);
        if (isFailure(result)) return sendFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return sendError(c, error, "Failed to preview monitoring defaults");
      }
    },
  )
  .put("/monitoring/defaults", requireAuth, requireAdmin, validate("json", rulesInput), (c) => {
    try {
      const result = libraryManager.setMonitoringDefaults(c.req.valid("json").rules);
      if (isFailure(result)) return sendFailure(c, result);
      return c.json(result, 200);
    } catch (error) {
      return sendError(c, error, "Failed to save monitoring defaults");
    }
  })
  .get("/monitoring/exclusions", requireAuth, noCache, validate("query", exclusionsQuery), (c) => {
    const artistMbid = String(c.req.valid("query").artistMbid || "").trim();
    if (artistMbid && !UUID_REGEX.test(artistMbid)) {
      return c.json({ error: "Invalid MBID format" }, 400);
    }
    try {
      return c.json(
        libraryManager.listMonitoringExclusions({ artistMbid: artistMbid || null }),
        200,
      );
    } catch (error) {
      return sendError(c, error, "Failed to read monitoring exclusions");
    }
  })
  .delete("/monitoring/exclusions/:id", requireAuth, requirePermission("changeMonitoring"), (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) {
      return c.json({ error: "id must be a positive integer" }, 400);
    }
    try {
      if (!removeMonitoringExclusion(id)) return c.json({ error: "Exclusion not found" }, 404);
      return c.json({ success: true }, 200);
    } catch (error) {
      return sendError(c, error, "Failed to remove the exclusion");
    }
  });
