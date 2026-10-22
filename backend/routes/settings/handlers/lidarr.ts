import type { Router } from "express";
import { logger } from "../../../services/logger.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import {
  fetchQualityProfiles,
  fetchMetadataProfiles,
  fetchTags,
  testLidarrConnection,
  testLidarrLibraryAccess as testLibraryAccess,
  applyCommunityGuide,
} from "../../../services/lidarrSettingsService.ts";
import { asAppError } from "../../../../lib/errors.ts";

export type LidarrConnectionTestResponse = {
  success: true;
  message: string;
  version: string;
  instanceName: string;
  apiPath: string;
};

export function registerLidarr(router: Router) {
  router.get("/lidarr/profiles", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
      const profiles = await fetchQualityProfiles({ url, apiKey });
      res.json(profiles);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Failed to fetch Lidarr profiles:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Failed to fetch Lidarr quality profiles",
        message: failure?.message,
        details: failure?.response?.data,
      });
    }
  });

  router.get("/lidarr/metadata-profiles", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
      const profiles = await fetchMetadataProfiles({ url, apiKey });
      res.json(profiles);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Failed to fetch Lidarr metadata profiles:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Failed to fetch Lidarr metadata profiles",
        message: failure?.message,
        details: failure?.response?.data,
      });
    }
  });

  router.get("/lidarr/root-folders", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
      const { fetchRootFolders } = await import("../../../services/lidarrSettingsService.ts");
      const rootFolders = await fetchRootFolders({ url, apiKey });
      res.json(rootFolders);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Failed to fetch Lidarr root folders:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Failed to fetch Lidarr root folders",
        message: failure?.message,
        details: failure?.response?.data,
      });
    }
  });

  router.get("/lidarr/tags", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
      const tags = await fetchTags({ url, apiKey });
      res.json(tags);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Failed to fetch Lidarr tags:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Failed to fetch Lidarr tags",
        message: failure?.message,
        details: failure?.response?.data,
      });
    }
  });

  router.get("/lidarr/test-library-access", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
      const result = await testLibraryAccess({ url, apiKey });
      res.json({
        success: result.ok,
        ok: result.ok,
        partial: !!result.partial,
        steps: result.steps,
        sample: result.sample,
      });
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Lidarr library access test error:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Library access check failed",
        message: failure?.message,
      });
    }
  });

  router.get("/lidarr/test", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const { resolveLidarrTestCredentials } =
        await import("../../../services/lidarrTestSession.ts");
      const { url, apiKey, usingProvided } = resolveLidarrTestCredentials(req.query, lidarrClient);
      logger.info("settings", "Testing Lidarr connection...", {
        url,
        hasApiKey: !!apiKey,
        apiKeyLength: apiKey?.length || 0,
        usingProvided,
      });
      const result = await testLidarrConnection({ url, apiKey });
      if (result.connected) {
        res.json({
          success: true,
          message: "Connection successful",
          version: result.version,
          instanceName: result.instanceName,
          apiPath: result.apiPath,
        });
      } else {
        res.status(400).json({
          error: "Connection failed",
          message: result.error,
          details: result.details,
          url: result.url,
          fullUrl: result.fullUrl,
          statusCode: result.statusCode,
          apiPath: result.apiPath,
        });
      }
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Lidarr test error:", error ?? undefined);
      res.status(failure?.statusCode || 500).json({
        error: "Connection failed",
        message: failure?.message,
        stack: process.env.NODE_ENV === "development" ? failure?.stack : undefined,
      });
    }
  });

  router.post("/lidarr/apply-community-guide", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      if (!config.url || !config.apiKey) {
        return res.status(400).json({
          error: "Lidarr not configured",
          message: "Please configure Lidarr URL and API key in settings first",
        });
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
        res.json({
          success: true,
          message: "Community guide settings applied successfully",
          results,
        });
      } catch (error) {
        const failure = asAppError(error);
        logger.error("settings", "Failed to apply community guide:", error ?? undefined);
        res.status(500).json({
          error: "Failed to apply community guide settings",
          message: failure?.message,
          details: failure?.response?.data,
        });
      }
    } catch (error) {
      logger.error("settings", "Error applying community guide:", error ?? undefined);
      res.status(500).json({
        error: "Failed to apply community guide settings",
        message: asAppError(error)?.message,
      });
    }
  });
}
