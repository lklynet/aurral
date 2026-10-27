import { Hono, type Context } from "hono";
import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { noCache } from "../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { appSettingsPatch, readAppSettings, saveAppSettings } from "../../services/appSettings.ts";
import { lidarrClient } from "../../services/lidarrClient.ts";
import {
  applyCommunityGuide,
  fetchMetadataProfiles,
  fetchQualityProfiles,
  fetchRootFolders,
  fetchTags,
  testLidarrConnection,
  testLidarrLibraryAccess,
} from "../../services/lidarrSettingsService.ts";
import { resolveLidarrTestCredentials } from "../../services/lidarrTestSession.ts";
import { logger } from "../../services/logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { errorStatus } from "../shared/errorStatus.ts";
import { navidromeConnectionError, navidromeTestBody } from "../shared/navidromeTest.ts";

const lidarrCredentials = v.object({
  url: v.optional(v.string()),
  apiKey: v.optional(v.string()),
});

const lidarrLookupFailure = <E extends AppEnv>(
  c: Context<E>,
  error: unknown,
  logMessage: string,
  message: string,
) => {
  const failure = asAppError(error);
  logger.error("settings", logMessage, error ?? undefined);
  return c.json(
    { error: message, message: failure?.message, details: failure?.response?.data },
    errorStatus(failure),
  );
};

export default new Hono<AppEnv>()
  .basePath("/settings")
  .get("/", requireAuth, requireAdmin, noCache, (c) => {
    try {
      return c.json(readAppSettings(), 200);
    } catch (error) {
      logger.error("settings", "Settings GET error:", error ?? undefined);
      return c.json(
        { error: "Failed to fetch settings", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/", requireAuth, requireAdmin, validate("json", appSettingsPatch), async (c) => {
    try {
      const result = await saveAppSettings(c.req.valid("json"), c.var.user.id);
      if ("error" in result) return c.json({ error: result.error }, 400);
      return c.json(result.settings, 200);
    } catch (error) {
      logger.error("settings", "Settings POST error:", error ?? undefined);
      return c.json({ error: "Failed to save settings", message: asAppError(error)?.message }, 500);
    }
  })
  .post(
    "/navidrome/test",
    requireAuth,
    requireAdmin,
    validate("json", navidromeTestBody),
    async (c) => {
      const failure = await navidromeConnectionError(c.req.valid("json"));
      if (failure) return c.json(failure, 400);
      return c.json({ success: true, message: "Connection successful" }, 200);
    },
  )
  .get(
    "/lidarr/profiles",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const credentials = resolveLidarrTestCredentials(c.req.valid("query"), lidarrClient);
        return c.json(await fetchQualityProfiles(credentials), 200);
      } catch (error) {
        return lidarrLookupFailure(
          c,
          error,
          "Failed to fetch Lidarr profiles:",
          "Failed to fetch Lidarr quality profiles",
        );
      }
    },
  )
  .get(
    "/lidarr/metadata-profiles",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const credentials = resolveLidarrTestCredentials(c.req.valid("query"), lidarrClient);
        return c.json(await fetchMetadataProfiles(credentials), 200);
      } catch (error) {
        return lidarrLookupFailure(
          c,
          error,
          "Failed to fetch Lidarr metadata profiles:",
          "Failed to fetch Lidarr metadata profiles",
        );
      }
    },
  )
  .get(
    "/lidarr/root-folders",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const credentials = resolveLidarrTestCredentials(c.req.valid("query"), lidarrClient);
        return c.json(await fetchRootFolders(credentials), 200);
      } catch (error) {
        return lidarrLookupFailure(
          c,
          error,
          "Failed to fetch Lidarr root folders:",
          "Failed to fetch Lidarr root folders",
        );
      }
    },
  )
  .get(
    "/lidarr/tags",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const credentials = resolveLidarrTestCredentials(c.req.valid("query"), lidarrClient);
        return c.json(await fetchTags(credentials), 200);
      } catch (error) {
        return lidarrLookupFailure(
          c,
          error,
          "Failed to fetch Lidarr tags:",
          "Failed to fetch Lidarr tags",
        );
      }
    },
  )
  .get(
    "/lidarr/test-library-access",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const credentials = resolveLidarrTestCredentials(c.req.valid("query"), lidarrClient);
        const result = await testLidarrLibraryAccess(credentials);
        return c.json(
          {
            success: result.ok,
            ok: result.ok,
            partial: !!result.partial,
            steps: result.steps,
            sample: result.sample,
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.error("settings", "Lidarr library access test error:", error ?? undefined);
        return c.json(
          { error: "Library access check failed", message: failure?.message },
          errorStatus(failure),
        );
      }
    },
  )
  .get(
    "/lidarr/test",
    requireAuth,
    requireAdmin,
    validate("query", lidarrCredentials),
    async (c) => {
      try {
        const { url, apiKey, usingProvided } = resolveLidarrTestCredentials(
          c.req.valid("query"),
          lidarrClient,
        );
        logger.info("settings", "Testing Lidarr connection...", {
          url,
          hasApiKey: !!apiKey,
          apiKeyLength: apiKey?.length || 0,
          usingProvided,
        });
        const result = await testLidarrConnection({ url, apiKey });
        if (!result.connected) {
          return c.json(
            {
              error: "Connection failed",
              message: result.error,
              details: result.details,
              url: result.url,
              fullUrl: result.fullUrl,
              statusCode: result.statusCode,
              apiPath: result.apiPath,
            },
            400,
          );
        }
        return c.json(
          {
            success: true,
            message: "Connection successful",
            version: result.version,
            instanceName: result.instanceName,
            apiPath: result.apiPath,
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.error("settings", "Lidarr test error:", error ?? undefined);
        return c.json(
          {
            error: "Connection failed",
            message: failure?.message,
            stack: process.env.NODE_ENV === "development" ? failure?.stack : undefined,
          },
          errorStatus(failure),
        );
      }
    },
  )
  .post("/lidarr/apply-community-guide", requireAuth, requireAdmin, async (c) => {
    try {
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      if (!config.url || !config.apiKey) {
        return c.json(
          {
            error: "Lidarr not configured",
            message: "Please configure Lidarr URL and API key in settings first",
          },
          400,
        );
      }
      try {
        const results = await applyCommunityGuide({ url: config.url, apiKey: config.apiKey });
        const currentSettings = dbOps.getSettings();
        dbOps.updateSettings({
          ...currentSettings,
          integrations: {
            ...currentSettings.integrations,
            lidarr: {
              ...(currentSettings.integrations?.lidarr || {}),
              qualityProfileId: results.qualityProfile?.id || null,
              metadataProfileId: results.metadataProfile?.id || null,
            },
          },
        });
        return c.json(
          { success: true, message: "Community guide settings applied successfully", results },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.error("settings", "Failed to apply community guide:", error ?? undefined);
        return c.json(
          {
            error: "Failed to apply community guide settings",
            message: failure?.message,
            details: failure?.response?.data,
          },
          500,
        );
      }
    } catch (error) {
      logger.error("settings", "Error applying community guide:", error ?? undefined);
      return c.json(
        { error: "Failed to apply community guide settings", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/tasks", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { getHonkerTaskStatus } = await import("../../services/honkerTaskStatus.ts");
      return c.json(await getHonkerTaskStatus(), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to get task status", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/tasks/clear-stale", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { clearStaleHonkerJobs, getHonkerTaskStatus } =
        await import("../../services/honkerTaskStatus.ts");
      const result = await clearStaleHonkerJobs();
      return c.json({ ...result, tasks: await getHonkerTaskStatus() }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to clear stuck jobs", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/storage-health", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { getStorageHealthSnapshot } = await import("../../services/storageHealthService.ts");
      const result = getStorageHealthSnapshot() || {
        ok: null,
        partial: false,
        checkedAt: null,
        sections: [],
        unavailable: true,
      };
      return c.json({ success: result.ok === true, ...result }, 200);
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      return c.json(
        { error: "Storage health check failed", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/storage-health/check", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      const { runStorageHealthCheck } = await import("../../services/storageHealthService.ts");
      const result = await runStorageHealthCheck({ force: true });
      return c.json({ success: result.ok, ...result }, 200);
    } catch (error) {
      logger.error("settings", "Storage health check error:", error ?? undefined);
      return c.json(
        { error: "Storage health check failed", message: asAppError(error)?.message },
        500,
      );
    }
  });
