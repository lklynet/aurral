import express from "express";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { hashPassword } from "../middleware/passwordHash.ts";
import { defaultData } from "../config/constants.ts";
import { requirePasswordStrength, reconcileLocalNetworkBypassSetting } from "../middleware/auth.ts";
import { validateDownloadFolderPath } from "../services/downloadFolderConfig.ts";
import { logger } from "../services/logger.ts";
import { stripTrailingSlashes } from "../services/textUtils.ts";
import { testNavidromeConnection } from "./shared/navidromeTest.ts";
import {
  testLidarrConnection as lidarrTest,
  fetchQualityProfiles,
  fetchMetadataProfiles,
} from "../services/lidarrSettingsService.ts";
import { asAppError } from "../../lib/errors.ts";

const router = express.Router();

router.use((req, res, next) => {
  const settings = dbOps.getSettings();
  if (settings.onboardingComplete) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Onboarding has already been completed",
    });
  }
  next();
});

router.post("/lidarr/profiles", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const profiles = await fetchQualityProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    const failure = asAppError(error);
    res.status(failure?.statusCode || 400).json({
      error: "Failed to fetch Lidarr quality profiles",
      message: failure?.message,
    });
  }
});

router.post("/lidarr/metadata-profiles", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const profiles = await fetchMetadataProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    const failure = asAppError(error);
    res.status(failure?.statusCode || 400).json({
      error: "Failed to fetch Lidarr metadata profiles",
      message: failure?.message,
    });
  }
});

router.post("/lidarr/test", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const result = await lidarrTest({ url, apiKey });
    if (result.connected) {
      res.json({ success: true, message: "Connection successful" });
    } else {
      res.status(400).json({ error: result.error || "Connection failed" });
    }
  } catch (error) {
    const failure = asAppError(error);
    res.status(failure?.statusCode || 400).json({
      error: "Connection failed",
      message: failure?.message,
    });
  }
});

router.post("/navidrome/test", testNavidromeConnection);

type LidarrProfilesInput = {
  url?: unknown;
  apiKey?: unknown;
  qualityProfileId?: string | number | null;
  metadataProfileId?: string | number | null;
};

async function resolveLidarrProfiles(lidarr: LidarrProfilesInput) {
  let qualityProfileId =
    lidarr.qualityProfileId != null ? parseInt(String(lidarr.qualityProfileId), 10) || null : null;
  let metadataProfileId =
    lidarr.metadataProfileId != null
      ? parseInt(String(lidarr.metadataProfileId), 10) || null
      : null;
  if (qualityProfileId && metadataProfileId) {
    return { qualityProfileId, metadataProfileId };
  }
  const url = stripTrailingSlashes(String(lidarr.url || "").trim());
  const apiKey = String(lidarr.apiKey || "").trim();
  if (!url || !apiKey) return { qualityProfileId, metadataProfileId };
  try {
    const [qualityProfiles, metadataProfiles] = await Promise.all([
      qualityProfileId ? null : fetchQualityProfiles({ url, apiKey }),
      metadataProfileId ? null : fetchMetadataProfiles({ url, apiKey }),
    ]);
    if (!qualityProfileId && Array.isArray(qualityProfiles) && qualityProfiles[0]?.id != null) {
      qualityProfileId = parseInt(String(qualityProfiles[0].id), 10) || null;
    }
    if (!metadataProfileId && Array.isArray(metadataProfiles) && metadataProfiles[0]?.id != null) {
      metadataProfileId = parseInt(String(metadataProfiles[0].id), 10) || null;
    }
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("onboarding", "Could not auto-pick Lidarr profiles:", {
      message: failure?.message,
    });
  }
  return { qualityProfileId, metadataProfileId };
}

router.post("/complete", async (req, res) => {
  try {
    const { authUser, authPassword, lidarr, security, downloadFolderPath } = req.body;
    if (authPassword != null && String(authPassword).length > 0) {
      const passwordValidation = requirePasswordStrength(authPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
    }

    const connectLidarr = lidarr != null;
    if (connectLidarr && (!lidarr.url || !lidarr.apiKey)) {
      return res.status(400).json({
        error: "Lidarr connection is incomplete",
        message: "Enter both the Lidarr URL and API key, or skip Lidarr for now.",
      });
    }

    const current = dbOps.getSettings();
    const integrations = {
      ...(current.integrations || defaultData.settings.integrations || {}),
      general: {
        ...(current.integrations?.general || {}),
        authUser:
          authUser != null
            ? String(authUser).trim()
            : current.integrations?.general?.authUser || "admin",
        authPassword:
          authPassword != null
            ? String(authPassword)
            : current.integrations?.general?.authPassword || "",
      },
    };

    if (connectLidarr) {
      const profiles = await resolveLidarrProfiles(lidarr);
      integrations.lidarr = {
        ...(current.integrations?.lidarr || {}),
        ...lidarr,
        url: stripTrailingSlashes(String(lidarr.url).trim()),
        apiKey: String(lidarr.apiKey).trim(),
        qualityProfileId: profiles.qualityProfileId,
        metadataProfileId: profiles.metadataProfileId,
        defaultMonitorOption:
          lidarr.defaultMonitorOption != null
            ? String(lidarr.defaultMonitorOption)
            : current.integrations?.lidarr?.defaultMonitorOption || "none",
        searchOnAdd: lidarr.searchOnAdd === true,
      };
    }

    const nextSettings = {
      ...current,
      integrations,
      onboardingComplete: true,
      security: {
        ...(current.security || defaultData.settings.security || {}),
        localNetworkBypass: {
          enabled: security?.localNetworkBypass?.enabled === true,
        },
      },
    };

    if (downloadFolderPath !== undefined && String(downloadFolderPath).trim()) {
      const validation = validateDownloadFolderPath(downloadFolderPath, undefined, {
        create: true,
      });
      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error,
          message: validation.error,
        });
      }
      nextSettings.downloadFolderPath = validation.path;
    }

    dbOps.updateSettings(nextSettings);

    const authUserFinal = integrations?.general?.authUser || "admin";
    const authPasswordFinal = integrations?.general?.authPassword || "";
    if (authPasswordFinal && userOps.getAllUsers().length === 0) {
      const hash = hashPassword(authPasswordFinal);
      userOps.createUser(authUserFinal, hash, "admin", null, true, true, authPasswordFinal);
    }

    reconcileLocalNetworkBypassSetting();

    if (integrations?.lidarr?.apiKey) {
      const { enqueueDiscoveryRefresh } = await import("../services/discovery/refreshScheduler.ts");
      enqueueDiscoveryRefresh({ reason: "onboarding" });
    }

    res.json({ success: true });
  } catch (error) {
    const failure = asAppError(error);
    logger.error("onboarding", "Complete error:", { message: failure?.message });
    res.status(500).json({
      error: "Failed to save onboarding",
      message: failure?.message,
    });
  }
});

export type OnboardingCompleteResponse = { success: true };

export type LidarrTestResponse = { success: true; message: string };

export default router;
